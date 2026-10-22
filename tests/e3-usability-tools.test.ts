import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url),guard=require('../scripts/e3-usability-guard.cjs');
const sample={role:'image',contentId:42,oldRequestId:'old-exhausted-image',oldConfigurationSha256:'old-policy'};
function budget(){return{sample,requestId:'new-image',token:{contentId:42,requestId:'new-image',stage:'organize',taskId:'task',model:{provider:'deepseek',promptVersion:'read-create-usability-v3',configurationSha256:'new-policy'}},baselineRunIds:Array.from({length:15},(_,i)=>'old-'+i),calls:Array.from({length:15},(_,i)=>({run_id:'old-'+i,request_id:'old-request-'+i,stage:'organize',submitted:1,status:'invalid-output'})),tasks:[{id:'task',stage:'organize',state:'running',attempts:0}],links:{image:'new-image'},requests:[{request_id:'new-image',content_id:42}]};}
const submitted=(id:string,request_id:string,stage='organize',status='succeeded')=>({run_id:id,request_id,stage,submitted:1,status});
test('usability budget excludes exact old15 and caps all new submitted calls across requests and restarts',()=>{
 const b=budget();assert.doesNotThrow(()=>guard.assertBudget(b));
 b.calls.push(submitted('first','new-image'));b.tasks[0].attempts=1;assert.doesNotThrow(()=>guard.assertBudget(b));
 b.calls.push(submitted('second','new-image'));assert.throws(()=>guard.assertBudget(b),/stage completion/);
 const replacement=budget();replacement.requests.push({request_id:'superseded-image',content_id:42});replacement.links.image=['superseded-image','new-image'] as any;replacement.calls.push(submitted('former1','superseded-image'),submitted('former2','superseded-image'));assert.throws(()=>guard.assertBudget(replacement),/stage completion/);
 const unknown=budget();unknown.calls.push(submitted('unknown','new-image','map','result-unknown'));assert.throws(()=>guard.assertBudget(unknown),/unknown/);
 const unknownTask=budget();unknownTask.tasks[0].state='result-unknown';assert.throws(()=>guard.assertBudget(unknownTask),/unknown/);
 const old=budget();old.requestId=sample.oldRequestId;old.token.requestId=old.requestId;old.links.image=old.requestId;assert.throws(()=>guard.assertBudget(old),/old exhausted/);
 const foreign=budget();foreign.calls.push(submitted('foreign','other-content'));foreign.requests.push({request_id:'other-content',content_id:44});assert.throws(()=>guard.assertBudget(foreign),/unlinked/);
 const relabeled=budget();relabeled.requests[0].content_id=16;relabeled.calls.push(submitted('wrong-source','new-image'));assert.throws(()=>guard.assertBudget(relabeled),/ownership/);
 const full=budget();Object.assign(full.links,{video:'new-video'});full.requests.push({request_id:'new-video',content_id:16});full.calls.push(...Array.from({length:4},(_,i)=>submitted('i'+i,'new-image','map')),...Array.from({length:4},(_,i)=>submitted('v'+i,'new-video','map')));assert.throws(()=>guard.assertBudget(full),/round total/);
 const sampleFull=budget();sampleFull.calls.push(...Array.from({length:4},(_,i)=>submitted('i'+i,'new-image','map')));assert.throws(()=>guard.assertBudget(sampleFull),/sample completion/);
 const incompleteBaseline=budget();incompleteBaseline.baselineRunIds.pop();assert.throws(()=>guard.assertBudget(incompleteBaseline),/old15/);
});
test('full source gate rejects shortened text, missing image or a reused previous policy',()=>{
 const input={units:[{kind:'capturedSource',text:'原文保持条件与出处。'},{kind:'ocr',text:'图片一的完整识别资料。'},{kind:'ocr',text:'图片二的完整识别资料。'}]},scope={input:{bodySha256:'body',media:[{id:136,sha256:'a',bytes:2,kind:'image'},{id:137,sha256:'b',bytes:3,kind:'image'}],ocrMediaIds:[136,137],requiresOCR:true}};
 const frozen={...sample,bodySha256:'body',media:scope.input.media.map(media=>({...media,partId:null})),units:guard.unitIdentities(input)};
 assert.doesNotThrow(()=>guard.assertInput(frozen,input,scope));
 assert.throws(()=>guard.assertInput(frozen,{units:input.units.slice(0,2)},scope));
 assert.throws(()=>guard.assertInput(frozen,{units:[...input.units.slice(0,2),{...input.units[2],text:'截短。'}]},scope));
 assert.throws(()=>guard.assertInput(frozen,input,{input:{...scope.input,ocrMediaIds:[136]}}));
 const same=budget();same.token.model.configurationSha256='old-policy';assert.throws(()=>guard.assertBudget(same),/distinct frozen identity/);
 const obsolete=budget();obsolete.token.model.promptVersion='read-create-quality-v2';assert.throws(()=>guard.assertBudget(obsolete));
 for(const mode of ['usability-generate-image','usability-generate-video-retry'])assert.ok(guard.roleFor(mode));
 for(const mode of ['quality-generate-image','usability-generate-text','../usability-generate-video'])assert.throws(()=>guard.roleFor(mode));
});
test('execution tools retain exact bytes before run and reject later changes, path aliases or the sealed source root',()=>{
 const project=mkdtempSync(path.resolve('.acceptance-data/editor-e3-real/usability-tools-unit-'));
 mkdirSync(path.join(project,'scripts'));writeFileSync(path.join(project,'scripts/operator.cjs'),'// explicitly synthetic execution-byte fixture\n');
 const p=guard.paths(project);mkdirSync(p.root,{recursive:true});mkdirSync(p.build,{recursive:true});
 assert.equal(guard.resolve(project,p.root,p.build).root,p.root);assert.throws(()=>guard.resolve(project,p.source,p.build));assert.throws(()=>guard.resolve(project,p.root,path.join(project,'dist/editor-e3-real-r4')));
 const terminalBuild=path.join(project,'dist/editor-e3-real-usability-a2');mkdirSync(terminalBuild);assert.equal(guard.resolve(project,p.root,terminalBuild).build,terminalBuild);
 const records=guard.freezeSources(project,path.join(p.root,'evidence/execution-sources/one'),['scripts/operator.cjs']);assert.equal(records.length,1);assert.equal(readFileSync(path.join(project,records[0].snapshot),'utf8'),'// explicitly synthetic execution-byte fixture\n');assert.doesNotThrow(()=>guard.verifySources(project,records));
 writeFileSync(path.join(project,'scripts/operator.cjs'),'// changed after freezing\n');assert.throws(()=>guard.verifySources(project,records),/source changed/);
 symlinkSync(path.join(project,'scripts/operator.cjs'),path.join(project,'scripts/alias.cjs'));assert.throws(()=>guard.freezeSources(project,path.join(p.root,'evidence/execution-sources/two'),['scripts/alias.cjs']),/symlinks/);
});
test('exact transcript cache must still resolve to the original complete media22/P/range, never another P or a correction',()=>{
 const text='字'.repeat(2314),unit={kind:'transcript',text,reference:{revision:1}},trace={mediaId:'22',partId:'cid:42709551979',inputSource:{kind:'plain-text-response',rawText:text},inputRange:{startMs:0,endMs:393787},timing:{state:'unknown'}},sample={role:'video'};
 assert.doesNotThrow(()=>guard.assertUnitSource(sample,unit,{selectedText:text,transcript:trace}));
 for(const replacement of [{partId:'cid:other'},{mediaId:'another-media'},{inputRange:{startMs:0,endMs:390000}},{inputSource:{kind:'manual-correction',rawText:text}},{timing:{state:'known'}}])assert.throws(()=>guard.assertUnitSource(sample,unit,{selectedText:text,transcript:{...trace,...replacement}}));
 assert.throws(()=>guard.assertUnitSource(sample,{...unit,reference:{revision:2}},{selectedText:text,transcript:trace}));
});
