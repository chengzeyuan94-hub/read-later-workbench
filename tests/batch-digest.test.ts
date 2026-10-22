import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { AsrRepository, migrateAsrSchema } from '../src/main/asr-store.js';
import { AsrRunner } from '../src/main/asr-runner.js';
import { ASR_PROVIDER_CONFIG } from '../src/main/asr-provider.js';
import { OcrRepository } from '../src/main/ocr-store.js';
import { sha256 } from '../src/main/editor-media.js';
import { png } from './e1-helpers.js';
import type { OcrEngine } from '../src/shared/ocr-contracts.js';
import { GenerationRepository, migrateGenerationSchema } from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { GenerationRunner, type GenerationProviderAdapter } from '../src/main/generation-runner.js';
import { SiliconFlowGenerationProvider, GENERATION_MODEL_POLICY } from '../src/main/generation-provider.js';
import { BatchDigestCoordinator, type BatchDigestDependencies } from '../src/main/batch-digest.js';
import { isAsrPreparationNamespacePath } from '../src/main/asr-media.js';
import { generationSha256 } from '../src/main/generation-validation.js';
import { pointSlice } from '../src/editor-core/model.js';
import type { GenerationModelSelection, GenerationProviderResult, OrganizedDocument } from '../src/shared/generation-contracts.js';

const model: GenerationModelSelection = {provider:'siliconflow',model:'batch-fixture-no-http',discoveredAt:1,accountModelsSha256:'a'.repeat(64),publishedContextTokens:65536,providerOutputLimitTokens:null,inputBudgetUtf8Bytes:32000,maxOutputTokens:16384,applicationContextBudgetTokens:65536,responseFormat:'json_object',promptVersion:'read-create-source-grounded-v1',configurationSha256:'b'.repeat(64),capabilitySources:['synthetic fixture only']};
function fixture(count = 4) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'batch-digest-')), store = new Store(root);
  const items = Array.from({length:count},(_,index)=>({sourceId:`batch-fixture-${index}`,title:`合成收藏 ${index}`,author:'test',url:`https://www.xiaohongshu.com/explore/batch-fixture-${index}`,kind:'text' as const,folderIds:[]}));
  store.saveSnapshot({platform:'xiaohongshu',accountId:'synthetic-account',accountName:'合成账号',folders:[],complete:true,items},items.map(item=>({item,discovery:'historical' as const})),1);
  const ids=items.map(item=>store.find('xiaohongshu','synthetic-account',item.sourceId)!);
  const ready=(id:number)=>store.detailSaved(id,{body:`这是收藏 ${id} 的独立正文，只有满足条件才能使用。`,bodyComplete:true,mediaManifestComplete:true,media:[]});
  migrateEditorSchema(store.db,root,{targetVersion:7}); const editor=new EditorRepository(store.db,root);
  migrateAsrSchema(store.db,root); const digest=new DigestRepository(store.db,root,editor);
  migrateGenerationSchema(store.db,root);migrateE44Schema(store.db,root); const generation=new GenerationRepository(store.db,root,editor,digest);
  let kicks=0;
  const deps:BatchDigestDependencies={getContent:id=>store.content(id),statusDigest:id=>digest.status(id),requestDigest:(id,renew)=>{digest.request(id,renew);generation.authorize(id);return digest.status(id);},retryDigest:id=>{digest.retry(id);generation.retry(id);},cancelDigest:id=>{generation.cancel(id);digest.cancel(id);},kickRunners:()=>{kicks++;}};
  const batch=new BatchDigestCoordinator(store.db,deps);
  return {root,store,ids,editor,digest,generation,deps,batch,ready,kicks:()=>kicks,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const end=Date.now()+2500;while(!check()){assert.ok(Date.now()<end,'runner should settle');await delay(5);}}
