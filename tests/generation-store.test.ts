import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { EditorRepository,migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { migrateAsrSchema } from '../src/main/asr-store.js';
import { GenerationRepository,migrateGenerationSchema,type GenerationCallToken } from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { GenerationRunner } from '../src/main/generation-runner.js';
import { exportMarkdown } from '../src/main/editor-export.js';
import { sha256 } from '../src/main/editor-media.js';
import { png } from './e1-helpers.js';
import { generationSha256 } from '../src/main/generation-validation.js';
import { clone,pointSlice,type SourceReference } from '../src/editor-core/model.js';
import type { GeneratedMap,GenerationModelSelection,GenerationProviderResult,OrganizedDocument } from '../src/shared/generation-contracts.js';
const model:GenerationModelSelection={provider:'siliconflow',model:'mechanism-only-no-service',discoveredAt:1,accountModelsSha256:'a'.repeat(64),publishedContextTokens:65536,providerOutputLimitTokens:null,inputBudgetUtf8Bytes:32000,maxOutputTokens:16384,applicationContextBudgetTokens:65536,responseFormat:'json_object',promptVersion:'read-create-source-grounded-v1',configurationSha256:'b'.repeat(64),capabilitySources:['mechanism fixture, no HTTP']};
function fixture(human=false,body='原始正文包含25mg，只有满足条件才可使用。第二段不超过30天。'){const base=path.resolve('.acceptance-data/editor-e3');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'generation-unit-')),store=new Store(root);const item={sourceId:'mechanism-text',title:'合成来源，无真实模型调用',author:'test',url:'https://www.xiaohongshu.com/explore/mechanism',kind:'text' as const,folderIds:[]};store.saveSnapshot({platform:'xiaohongshu',accountId:'fixture',accountName:'合成机制',folders:[],complete:true,items:[item]},[{item,discovery:'historical'}],1);const id=store.find('xiaohongshu','fixture',item.sourceId)!;store.detailSaved(id,{body,bodyComplete:true,mediaManifestComplete:true,media:[]});migrateEditorSchema(store.db,root,{targetVersion:7});const editor=new EditorRepository(store.db,root);if(human){const open=editor.open(id,'source');if(!open.initialized)throw Error();editor.title(open.bundle.workspace.id,'已有人工作品');}migrateAsrSchema(store.db,root);const digest=new DigestRepository(store.db,root,editor);migrateGenerationSchema(store.db,root);migrateE44Schema(store.db,root);const generation=new GenerationRepository(store.db,root,editor,digest);generation.setCapability(true,true);return{root,store,id,editor,digest,generation,close(){store.close();rmSync(root,{recursive:true,force:true});}};}
type F=ReturnType<typeof fixture>;
function click(f:F){f.digest.request(f.id);return f.generation.authorize(f.id);}
function organized(token:GenerationCallToken):OrganizedDocument{return{schemaVersion:1,sourceRevisionId:token.input.sourceRevisionId,title:'整理后的正文',lead:'',blocks:token.chunk.slices.map((slice,index)=>{const unit=token.input.units.find(u=>u.id===slice.unitId)!,text=pointSlice(unit.text,slice.start,slice.end);return{id:`block-${index}`,type:'paragraph',text,role:'fact',citations:[{unitId:unit.id,start:slice.start,end:slice.end,excerpt:text}]};}),coverage:token.chunk.slices.map(slice=>({unitId:slice.unitId,start:slice.start,end:slice.end,disposition:'included'}))};}
function response(token:GenerationCallToken):GenerationProviderResult{let value:OrganizedDocument|GeneratedMap;if(token.stage==='organize')value=organized(token);else{const citations=token.organized!.blocks.flatMap(b=>b.citations);value={schemaVersion:1,sourceRevisionId:token.input.sourceRevisionId,organizedSha256:generationSha256(token.organized),rootId:'root',nodes:[{id:'root',parentId:null,children:['fact'],title:'主题',notes:'',role:'structure',citations:[]},{id:'fact',parentId:'root',children:[],title:'原文观点',notes:token.organized!.blocks.map(b=>b.text).join('\n'),role:'fact',citations}]};}return{value,rawResponse:{fixture:true,value},model:model.model,configurationSha256:model.configurationSha256,promptVersion:model.promptVersion};}
function prepare(f:F){f.generation.prepareReady();const pending=f.generation.pendingModel();assert.ok(pending);f.generation.beginModelDiscovery(pending.requestId);f.generation.setModel(pending.requestId,model);}
function finish(f:F){let token;while((token=f.generation.next())){f.generation.markSubmitted(token);assert.equal(f.generation.accept(token,response(token)),true);}const ready=f.generation.readyToPublish();assert.equal(ready.length,1);return f.generation.publish(ready[0].requestId);}
const count=(f:F,table:string)=>(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n;

test('generation explicit authorization only; duplicate click merges and unedited system placeholder automatically installs durable paired result',()=>{const f=fixture();try{f.generation.prepareReady();assert.equal(f.generation.next(),null);assert.equal(f.generation.pendingModel(),null);assert.equal(count(f,'generation_requests'),0);const first=click(f);assert.equal(click(f).requestId,first.requestId);assert.equal(first.target!.manualEpoch,0);assert.equal(first.target!.managed,true);const placeholder=f.editor.load(first.target!.workspaceId);assert.equal(placeholder.bundle.draft.revision,0);prepare(f);const done=finish(f);assert.equal(done.state,'succeeded');assert.equal(done.candidate,null);assert.equal(done.markdown.state,'ready');const artifact=f.generation.artifact(f.id)!;assert.equal(artifact.installed,true);assert.match(artifact.markdownText,/25mg/);assert.doesNotMatch(artifact.markdownText,/导图大纲/);assert.equal(f.editor.load(first.target!.workspaceId).bundle.draft.revision,1);assert.equal(f.digest.status(f.id).library!.legacy,false);assert.equal(f.digest.status(f.id).request!.state,'complete');assert.equal(count(f,'generation_calls'),2);assert.equal(count(f,'digest_calls'),0);}finally{f.close();}});

test('generation existing human work or in-flight manual intent/clear/title produces a full candidate without overwriting either document',()=>{for(const mode of ['existing','intent','clear','title']as const){const f=fixture(mode==='existing');try{const requested=click(f),wid=requested.target!.workspaceId;prepare(f);if(mode==='intent')f.generation.touch(f.id,'composition-session');if(mode==='clear'){const open=f.editor.load(wid),draft=clone(open.bundle.draft);draft.blocks=[];assert.equal(f.editor.save([{workspaceId:wid,documentId:draft.documentId,sessionId:'clear',requestId:'one',expectedRevision:draft.revision,document:draft}])[0].status,'saved');}if(mode==='title')f.editor.title(wid,'处理中人工改标题');const before=f.editor.load(wid).bundle;const done=finish(f);assert.equal(done.state,'succeeded');
  // E4.4 §3.2：未改动的既有工作区直接安装并记录采用历史；请求期间的人工变化仍产生候选。
  if(mode==='existing'){assert.equal(done.candidate,null);assert.ok(done.canRestorePrevious);const after=f.editor.load(wid).bundle;assert.equal(after.draft.revision,before.draft.revision+1);assert.equal(after.map.revision,before.map.revision+1);assert.equal(after.workspace.userTitle,'已有人工作品','非托管工作区直接安装保留人工标题');assert.equal(count(f,'generation_adoptions'),1);assert.equal(f.digest.status(f.id).library!.candidate,false);assert.equal(count(f,'generation_calls'),2);continue;}
  assert.ok(done.candidate);assert.deepEqual(f.editor.load(wid).bundle,before);const candidate=f.generation.candidate(f.id)!;assert.match(candidate.markdownText,/25mg/);assert.ok(Object.keys(candidate.artifact.map.nodes).length>=2);assert.equal(f.digest.status(f.id).library!.candidate,true);assert.equal(count(f,'generation_calls'),2);}finally{f.close();}}});

test('generation failed map auto-retries once within the attempt budget; retry reuses successful organize and malformed output never publishes or enters library',()=>{const f=fixture();try{click(f);prepare(f);const organize=f.generation.next()!;assert.equal(f.digest.status(f.id).request!.state,'organizing');f.generation.markSubmitted(organize);assert.equal(f.generation.accept(organize,response(organize)),true);const map=f.generation.next()!;assert.equal(f.digest.status(f.id).request!.state,'mapping');f.generation.markSubmitted(map);const bad=response(map);(bad.value as GeneratedMap).nodes[1].parentId='missing';assert.equal(f.generation.accept(map,bad),false);assert.equal(f.generation.status(f.id).state,'queued');assert.equal(f.digest.status(f.id).request!.state,'queued');assert.equal(f.digest.status(f.id).stages.find(s=>s.name==='map')!.state,'queued');assert.equal(count(f,'digest_library'),0);const mapTask=f.generation.status(f.id).tasks.find(task=>task.id===map.taskId)!;assert.equal(mapTask.state,'queued');assert.equal(mapTask.attempts,1);assert.equal(mapTask.errorCode,'invalid-output');assert.equal(f.generation.next(),null,'退避窗口内不立即重复派发');f.generation.retry(f.id);assert.equal(f.digest.status(f.id).request!.state,'queued');assert.equal(f.digest.status(f.id).stages.find(s=>s.name==='organize')!.state,'succeeded');const retry=f.generation.next()!;assert.equal(retry.stage,'map');assert.equal(retry.taskId,map.taskId);f.generation.markSubmitted(retry);assert.equal(f.generation.accept(retry,response(retry)),true);assert.equal(f.generation.next(),null);const done=f.generation.publish(f.generation.readyToPublish()[0].requestId);assert.equal(done.state,'succeeded');assert.equal(count(f,'generation_calls'),3);}finally{f.close();}});

test('generation submitted interruption remains unknown through restart/poll; cancel makes late results inert and does not cache them',()=>{const f=fixture();try{click(f);prepare(f);const token=f.generation.next()!;f.generation.markSubmitted(token);const restarted=new GenerationRepository(f.store.db,f.root,f.editor,f.digest);restarted.setCapability(true,true);assert.equal(restarted.status(f.id).tasks[0].state,'result-unknown');assert.equal(restarted.status(f.id).state,'result-unknown');assert.equal(f.digest.status(f.id).request!.state,'result-unknown');assert.equal(restarted.next(),null);restarted.retry(f.id);assert.equal(restarted.status(f.id).state,'result-unknown');assert.equal(f.digest.status(f.id).request!.state,'result-unknown');assert.equal(restarted.next(),null);restarted.retry(f.id,true);const retry=restarted.next()!;assert.notEqual(retry.runId,token.runId);restarted.markSubmitted(retry);restarted.cancel(f.id);assert.equal(f.digest.status(f.id).request!.state,'cancelled');assert.equal(f.digest.status(f.id).stages.find(s=>s.name==='organize')!.state,'cancelled');assert.equal(f.digest.status(f.id).stages.find(s=>s.name==='markdown')!.state,'cancelled');assert.equal(restarted.accept(retry,response(retry)),false);assert.equal(count(f,'generation_cache'),0);assert.equal(count(f,'generation_artifacts'),0);assert.equal(count(f,'digest_library'),0);}finally{f.close();}});

test('generation missing configuration/model does not discover or pay in a loop; explicit retry alone enables finite model retry',async()=>{const f=fixture();let discoveries=0;const runner=new GenerationRunner(f.generation,{configured:()=>true,async discoverModel(){discoveries++;throw Object.assign(Error(),{code:'waiting-model'});},async organize(){throw Error('not called');},async map(){throw Error('not called');}},{networkAllowed:true});try{click(f);runner.start();await new Promise(r=>setTimeout(r,20));for(let i=0;i<4;i++)runner.kick();await new Promise(r=>setTimeout(r,20));assert.equal(discoveries,1);assert.equal(count(f,'generation_calls'),0);f.generation.retry(f.id);runner.kick();await new Promise(r=>setTimeout(r,20));assert.equal(discoveries,2);f.generation.retry(f.id);runner.kick();await new Promise(r=>setTimeout(r,20));assert.equal(discoveries,2);assert.equal(f.generation.status(f.id).state,'waiting-model');assert.match(f.generation.status(f.id).error!,/两次尝试上限/);}finally{runner.stop();f.close();}});

test('generation file failure never completes library; retry publishes valid upstream stages without another model call',()=>{const f=fixture();try{click(f);prepare(f);let token;while((token=f.generation.next())){f.generation.markSubmitted(token);f.generation.accept(token,response(token));}const req=f.generation.readyToPublish()[0].requestId,held=path.join(f.root,'held-generation-results');renameSync(f.generation.resultsDir,held);writeFileSync(f.generation.resultsDir,'fault mechanism');assert.equal(f.generation.publish(req).state,'failed');assert.equal(count(f,'digest_library'),0);assert.equal(count(f,'generation_calls'),2);rmSync(f.generation.resultsDir);renameSync(held,f.generation.resultsDir);f.generation.retry(f.id);assert.equal(f.generation.next(),null);assert.equal(f.generation.publish(req).state,'succeeded');assert.equal(count(f,'generation_calls'),2);}finally{f.close();}});

test('generation explicit candidate adoption uses current saved target, preserves old versions and supports atomic paired undo',()=>{const f=fixture(true);try{const clicked=click(f);prepare(f);{const open=f.editor.load(clicked.target!.workspaceId),draft=clone(open.bundle.draft);draft.blocks.push({id:'during-request',type:'paragraph',runs:[{text:'请求期间的人工编辑'}]});assert.equal(f.editor.save([{workspaceId:draft.workspaceId,documentId:draft.documentId,expectedRevision:draft.revision,sessionId:'human',requestId:'zero',document:draft}])[0].status,'saved');}finish(f);const candidate=f.generation.candidate(f.id)!;const stale=f.generation.status(f.id).target!,loaded=f.editor.load(clicked.target!.workspaceId),draft=clone(loaded.bundle.draft);draft.blocks.push({id:'later-manual',type:'paragraph',runs:[{text:'采用之前继续人工整理'}]});assert.equal(f.editor.save([{workspaceId:draft.workspaceId,documentId:draft.documentId,expectedRevision:draft.revision,sessionId:'human',requestId:'one',document:draft}])[0].status,'saved');assert.throws(()=>f.generation.adopt(f.id,candidate.id,stale),/版本.*变化|目标.*变化/);const before=f.editor.load(draft.workspaceId).bundle,current=f.generation.status(f.id).target!;assert.equal(current.draftRevision,before.draft.revision);assert.equal(f.generation.adopt(f.id,candidate.id,current).canRestorePrevious,true);const after=f.editor.load(draft.workspaceId).bundle;assert.equal(after.draft.revision,before.draft.revision+1);assert.equal(after.map.revision,before.map.revision+1);const restored=f.generation.undoAdoption(f.id,f.generation.status(f.id).target!);assert.equal(restored.markdown.state,'ready');assert.equal(restored.canRestorePrevious,false);const back=f.editor.load(draft.workspaceId).bundle;assert.deepEqual(back.draft.blocks,before.draft.blocks);assert.deepEqual(back.map.nodes,before.map.nodes);assert.equal(back.workspace.userTitle,before.workspace.userTitle);assert.equal(back.draft.revision,after.draft.revision+1);assert.equal(count(f,'generation_adoptions'),1);assert.equal(count(f,'generation_adoption_undos'),1);assert.equal(count(f,'generation_calls'),2);}finally{f.close();}});

test('generation manual save derives current Markdown without stale semantic references; file failure preserves saved draft and signals pending file',()=>{const f=fixture();try{const clicked=click(f);prepare(f);finish(f);const loaded=f.editor.load(clicked.target!.workspaceId),draft=clone(loaded.bundle.draft);draft.blocks.push({id:'human-text',type:'paragraph',runs:[{text:'我人工补充的内容，不声称来源已自动核验。'}]});assert.equal(f.editor.save([{workspaceId:draft.workspaceId,documentId:draft.documentId,expectedRevision:draft.revision,sessionId:'human',requestId:'save',document:draft}])[0].status,'saved');assert.equal(f.generation.status(f.id).markdown.state,'pending');assert.equal(f.generation.refreshMarkdown(f.id).markdown.state,'ready');const projection=f.store.db.prepare('SELECT * FROM generation_markdown_projections ORDER BY rowid DESC LIMIT 1').get() as any,markdown=readFileSync(path.join(f.generation.resultsDir,projection.file_path),'utf8');assert.match(markdown,/我人工补充的内容/);assert.match(markdown,/历史自动生成引用仅属于原生成版本/);assert.deepEqual(JSON.parse(projection.refs_json),{});const before=f.editor.load(draft.workspaceId).bundle.draft,held=path.join(f.root,'held-results');renameSync(f.generation.resultsDir,held);writeFileSync(f.generation.resultsDir,'file failure');assert.equal(f.generation.refreshMarkdown(f.id).markdown.state,'failed');assert.deepEqual(f.editor.load(draft.workspaceId).bundle.draft,before);rmSync(f.generation.resultsDir);renameSync(held,f.generation.resultsDir);assert.equal(f.generation.refreshMarkdown(f.id).markdown.state,'ready');assert.equal(count(f,'generation_calls'),2);}finally{f.close();}});

test('generation v8 to9 migration rollback preserves old tables and never creates paid authorizations',()=>{const base=path.resolve('.acceptance-data/editor-e3');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'generation-migration-')),store=new Store(root);try{migrateEditorSchema(store.db,root,{targetVersion:7});migrateAsrSchema(store.db,root);const before=store.db.prepare('SELECT * FROM contents').all();assert.throws(()=>migrateGenerationSchema(store.db,root,{failAfterSchema:true}),/injected/);assert.equal(store.db.pragma('user_version',{simple:true}),8);assert.equal((store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'generation_%'").get() as any).n,0);assert.deepEqual(store.db.prepare('SELECT * FROM contents').all(),before);const done=migrateGenerationSchema(store.db,root);assert.ok(done.backup);assert.equal(store.db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(migrateGenerationSchema(store.db,root),{backup:null,migrated:false});assert.equal((store.db.prepare('SELECT count(*) n FROM generation_calls').get() as any).n,0);
 // E4.4 迁移同样具备备份与幂等：legacy 行标记 legacy 来源。
 const e44=migrateE44Schema(store.db,root);assert.ok(e44.backup);assert.equal(store.db.pragma('user_version',{simple:true}),10);assert.equal(store.db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(migrateE44Schema(store.db,root),{backup:null,migrated:false});assert.equal((store.db.prepare("SELECT count(*) n FROM pragma_table_info('digest_library') WHERE name='source'").get() as any).n,1);}finally{store.close();rmSync(root,{recursive:true,force:true});}});

test('generation deterministic source chunks cover frozen text and ignore later source changes without repeating completed calls',()=>{const f=fixture();try{f.generation=new GenerationRepository(f.store.db,f.root,f.editor,f.digest,{maxChunkCodePoints:20,maxChunkUtf8Bytes:100});f.generation.setCapability(true,true);click(f);prepare(f);const frozen=(f.store.db.prepare('SELECT input_json FROM generation_requests').get() as any).input_json;f.store.db.prepare('UPDATE contents SET source_body=? WHERE id=?').run('后来新增的资料不能混入本次授权',f.id);let token;while((token=f.generation.next())){f.generation.markSubmitted(token);assert.equal(f.generation.accept(token,response(token)),true);}const req=f.generation.readyToPublish()[0].requestId;assert.equal(f.generation.publish(req).state,'succeeded');const artifact=f.generation.artifact(f.id)!;assert.match(artifact.markdownText,/25mg/);assert.doesNotMatch(artifact.markdownText,/后来新增/);assert.equal((f.store.db.prepare('SELECT input_json FROM generation_requests').get() as any).input_json,frozen);assert.equal(count(f,'generation_calls'),4);}finally{f.close();}});

test('generation cancel while renderer installation barrier is pending cannot install late results or enter the library',async()=>{const f=fixture();let opened:()=>void=()=>{},release:(allow:boolean)=>void=()=>{};const ready=new Promise<void>(r=>opened=r),barrier=new Promise<boolean>(r=>release=r);const runner=new GenerationRunner(f.generation,{configured:()=>true,async discoverModel(){return model;},async organize(input){input.onSubmit();return response({...input,stage:'organize'}as any);},async map(input){input.onSubmit();return response({...input,stage:'map'}as any);}},{networkAllowed:true,beforeInstall:async()=>{opened();return barrier;}});try{click(f);runner.start();await ready;runner.cancel(f.id);release(true);await new Promise(r=>setImmediate(r));assert.equal(f.generation.status(f.id).state,'cancelled');assert.equal(count(f,'generation_artifacts'),0);assert.equal(count(f,'digest_library'),0);assert.equal(count(f,'generation_calls'),2);}finally{runner.stop();f.close();}});


test('generation restart drops a prior process editing lease while preserving permanent manual intent and candidate versions',()=>{const f=fixture();try{const initial=click(f),wid=initial.target!.workspaceId;prepare(f);f.generation.touch(f.id,'prior-renderer');const epoch=f.generation.currentTarget(f.id).manualEpoch;assert.equal(count(f,'generation_edit_leases'),1);const sameProcess=new GenerationRepository(f.store.db,f.root,f.editor,f.digest);assert.equal(count(f,'generation_edit_leases'),1);sameProcess.setCapability(true,true);finish(f);const candidate=f.generation.candidate(f.id)!;f.store.db.prepare("UPDATE settings SET value='previous-process-lifetime' WHERE key='generationLeaseOwner'").run();const restarted=new GenerationRepository(f.store.db,f.root,f.editor,f.digest);assert.equal(count(f,'generation_edit_leases'),0);assert.equal(restarted.currentTarget(f.id).manualEpoch,epoch);assert.equal(restarted.currentTarget(f.id).managed,false);assert.equal(restarted.candidate(f.id)!.id,candidate.id);assert.equal(restarted.adopt(f.id,candidate.id,restarted.currentTarget(f.id)).markdown.state,'ready');assert.equal(f.editor.load(wid).bundle.draft.revision,1);assert.equal(count(f,'generation_calls'),2);}finally{f.close();}});


// IR01: these responses and filesystem faults are synthetic; there is no provider or HTTP call.
test('generation paid attempt limit does not block recovering a healthy durable receipt after stage-file publication fails',()=>{
 const f=fixture();try{
  click(f);prepare(f);
  const first=f.generation.next()!;f.generation.markSubmitted(first);f.generation.fail(first,'provider-error',true);f.generation.retry(f.id);
  const second=f.generation.next()!;assert.equal(second.taskId,first.taskId);f.generation.markSubmitted(second);
  const stageDir=path.join(f.generation.resultsDir,'stages');writeFileSync(stageDir,'mechanism fault: stage directory is temporarily a regular file');
  assert.equal(f.generation.accept(second,response(second)),false);
  assert.equal(f.generation.status(f.id).tasks[0].attempts,2);assert.equal(f.generation.status(f.id).tasks[0].state,'failed');assert.equal(count(f,'generation_receipts'),1);assert.equal(count(f,'generation_calls'),2);assert.equal(count(f,'digest_library'),0);
  const receipt=f.store.db.prepare('SELECT json,sha FROM generation_receipts').get() as any;assert.equal(sha256(receipt.json),receipt.sha);
  rmSync(stageDir);f.generation.setCapability(false,false);
  assert.equal(f.generation.retry(f.id).state,'queued');assert.equal(f.generation.next(),null);
  const recovered=f.generation.status(f.id).tasks[0];assert.equal(recovered.state,'succeeded');assert.equal(recovered.attempts,2);assert.equal(recovered.reused,true);assert.equal(count(f,'generation_receipts'),0);assert.equal(count(f,'generation_calls'),2);assert.equal(count(f,'generation_cache'),1);assert.equal(count(f,'digest_library'),0);
  const saved=f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(second.taskId) as any;assert.equal(sha256(readFileSync(path.join(f.generation.resultsDir,saved.result_path))),saved.result_sha);assert.deepEqual(JSON.parse(saved.result_json).value,response(second).value);
 }finally{f.close();}
});

test('generation restart with submitted call and healthy receipt automatically resumes local publication without relabeling the call unsubmitted',()=>{
 const f=fixture();try{
  click(f);prepare(f);const token=f.generation.next()!;f.generation.markSubmitted(token);
  // Exact crash point: provider response committed to SQL, before stage-file publication.
  const json=JSON.stringify(response(token));f.store.db.prepare('INSERT INTO generation_receipts VALUES(?,?,?,?,?)').run(token.runId,token.taskId,json,sha256(json),Date.now());
  const restarted=new GenerationRepository(f.store.db,f.root,f.editor,f.digest);restarted.setCapability(false,false);
  assert.equal(restarted.status(f.id).state,'queued');assert.equal(restarted.status(f.id).tasks[0].state,'queued');assert.equal(f.digest.status(f.id).request!.state,'queued');
  const ledgerBefore=f.store.db.prepare('SELECT submitted,status FROM generation_calls WHERE run_id=?').get(token.runId) as any;assert.deepEqual(ledgerBefore,{submitted:1,status:'response-persisted-local-recovery'});
  assert.equal(restarted.next(),null);const task=restarted.status(f.id).tasks[0];assert.equal(task.state,'succeeded');assert.equal(task.attempts,1);assert.equal(task.reused,true);assert.equal(count(f,'generation_calls'),1);assert.equal(count(f,'generation_receipts'),0);assert.equal(count(f,'digest_library'),0);
  assert.deepEqual(f.store.db.prepare('SELECT submitted,status FROM generation_calls WHERE run_id=?').get(token.runId),ledgerBefore);
 }finally{f.close();}
});

test('generation actual draft export resolves exact saved body citations and rejects a missing version instead of choosing another source',()=>{
 const f=fixture();try{
  const requested=click(f);prepare(f);finish(f);const wid=requested.target!.workspaceId,bundle=f.editor.load(wid).bundle,expected={draftRevision:bundle.draft.revision,mapRevision:bundle.map.revision};
  const row=f.store.db.prepare('SELECT * FROM generation_body_refs WHERE workspace_id=? AND draft_revision=?').get(wid,bundle.draft.revision) as any;assert.equal(row.draft_sha,sha256(JSON.stringify(bundle.draft)));const refs=JSON.parse(row.json) as Record<string,SourceReference[]>;const [bodyBlock,references]=Object.entries(refs)[0],ref=references[0];assert.equal(ref.kind,'capturedSource');if(ref.kind!=='capturedSource')throw Error('fixture citation');
  const exports=path.join(f.root,'exports');mkdirSync(exports);const exported=exportMarkdown(f.editor,wid,'draft',expected,path.join(exports,'exact-generated.md'));assert.equal(exported.status,'exported');const markdown=readFileSync(exported.path!,'utf8');assert.match(markdown,/## 正文出处/);assert.ok(markdown.includes(`正文版本 ${bundle.draft.revision}`));for(const id of [bodyBlock,ref.sourceId,ref.sourceRevisionId,ref.blockId])assert.ok(markdown.includes(id),`export must carry exact identity ${id}`);assert.match(markdown,/25mg/);assert.doesNotMatch(markdown,/导图大纲/);
  const source=f.store.db.prepare('SELECT * FROM editor_sources WHERE source_id=? AND revision_id=? AND workspace_id=?').get(ref.sourceId,ref.sourceRevisionId,wid) as any,alternate=JSON.parse(source.json);alternate.sourceRevisionId='different-version-must-not-replace';alternate.blocks[0].runs=[{text:'另一个版本不是当前出处'}];f.store.db.prepare('INSERT INTO editor_sources VALUES(?,?,?,?,?)').run(source.source_id,alternate.sourceRevisionId,wid,JSON.stringify(alternate),Date.now());f.store.db.prepare('DELETE FROM editor_sources WHERE source_id=? AND revision_id=? AND workspace_id=?').run(ref.sourceId,ref.sourceRevisionId,wid);
  const refused=path.join(exports,'refused.md');assert.throws(()=>exportMarkdown(f.editor,wid,'draft',expected,refused),/来源版本不存在/);assert.equal(existsSync(refused),false);assert.deepEqual(readdirSync(exports),['exact-generated.md']);assert.equal(count(f,'generation_calls'),2);
 }finally{f.close();}
});

test('generation draft export includes citation-only fixture images as relative attachments and does not reuse old semantic sidecars after manual editing',()=>{
 const f=fixture();try{
  const requested=click(f);prepare(f);finish(f);const wid=requested.target!.workspaceId,bundle=f.editor.load(wid).bundle;
  // White-box source-attachment fixture for exporter mechanics, not an OCR or generated-image acceptance claim.
  f.store.detailSaved(f.id,{body:'原始正文包含25mg，只有满足条件才可使用。第二段不超过30天。',bodyComplete:true,mediaManifestComplete:true,media:[{kind:'image',remoteUrl:'https://example.invalid/fixture.png',mime:'image/png',role:'gallery'}]});const media=f.store.content(f.id)!.media[0],filename='sidecar-fixture.png';writeFileSync(path.join(f.root,'media',filename),png);f.store.downloadSaved(media.id,filename,png.length,'image/png');const asset=f.editor.selectImage(wid,media.id);
  const row=f.store.db.prepare('SELECT * FROM generation_body_refs WHERE workspace_id=? AND draft_revision=?').get(wid,bundle.draft.revision) as any,refs=JSON.parse(row.json) as Record<string,SourceReference[]>;Object.values(refs)[0][0].assets=[{assetId:asset.id,version:asset.version}];f.store.db.prepare('UPDATE generation_body_refs SET json=? WHERE workspace_id=? AND draft_revision=?').run(JSON.stringify(refs),wid,bundle.draft.revision);
  assert.equal(bundle.draft.blocks.some(block=>block.assetRefs?.length),false);const exports=path.join(f.root,'exports');mkdirSync(exports);const expected={draftRevision:bundle.draft.revision,mapRevision:bundle.map.revision},exported=exportMarkdown(f.editor,wid,'draft',expected,path.join(exports,'citation-image.md'));assert.equal(exported.files,2);const moved=path.join(f.root,'moved-export');renameSync(exported.path!,moved);const markdown=readFileSync(path.join(moved,'citation-image.md'),'utf8'),relative=`assets/${asset.sha256}.png`;assert.ok(markdown.includes(`![来源图片](${relative})`));assert.deepEqual(readFileSync(path.join(moved,relative)),png);assert.doesNotMatch(markdown,/rlw-media:|rlw-editor:|file:\/\//);
  // A same-revision sidecar with the wrong structured-draft SHA is not trusted either.
  f.store.db.prepare('UPDATE generation_body_refs SET draft_sha=? WHERE workspace_id=? AND draft_revision=?').run('0'.repeat(64),wid,bundle.draft.revision);const mismatched=exportMarkdown(f.editor,wid,'draft',expected,path.join(exports,'sha-mismatch.md'));assert.equal(mismatched.files,1);assert.doesNotMatch(readFileSync(mismatched.path!,'utf8'),/## 正文出处|来源图片/);
  f.store.db.prepare('UPDATE generation_body_refs SET draft_sha=? WHERE workspace_id=? AND draft_revision=?').run(row.draft_sha,wid,bundle.draft.revision);
  const draft=clone(bundle.draft);draft.blocks.push({id:'manual-new-version',type:'paragraph',runs:[{text:'本句由用户人工补充，不继承旧生成出处。'}]});assert.equal(f.editor.save([{workspaceId:wid,documentId:draft.documentId,expectedRevision:draft.revision,sessionId:'manual',requestId:'new-draft',document:draft}])[0].status,'saved');const current=f.editor.load(wid).bundle;assert.equal((f.store.db.prepare('SELECT count(*) n FROM generation_body_refs WHERE workspace_id=? AND draft_revision=?').get(wid,current.draft.revision) as any).n,0);
  const human=exportMarkdown(f.editor,wid,'draft',{draftRevision:current.draft.revision,mapRevision:current.map.revision},path.join(exports,'manual.md')),humanMarkdown=readFileSync(human.path!,'utf8');assert.equal(human.files,1);assert.match(humanMarkdown,/本句由用户人工补充/);assert.match(humanMarkdown,/历史生成出处仅属于原生成版本/);assert.doesNotMatch(humanMarkdown,/## 正文出处|来源图片/);assert.equal(count(f,'generation_calls'),2);
 }finally{f.close();}
});

test('explicit input-limit retry replans only zero-submission work and preserves original inputs, model and call evidence',()=>{
 const f=fixture();try{
  click(f);prepare(f);const token=f.generation.next()!;f.generation.fail(token,'input-limit');
  const before=f.store.db.prepare('SELECT * FROM generation_requests').get() as any,calls=f.store.db.prepare('SELECT * FROM generation_calls').all();
  f.generation.setWireSizer((_input,chunk)=>chunk.slices.reduce((n,s)=>n+s.end-s.start,0)*2000);
  assert.equal(f.generation.retry(f.id).state,'queued');
  const after=f.store.db.prepare('SELECT * FROM generation_requests').get() as any,plan=JSON.parse(after.plan_json),tasks=f.generation.status(f.id).tasks;
  assert.ok(plan.chunks.length>1);assert.equal(tasks.length,plan.chunks.length);assert.equal(tasks[0].id,token.taskId);
  for(const field of ['request_id','generation','scope_revision','input_json','input_sha','model_json','target_json','model_attempts'])assert.equal(after[field],before[field],field);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM generation_calls').all(),calls);assert.ok(tasks.every(task=>task.attempts===0));
  const files=readdirSync(path.join(f.generation.resultsDir,'replans'));assert.equal(files.length,1);const audit=JSON.parse(readFileSync(path.join(f.generation.resultsDir,'replans',files[0]),'utf8'));
  assert.deepEqual(audit.oldPlan,JSON.parse(before.plan_json));assert.deepEqual(audit.newPlan,plan);assert.deepEqual(audit.calls,calls);assert.equal(audit.oldTasks[0].id,token.taskId);
  const input=JSON.parse(after.input_json);for(const unit of input.units){const slices=plan.chunks.flatMap((c:any)=>c.slices).filter((s:any)=>s.unitId===unit.id);let end=0;for(const slice of slices){assert.equal(slice.start,end);end=slice.end;}assert.equal(end,Array.from(unit.text).length);}
  f.generation.retry(f.id);assert.equal((f.store.db.prepare('SELECT plan_json FROM generation_requests').get() as any).plan_json,after.plan_json);assert.equal(readdirSync(path.join(f.generation.resultsDir,'replans')).length,1);
 }finally{f.close();}
});

test('wire replanning never changes submitted, unknown, in-flight or receipted frozen work',()=>{
 for(const mode of ['submitted','unknown','in-flight','receipt','historical-unknown','cache']as const){const f=fixture();try{
  click(f);prepare(f);const token=f.generation.next()!;
  if(mode==='submitted')f.generation.markSubmitted(token);
  if(mode==='unknown')f.generation.fail(token,'result-unknown');else if(mode!=='in-flight')f.generation.fail(token,'input-limit',mode==='submitted');
  if(mode==='receipt'){const value=JSON.stringify(response(token));f.store.db.prepare('INSERT INTO generation_receipts VALUES(?,?,?,?,?)').run(token.runId,token.taskId,value,sha256(value),Date.now());}
  if(mode==='historical-unknown')f.store.db.prepare("UPDATE generation_calls SET status='result-unknown' WHERE run_id=?").run(token.runId);
  if(mode==='cache')f.store.db.prepare('INSERT INTO generation_cache VALUES(?,?,?,?,?)').run(token.inputSha256,'{}','fixture-cache.json','a'.repeat(64),Date.now());
  const before=f.store.db.prepare('SELECT plan_json,input_json,model_json FROM generation_requests').get(),calls=f.store.db.prepare('SELECT * FROM generation_calls').all();
  f.generation.setWireSizer((_input,chunk)=>chunk.slices.reduce((n,s)=>n+s.end-s.start,0)*2000);f.generation.retry(f.id);
  assert.deepEqual(f.store.db.prepare('SELECT plan_json,input_json,model_json FROM generation_requests').get(),before,mode);assert.deepEqual(f.store.db.prepare('SELECT * FROM generation_calls').all(),calls,mode);assert.equal(existsSync(path.join(f.generation.resultsDir,'replans')),false,mode);
  if(mode==='unknown')assert.equal(f.generation.status(f.id).state,'result-unknown');
 }finally{f.close();}}
});

test('provider wire sizing is registered by the runner before initial model plan freezing',()=>{
 const f=fixture();const provider={configured:()=>true,async discoverModel(){return model;},organizeInputBytes:(_input:any,chunk:any)=>chunk.slices.reduce((n:number,s:any)=>n+s.end-s.start,0)*2000,async organize(){throw Error('must not dispatch');},async map(){throw Error('must not dispatch');}};
 const runner=new GenerationRunner(f.generation,provider);try{click(f);prepare(f);const row=f.store.db.prepare('SELECT plan_json FROM generation_requests').get() as any;assert.ok(JSON.parse(row.plan_json).chunks.length>1);assert.equal(count(f,'generation_calls'),0);}finally{runner.stop();f.close();}
});

test('wire replan and retry status roll back together after a late database failure, preserving durable before evidence',()=>{
 const f=fixture();try{
  click(f);prepare(f);const token=f.generation.next()!;f.generation.fail(token,'input-limit');f.generation.setWireSizer((_input,chunk)=>chunk.slices.reduce((n,s)=>n+s.end-s.start,0)*2000);
  const before={request:f.store.db.prepare('SELECT * FROM generation_requests').get(),tasks:f.store.db.prepare('SELECT * FROM generation_tasks').all(),calls:f.store.db.prepare('SELECT * FROM generation_calls').all()};
  f.store.db.exec("CREATE TRIGGER fixture_retry_failure BEFORE UPDATE OF state ON generation_requests WHEN NEW.state='queued' BEGIN SELECT RAISE(ABORT,'fixture retry commit failed'); END");
  assert.throws(()=>f.generation.retry(f.id),/fixture retry commit failed/);
  assert.deepEqual({request:f.store.db.prepare('SELECT * FROM generation_requests').get(),tasks:f.store.db.prepare('SELECT * FROM generation_tasks').all(),calls:f.store.db.prepare('SELECT * FROM generation_calls').all()},before);
  assert.equal(readdirSync(path.join(f.generation.resultsDir,'replans')).length,1);
 }finally{f.close();}
});

test('wire replan rejects a mismatched immutable input digest before altering plan or tasks',()=>{
 const f=fixture();try{
  click(f);prepare(f);const token=f.generation.next()!;f.generation.fail(token,'input-limit');f.generation.setWireSizer((_input,chunk)=>chunk.slices.reduce((n,s)=>n+s.end-s.start,0)*2000);
  f.store.db.prepare('UPDATE generation_requests SET input_sha=?').run('b'.repeat(64));const before=f.store.db.prepare('SELECT plan_json FROM generation_requests').get();
  assert.throws(()=>f.generation.retry(f.id),/冻结来源/);assert.deepEqual(f.store.db.prepare('SELECT plan_json FROM generation_requests').get(),before);assert.equal(existsSync(path.join(f.generation.resultsDir,'replans')),false);
 }finally{f.close();}
});

test('generation source near 65k code points plans within the 24-chunk ceiling and completes organize-map-merge',()=>{
 const f=fixture(false,'长文段落。'.repeat(13_000));try{
  click(f);prepare(f);
  const plan=JSON.parse((f.store.db.prepare('SELECT plan_json FROM generation_requests').get() as any).plan_json);
  assert.ok(plan.chunks.length>=13&&plan.chunks.length<=24,`chunks=${plan.chunks.length}`);
  const done=finish(f);
  assert.equal(done.state,'succeeded');
  assert.equal(f.generation.status(f.id).tasks.filter(task=>task.stage==='organize').length,plan.chunks.length);
  assert.equal(f.generation.status(f.id).tasks.filter(task=>task.stage==='map').length,plan.chunks.length);
  assert.equal(count(f,'generation_calls'),plan.chunks.length*2);
  const artifact=f.generation.artifact(f.id)!;assert.match(artifact.markdownText,/长文段落/);assert.ok(Object.keys(artifact.artifact.map.nodes).length>plan.chunks.length);
 }finally{f.close();}
});

test('generation source beyond the 24-chunk ceiling fails honestly without truncation, plan or paid call',()=>{
 const f=fixture(false,'字'.repeat(97_500));try{
  click(f);f.generation.prepareReady();
  const pending=f.generation.pendingModel()!;assert.ok(pending);
  f.generation.beginModelDiscovery(pending.requestId);
  try{f.generation.setModel(pending.requestId,model);assert.fail('input-limit expected');}catch(error){assert.equal((error as any).code,'input-limit');f.generation.modelFailed(pending.requestId,(error as any).code);}
  const status=f.generation.status(f.id),row=f.store.db.prepare('SELECT input_json,plan_json,model_json FROM generation_requests').get() as any;
  assert.equal(status.state,'waiting-model');assert.equal(status.errorCode,'input-limit');
  const points=(JSON.parse(row.input_json).units as any[]).reduce((n:number,unit:any)=>n+Array.from(unit.text).length,0);
  assert.ok(points>96_000);
  assert.equal(status.error,`转录稿约 ${(points/10_000).toFixed(1)} 万字，超过单次整理上限（约 9.6 万字），未截断`);
  assert.equal(row.plan_json,null);assert.equal(row.model_json,null);assert.equal(count(f,'generation_calls'),0);
  assert.match(f.digest.status(f.id).stages.find(s=>s.name==='organize')!.error!,/转录稿约 9\.\d 万字，超过单次整理上限（约 9\.6 万字），未截断/);
 }finally{f.close();}
});

test('e415InputLimitReplan unsticks old-bound no-model rows once, replans unsubmitted model rows and leaves others untouched',()=>{
 const f=fixture();try{
  const s1=click(f);
  const extra=(sourceId:string,title:string)=>{const item={sourceId,title,author:'test',url:`https://www.xiaohongshu.com/explore/${sourceId}`,kind:'text' as const,folderIds:[]};f.store.saveSnapshot({platform:'xiaohongshu',accountId:'fixture',accountName:'合成机制',folders:[],complete:true,items:[item]},[{item,discovery:'historical'}],1);const id=f.store.find('xiaohongshu','fixture',item.sourceId)!;f.store.detailSaved(id,{body:'另一条正文。',bodyComplete:true,mediaManifestComplete:true,media:[]});f.digest.request(id);return{id,state:f.generation.authorize(id)};};
  const second=extra('mechanism-other','另一条'),third=extra('mechanism-third','第三条');
  f.generation.prepareReady();
  f.generation.beginModelDiscovery(s1.requestId!);f.generation.modelFailed(s1.requestId!,'input-limit');
  assert.equal(f.generation.status(f.id).tasks.length,0);
  f.store.db.prepare("UPDATE generation_requests SET error_json=?,model_attempts=2 WHERE request_id=?").run(JSON.stringify({code:'model-attempt-limit',message:'两次尝试上限'}),second.state.requestId!);
  f.generation.beginModelDiscovery(third.state.requestId!);f.generation.setModel(third.state.requestId!,model);
  const token=f.generation.next()!;f.generation.fail(token,'input-limit');
  f.generation.setWireSizer((_input,chunk)=>chunk.slices.reduce((n,s)=>n+s.end-s.start,0)*8000);
  const row=(requestId:string)=>f.store.db.prepare('SELECT * FROM generation_requests WHERE request_id=?').get(requestId) as any;
  assert.equal(f.generation.pendingModel(),null);
  const events:[string,any][]=[];f.generation.unstickInputLimit((event,fields)=>events.push([event,fields]));
  assert.deepEqual(events,[['generation-input-limit-replan',{requeued:1,replanned:1}]]);
  const r1=row(s1.requestId!);assert.equal(r1.error_json,null);assert.equal(r1.model_attempts,0);assert.equal(r1.state,'waiting-model');
  const r2=row(second.state.requestId!);assert.equal(JSON.parse(r2.error_json).code,'model-attempt-limit');assert.equal(r2.model_attempts,2);
  const r3=row(third.state.requestId!);assert.equal(r3.state,'queued');assert.equal(r3.error_json,null);assert.ok(JSON.parse(r3.plan_json).chunks.length>1);
  const stage=f.digest.status(f.id).stages.find(s=>s.name==='organize')!;assert.equal(stage.state,'waiting-capability');assert.ok(!stage.error);
  const again=f.generation.pendingModel()!;assert.equal(again.requestId,s1.requestId);f.generation.beginModelDiscovery(again.requestId);f.generation.setModel(again.requestId,model);
  f.store.db.prepare("UPDATE generation_requests SET error_json=? WHERE request_id=?").run(JSON.stringify({code:'input-limit',message:'二次下毒'}),s1.requestId!);
  f.generation.unstickInputLimit((event,fields)=>events.push([event,fields]));
  assert.equal(events.length,1);assert.equal(JSON.parse(row(s1.requestId!).error_json).message,'二次下毒');
 }finally{f.close();}
});

test('a chunk invalid twice fails the request honestly while its queued siblings stop dispatching and stay resumable',()=>{
 const f=fixture(false,'分段正文，'.repeat(60));try{
  f.generation=new GenerationRepository(f.store.db,f.root,f.editor,f.digest,{maxChunkCodePoints:60,maxChunkUtf8Bytes:300});f.generation.setCapability(true,true);
  click(f);prepare(f);
  const chunks=JSON.parse((f.store.db.prepare('SELECT plan_json FROM generation_requests').get() as any).plan_json).chunks.length;assert.ok(chunks>1);
  const first=f.generation.next()!;f.generation.markSubmitted(first);
  const bad=response(first);(bad.value as OrganizedDocument).blocks[0].citations[0].excerpt='编造出处';
  assert.equal(f.generation.accept(first,structuredClone(bad)),false);assert.equal(f.generation.status(f.id).state,'queued');
  const sibling=f.generation.next()!;assert.notEqual(sibling.taskId,first.taskId);f.generation.markSubmitted(sibling);assert.equal(f.generation.accept(sibling,response(sibling)),true);
  f.store.db.prepare('UPDATE generation_tasks SET not_before=0 WHERE id=?').run(first.taskId);
  const again=f.generation.next()!;assert.equal(again.taskId,first.taskId);f.generation.markSubmitted(again);assert.equal(f.generation.accept(again,structuredClone(bad)),false);
  assert.equal(f.generation.status(f.id).state,'failed');assert.equal(f.generation.status(f.id).errorCode,'invalid-output');
  assert.equal(f.digest.status(f.id).request!.state,'failed');assert.equal(count(f,'generation_calls'),3);
  assert.equal(f.generation.next(),null,'该请求的其余排队分块在失败后不再派发');
  assert.equal(f.generation.status(f.id).tasks.filter(task=>task.state==='queued').length,chunks-2);
  f.generation.retry(f.id);assert.equal(f.generation.next(),null);assert.equal(count(f,'generation_calls'),3);assert.equal(f.generation.status(f.id).errorCode,'attempt-limit');
 }finally{f.close();}
});

test('result-unknown and transport failures are never auto-retried; only invalid-output within the attempt budget is',()=>{
 const f=fixture();try{
  click(f);prepare(f);
  const unknown=f.generation.next()!;f.generation.markSubmitted(unknown);f.generation.fail(unknown,'result-unknown',true);
  assert.equal(f.generation.status(f.id).state,'result-unknown');assert.equal(f.generation.status(f.id).tasks[0].state,'result-unknown');assert.equal(f.generation.next(),null);
 }finally{f.close();}
 const g=fixture();try{
  click(g);prepare(g);
  const token=g.generation.next()!;g.generation.markSubmitted(token);g.generation.fail(token,'rate-limit',true,30000);
  assert.equal(g.generation.status(g.id).state,'failed');assert.equal(g.generation.status(g.id).tasks[0].state,'failed');assert.equal(g.generation.next(),null);
 }finally{g.close();}
});

test('e416InvalidOutputRetry requeues first-attempt invalid-output failures once and leaves exhausted or unknown rows untouched',()=>{
 const f=fixture(false,'分段正文，'.repeat(60));try{
  f.generation=new GenerationRepository(f.store.db,f.root,f.editor,f.digest,{maxChunkCodePoints:60,maxChunkUtf8Bytes:300});f.generation.setCapability(true,true);
  click(f);prepare(f);
  const first=f.generation.next()!;f.generation.markSubmitted(first);
  // 构造旧版本遗留形态：首个 invalid-output 就把整个请求标失败，其余分块停在 queued。
  f.store.db.prepare("UPDATE generation_tasks SET state='failed',run_id=NULL,error_json=? WHERE id=?").run(JSON.stringify({code:'invalid-output',message:'生成的出处无法与本条原资料准确对应，结果尚未采用。'}),first.taskId);
  f.store.db.prepare("UPDATE generation_calls SET status='invalid-output',finished_at=? WHERE run_id=?").run(Date.now(),first.runId);
  f.store.db.prepare("UPDATE generation_requests SET state='failed',error_json=? WHERE request_id=?").run(JSON.stringify({code:'invalid-output',message:'生成的出处无法与本条原资料准确对应，结果尚未采用。'}),first.requestId);
  assert.equal(f.generation.next(),null);
  const events:[string,any][]=[];f.generation.unstickInvalidOutput((event,fields)=>events.push([event,fields]));
  assert.deepEqual(events,[['generation-invalid-output-retry',{requeued:1}]]);
  const req=f.store.db.prepare('SELECT state,error_json FROM generation_requests WHERE request_id=?').get(first.requestId) as any;
  assert.equal(req.state,'queued');assert.equal(req.error_json,null);
  const task=f.store.db.prepare('SELECT state,attempts,error_json FROM generation_tasks WHERE id=?').get(first.taskId) as any;
  assert.equal(task.state,'queued');assert.equal(task.attempts,1);assert.equal(JSON.parse(task.error_json).code,'invalid-output');
  // 其余排队分块正常恢复派发，被拒分块带着既有失败身份重试一次后成功发布。
  f.store.db.prepare('UPDATE generation_tasks SET not_before=0 WHERE request_id=?').run(first.requestId);
  let token;while((token=f.generation.next())){f.generation.markSubmitted(token);f.generation.accept(token,response(token));}
  assert.equal(f.generation.publish(f.generation.readyToPublish()[0].requestId).state,'succeeded');
  f.generation.unstickInvalidOutput((event,fields)=>events.push([event,fields]));assert.equal(events.length,1,'第二次运行不再动任何行');
 }finally{f.close();}
 const g=fixture();try{
  click(g);prepare(g);
  const token=g.generation.next()!;g.generation.markSubmitted(token);
  // 已用尽尝试预算的旧失败行不得被一次性修复复活。
  g.store.db.prepare("UPDATE generation_tasks SET state='failed',attempts=2,run_id=NULL,error_json=? WHERE id=?").run(JSON.stringify({code:'invalid-output'}),token.taskId);
  g.store.db.prepare("UPDATE generation_requests SET state='failed',error_json=? WHERE request_id=?").run(JSON.stringify({code:'invalid-output',message:'x'}),token.requestId);
  g.generation.unstickInvalidOutput(()=>{});
  const row=g.store.db.prepare('SELECT state,error_json FROM generation_requests WHERE request_id=?').get(token.requestId) as any;
  assert.equal(row.state,'failed');assert.equal(JSON.parse(row.error_json).code,'invalid-output');
  assert.equal((g.store.db.prepare('SELECT state FROM generation_tasks WHERE id=?').get(token.taskId) as any).state,'failed');
 }finally{g.close();}
});