function localResponse(value:unknown):GenerationProviderResult{return{value,rawResponse:{fixture:true,value},model:model.model,configurationSha256:model.configurationSha256,promptVersion:model.promptVersion};}
function provider(hooks:{beforeOrganize?:()=>Promise<void>;onCall?:()=>void}={}):GenerationProviderAdapter{return{
  configured:()=>true,async discoverModel(){return model;},async ensureModel(value){return value;},
  async organize(input){input.onSubmit();hooks.onCall?.();await hooks.beforeOrganize?.();const value:OrganizedDocument={schemaVersion:1,sourceRevisionId:input.input.sourceRevisionId,title:'正文',lead:'',blocks:input.chunk.slices.map((slice,index)=>{const unit=input.input.units.find(u=>u.id===slice.unitId)!,text=pointSlice(unit.text,slice.start,slice.end);return{id:`block-${index}`,type:'paragraph',text,role:'fact',citations:[{unitId:unit.id,start:slice.start,end:slice.end,excerpt:text}]};}),coverage:input.chunk.slices.map(slice=>({unitId:slice.unitId,start:slice.start,end:slice.end,disposition:'included'}))};return localResponse(value);},
  async map(input){input.onSubmit();hooks.onCall?.();return localResponse({schemaVersion:1,sourceRevisionId:input.input.sourceRevisionId,organizedSha256:generationSha256(input.organized),rootId:'root',nodes:[{id:'root',parentId:null,children:['fact'],title:'主题',notes:'',role:'structure',citations:[]},{id:'fact',parentId:'root',children:[],title:'原文观点',notes:input.organized.blocks.map(block=>block.text).join('\n'),role:'fact',citations:input.organized.blocks.flatMap(block=>block.citations)}]});},
};}

test('batch waits for complete download before freezing and never authorizes unselected items',()=>{
  const f=fixture();try{const run=f.batch.create([f.ids[0],f.ids[1]]);assert.equal(run.counts['waiting-download'],2);assert.equal(f.digest.list().filter(item=>item.request).length,0);f.ready(f.ids[0]);f.batch.tick();const state=f.batch.status(run.id);assert.ok(state.items[0].requestId);assert.equal(state.items[1].requestId,null);assert.equal(f.digest.status(f.ids[2]).request,null);const first=state.items[0].requestId;f.batch.tick();assert.equal(f.batch.status(run.id).items[0].requestId,first);assert.equal((f.store.db.prepare('SELECT count(*) n FROM digest_requests').get() as any).n,1);}finally{f.close();}
});

test('E4.13: per-create bound is 1-35 distinct items; no lifetime cap; non-terminal items block re-entry',()=>{
  const f=fixture(40);try{
    assert.throws(()=>f.batch.create(f.ids.slice(0,36)),/1 至 35/);
    f.batch.create(f.ids.slice(0,30));
    assert.throws(()=>f.batch.create([f.ids[0]]),/收藏正在处理中/);
    f.batch.create(f.ids.slice(30,36));
    assert.equal(f.batch.list().flatMap(batch=>batch.items).length,36);
    assert.throws(()=>f.batch.create([f.ids[38],f.ids[38]]),/1 至 35/);
  }finally{f.close();}
});
test('E4.13: a collection may join a new batch once its previous item is terminal',()=>{
  const f=fixture();try{
    const run=f.batch.create([f.ids[0]]);
    f.batch.cancelItem(run.id,f.ids[0]);
    const again=f.batch.create([f.ids[0]]);
    assert.equal(again.items[0].contentId,f.ids[0]);
    assert.equal((f.store.db.prepare('SELECT count(*) n FROM batch_digest_items WHERE content_id=?').get(f.ids[0]) as any).n,2);
  }finally{f.close();}
});
test('E4.13: renew re-batches a completed collection; a non-renew create keeps the done rule',()=>{
  const f=fixture();try{
    const request={id:'r-old',contentId:f.ids[0],state:'complete' as const,generation:1,requestedAt:1,updatedAt:1,completedAt:1,inputScope:{} as any,targetVersion:null,sourceUpdated:false,synthetic:false,candidate:false};
    const status=f.deps.statusDigest;f.deps.statusDigest=id=>id===f.ids[0]?{contentId:id,request,stages:[],library:null,readiness:{ready:true,reasons:[]},capabilities:{ocr:false,asr:false,organize:false,map:false,markdown:false}}:status(id);
    assert.throws(()=>f.batch.create([f.ids[0]]),/已有完成成果/);
    let renewed:boolean|undefined;
    f.deps.requestDigest=(id,renew)=>{renewed=renew;const base=status(id);return{...base,request:{...request,id:'r-new',state:'queued' as const,synthetic:false}};};
    const run=f.batch.create([f.ids[0]],true);
    f.ready(f.ids[0]);f.batch.tick();
    assert.equal(renewed,true);
    assert.equal(f.batch.status(run.id).items[0].requestId,'r-new');
  }finally{f.close();}
});

test('submission budget and original submitted marker commit atomically and survive restart',()=>{
  const f=fixture();try{f.ready(f.ids[0]);const run=f.batch.create([f.ids[0]]),requestId=run.items[0].requestId!,hook=f.batch.hooks('generation');f.store.db.exec('CREATE TABLE fake_markers(id TEXT PRIMARY KEY)');assert.throws(()=>hook.submit({requestId,runId:'rollback'},()=>{f.store.db.prepare('INSERT INTO fake_markers VALUES(?)').run('rollback');throw Error('local marker failed');}),/local marker/);assert.equal(f.batch.status(run.id).budget.generationPosts,0);assert.equal((f.store.db.prepare('SELECT count(*) n FROM fake_markers').get() as any).n,0);hook.submit({requestId,runId:'ok'},()=>f.store.db.prepare('INSERT INTO fake_markers VALUES(?)').run('ok'));assert.equal(f.batch.status(run.id).budget.generationPosts,1);assert.throws(()=>hook.submit({requestId,runId:'ok'},()=>{}),/batch-unauthorized/);const restarted=new BatchDigestCoordinator(f.store.db,f.deps);assert.equal(restarted.status(run.id).state,'running','a started digest continues after restart');assert.equal(restarted.status(run.id).budget.generationPosts,1);assert.equal(restarted.hooks('generation').allowRequest(requestId),true);restarted.pause(run.id);const again=new BatchDigestCoordinator(f.store.db,f.deps);assert.equal(again.status(run.id).state,'paused','a manual pause survives restart');assert.equal(again.hooks('generation').allowRequest(requestId),false);f.store.db.prepare("UPDATE batch_digest_runs SET reason='应用已重启，已完成成果保留；继续后处理剩余任务' WHERE id=?").run(run.id);const legacy=new BatchDigestCoordinator(f.store.db,f.deps);assert.equal(legacy.status(run.id).state,'running','runs paused only by an old restart resume');}finally{f.close();}
});

test('E4.13: ASR submissions charge minutes for usage reporting without any cap',()=>{
  const f=fixture();try{f.ready(f.ids[0]);const run=f.batch.create([f.ids[0]]),requestId=run.items[0].requestId!,hook=f.batch.hooks('asr');for(let i=0;i<31;i++)hook.submit({requestId,runId:`audio-${i}`,durationMs:10*60_000},()=>{});assert.deepEqual([f.batch.status(run.id).budget.asrMinutes,f.batch.status(run.id).budget.asrPosts],[310,31]);let called=false;assert.doesNotThrow(()=>hook.submit({requestId,runId:'overflow',durationMs:60_000},()=>{called=true;}));assert.equal(called,true);assert.equal(hook.allowRequest(requestId),true);}finally{f.close();}
});

test('E4.13: generation submissions across batches have no shared ceiling; usage stays per batch',()=>{
  const f=fixture();try{f.ready(f.ids[0]);f.ready(f.ids[1]);const first=f.batch.create([f.ids[0]]),a=first.items[0].requestId!;for(let i=0;i<181;i++)f.batch.hooks('generation').submit({requestId:a,runId:`gen-${i}`},()=>{});const second=f.batch.create([f.ids[1]]),b=second.items[0].requestId!;assert.doesNotThrow(()=>f.batch.hooks('generation').submit({requestId:b,runId:'gen-extra'},()=>{}));assert.equal(f.batch.status(second.id).budget.generationPosts,1);assert.equal(f.batch.status(first.id).budget.generationPosts,181);for(let i=0;i<61;i++)f.batch.hooks('asr').submit({requestId:b,runId:`short-${i}`,durationMs:1000},()=>{});assert.equal(f.batch.status(second.id).budget.asrPosts,61);}finally{f.close();}
});

test('runner handles only selected requests, full paired results use normal publishing and old tasks stay untouched',async()=>{
  const f=fixture();let calls=0;f.ids.forEach(f.ready);f.digest.request(f.ids[0]);f.generation.authorize(f.ids[0]);const old=f.store.db.prepare('SELECT * FROM generation_requests WHERE content_id=?').get(f.ids[0]);const run=f.batch.create([f.ids[1],f.ids[2]]),runner=new GenerationRunner(f.generation,provider({onCall:()=>{calls++;}}),{networkAllowed:true,batch:f.batch.hooks('generation')});
  try{runner.start();await until(()=>f.batch.status(run.id).state==='complete');assert.equal(calls,4);assert.equal(f.batch.status(run.id).counts.complete,2);assert.deepEqual(f.store.db.prepare('SELECT * FROM generation_requests WHERE content_id=?').get(f.ids[0]),old);assert.equal(f.generation.artifact(f.ids[1])!.installed,true);assert.equal(f.batch.status(run.id).budget.generationPosts,4);}finally{runner.stop();f.close();}
});

test('completed and candidate items hide old extraction progress reasons after restart',()=>{
  const f=fixture();try{
    f.ids.slice(0,3).forEach(f.ready);const run=f.batch.create(f.ids.slice(0,3));
    // Reproduce persisted rows from a prior build, which skipped terminal
    // refreshes and kept a successful extractor's waiting-for-generation text.
    f.store.db.prepare("UPDATE batch_digest_items SET state='complete',reason='转录已完成，等待整理／生成' WHERE content_id=?").run(f.ids[0]);
    f.store.db.prepare("UPDATE batch_digest_items SET state='candidate',reason='图片文字已保存，等待内容整理能力' WHERE content_id=?").run(f.ids[1]);
    const restarted=new BatchDigestCoordinator(f.store.db,f.deps),state=restarted.status(run.id);
    assert.equal(state.items[0].state,'complete');assert.equal(state.items[0].reason,undefined);
    assert.equal(state.items[1].state,'candidate');assert.equal(state.items[1].reason,undefined);
    assert.equal(state.counts.complete,1);assert.equal(state.counts.candidate,1);
    assert.equal(state.items[2].state,'processing');assert.equal(restarted.status(run.id).budget.generationPosts,0);
  }finally{f.close();}
});

test('batch reason chooses failed, unknown or current waiting stages and ignores successful extraction notes',()=>{
  const f=fixture();try{
    f.ids.slice(0,3).forEach(f.ready);const run=f.batch.create(f.ids.slice(0,3)),original=f.deps.statusDigest;
    f.deps.statusDigest=id=>{const value=original(id),index=f.ids.indexOf(id),state=index===0?'failed':index===1?'result-unknown':'waiting-files';return{...value,request:{...value.request!,state},stages:[{name:'ocr',label:'OCR',state:'succeeded',required:true,attempts:1,error:'图片文字已保存，等待内容整理能力'},{name:'asr',label:'ASR',state:'not-required',required:false,attempts:0,error:'旧的无关提示'},{name:'organize',label:'整理',state:index===0?'failed':index===1?'result-unknown':'waiting-files',required:true,attempts:0,error:index===0?'本条请求超过输入范围':index===1?'远端结果未知':'固定来源文件缺失'}]};};
    const state=f.batch.status(run.id);assert.equal(state.items[0].reason,'本条请求超过输入范围');assert.equal(state.items[1].reason,'远端结果未知');assert.equal(state.items[2].reason,'固定来源文件缺失');
    assert.deepEqual(state.items.map(item=>item.state),['failed','result-unknown','processing']);
  }finally{f.close();}
});

test('graceful pause lets the submitted call persist, dispatches nothing else, then resumes without repeating it',async()=>{
  const f=fixture();f.ids.slice(0,2).forEach(f.ready);const run=f.batch.create(f.ids.slice(0,2));let release!:()=>void,calls=0,held=false;const wait=new Promise<void>(resolve=>{release=resolve;}),runner=new GenerationRunner(f.generation,provider({onCall:()=>{calls++;},beforeOrganize:async()=>{if(!held){held=true;await wait;}}}),{networkAllowed:true,batch:f.batch.hooks('generation')});
  try{runner.start();await until(()=>calls===1);f.batch.pause(run.id);release();await until(()=>f.generation.status(f.ids[0]).tasks.some(task=>task.stage==='organize'&&task.state==='succeeded'));await delay(30);assert.equal(calls,1);assert.equal(f.batch.status(run.id).state,'paused');f.batch.resume(run.id);runner.kick();await until(()=>f.batch.status(run.id).state==='complete');assert.equal(calls,4);assert.equal(f.batch.status(run.id).budget.generationPosts,4);}finally{release();runner.stop();f.close();}
});

test('unknown calls remain unknown on batch retry/resume; finite failed retry is one per item',async()=>{
  const f=fixture();f.ready(f.ids[0]);const run=f.batch.create([f.ids[0]]),runner=new GenerationRunner(f.generation,{...provider(),async organize(input){input.onSubmit();throw Object.assign(Error('fixture timeout'),{code:'timeout',submitted:true});}},{networkAllowed:true,batch:f.batch.hooks('generation')});
  try{runner.start();await until(()=>f.batch.status(run.id).counts['result-unknown']===1);assert.throws(()=>f.batch.retry(run.id,f.ids[0]),/未知/);f.batch.resume(run.id);runner.kick();await delay(30);assert.equal(f.batch.status(run.id).budget.generationPosts,1);assert.equal(f.batch.status(run.id).counts['result-unknown'],1);f.batch.cancelItem(run.id,f.ids[0]);assert.equal(f.batch.status(run.id).counts['result-unknown'],1);}finally{runner.stop();f.close();}
});

test('batch source identity change never dispatches under another account',()=>{
  const f=fixture();try{const run=f.batch.create([f.ids[0]]);f.ready(f.ids[0]);f.store.db.prepare('UPDATE contents SET account_id=? WHERE id=?').run('different-account',f.ids[0]);f.batch.tick();assert.equal(f.batch.status(run.id).counts.failed,1);assert.equal(f.digest.status(f.ids[0]).request,null);}finally{f.close();}
});

test('E4.13: submissions are never budget-denied; a provider failure is recorded honestly',async()=>{
  const f=fixture();f.ready(f.ids[0]);const run=f.batch.create([f.ids[0]]),requestId=run.items[0].requestId!;
  for(let i=0;i<181;i++)f.batch.hooks('generation').submit({requestId,runId:`prior-${i}`},()=>{});
  let posts=0;const adapter=new SiliconFlowGenerationProvider({apiKey:()=> 'synthetic-only-key',networkAllowed:true,fetchImpl:(async(_url:unknown,init:RequestInit)=>{if(init.method==='POST'){posts++;throw Error('must not submit');}return new Response(JSON.stringify({object:'list',data:[{id:GENERATION_MODEL_POLICY.candidates[0].id}]}),{headers:{'content-type':'application/json'}});}) as typeof fetch});
  const runner=new GenerationRunner(f.generation,adapter,{networkAllowed:true,batch:f.batch.hooks('generation')});
  try{runner.start();await until(()=>f.batch.status(run.id).counts['result-unknown']===1);assert.equal(posts,1);assert.equal(f.batch.status(run.id).budget.generationPosts,182);}finally{runner.stop();f.close();}
});

test('one failed-item retry cannot start a third call or reset its budget',async()=>{
  const f=fixture();f.ready(f.ids[0]);const run=f.batch.create([f.ids[0]]);let calls=0;const runner=new GenerationRunner(f.generation,{...provider(),async organize(input){input.onSubmit();calls++;throw Object.assign(Error('fixture unavailable'),{code:'provider-error',submitted:true});}},{networkAllowed:true,batch:f.batch.hooks('generation')});
  try{runner.start();await until(()=>f.batch.status(run.id).counts.failed===1);f.batch.retry(run.id,f.ids[0]);runner.kick();await until(()=>calls===2&&f.batch.status(run.id).counts.failed===1);assert.throws(()=>f.batch.retry(run.id,f.ids[0]),/一次批次重试/);assert.equal(f.batch.status(run.id).budget.generationPosts,2);}finally{runner.stop();f.close();}
});

test('ASR runner prepares and submits only the selected batch and preserves old media jobs',async()=>{
  const f=fixture();
  for(const id of f.ids.slice(0,2)){f.store.db.prepare("UPDATE contents SET kind='video' WHERE id=?").run(id);f.store.detailSaved(id,{body:'视频简介',bodyComplete:true,mediaManifestComplete:true,media:[{kind:'video',remoteUrl:`https://example.invalid/${id}`,mime:'video/mp4',resourceKey:`video:${id}`,title:'P1'}]});const media=f.store.content(id)!.media[0],bytes=Buffer.from(`synthetic video ${id}`),file=`video-${id}.mp4`;writeFileSync(path.join(f.root,'media',file),bytes);f.store.downloadSaved(media.id,file,bytes.length,media.mime);}
  const asr=new AsrRepository(f.store.db,f.root,f.digest,ASR_PROVIDER_CONFIG),request=f.deps.requestDigest;
  f.deps.requestDigest=(id,renew)=>{const value=request(id,renew);asr.authorize(id,{preparationConfig:{version:'synthetic-pcm'}});return value;};
  f.digest.request(f.ids[0]);asr.authorize(f.ids[0],{preparationConfig:{version:'synthetic-pcm'}});
  const old=f.store.db.prepare('SELECT * FROM asr_media_jobs WHERE content_id=?').all(f.ids[0]);
  const run=f.batch.create([f.ids[1]]);let uploads=0;
  const runner=new AsrRunner(asr,{async probe(input){return{sha256:input.expectedSha256,bytes:input.expectedBytes,durationMs:1000};},async prepare(input){const bytes=Buffer.from('synthetic PCM'),localPath=path.join(input.outputDir,'part.wav');writeFileSync(localPath,bytes);return[{localPath,sha256:sha256(bytes),bytes:bytes.length,format:'wav',order:0,startMs:0,endMs:1000,durationMs:1000,configSha256:'a'.repeat(64)}];}},{configured:()=>true,async transcribe(input){await input.onUploadStart();uploads++;return{text:'合成转录文字，未联网',rawResponse:{text:'合成转录文字，未联网'}};}},ASR_PROVIDER_CONFIG,{networkAllowed:true,batch:f.batch.hooks('asr')});
  try{runner.start();await until(()=>asr.list(f.ids[1]).progress.succeeded===1);assert.equal(uploads,1);assert.equal(f.batch.status(run.id).budget.asrPosts,1);assert.deepEqual(f.store.db.prepare('SELECT * FROM asr_media_jobs WHERE content_id=?').all(f.ids[0]),old);assert.equal(f.batch.status(run.id).items[0].requestId,f.digest.status(f.ids[1]).request!.id);}finally{runner.stop();f.close();}
});

test('OCR batch filter prevents creation or claiming of unselected legacy jobs',()=>{
  const f=fixture();try{
    for(const id of f.ids.slice(0,2)){f.store.db.prepare("UPDATE contents SET kind='image' WHERE id=?").run(id);f.store.detailSaved(id,{body:'图片正文',bodyComplete:true,mediaManifestComplete:true,media:[{kind:'image',role:'gallery',remoteUrl:`https://example.invalid/${id}`,mime:'image/png',resourceKey:`image:${id}`} ]});const media=f.store.content(id)!.media[0],file=`image-${id}.png`;writeFileSync(path.join(f.root,'media',file),png);f.store.downloadSaved(media.id,file,png.length,media.mime);}
    const engine:OcrEngine={id:'apple-vision',version:'synthetic-filter',osVersion:'test',osBuild:'test',architecture:'test',revision:3,supportedRevisions:[3],supportedLanguages:['zh-Hans'],languages:['zh-Hans'],mode:'accurate',algorithm:'fixture',configSha256:'a'.repeat(64)},ocr=new OcrRepository(f.store.db,f.root,f.editor,f.digest);ocr.setCapability({available:true,engine});
    f.digest.request(f.ids[0]);const run=f.batch.create([f.ids[1]]),filter=f.batch.hooks('ocr').allowRequest;ocr.syncAuthorized(filter);
    assert.equal((f.store.db.prepare('SELECT count(*) n FROM ocr_jobs WHERE content_id=?').get(f.ids[0]) as any).n,0);
    const token=ocr.nextInspection(engine,filter)??ocr.next(engine,filter);assert.ok(token);assert.equal(token.contentId,f.ids[1]);assert.equal(token.requestId,run.items[0].requestId);assert.equal(ocr.next(engine,filter),null);
  }finally{f.close();}
});

test('batch ASR namespace is narrow and retains normalization restrictions',()=>{
  const base=path.resolve('.acceptance-data/batch-sync');assert.equal(isAsrPreparationNamespacePath(path.join(base,'e42-20261018-a1','data','asr-prepared')),true);
  for(const value of [path.join(base,'e43-a1','data'),path.join(base,'e42-','data'),path.join(base,'e42-..','data'),`${base}/e42-a/../other`,`${base}//e42-a/data`,`${base}/e42-a/data\n`])assert.equal(isAsrPreparationNamespacePath(value),false,value);
});
