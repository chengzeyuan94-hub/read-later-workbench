import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url),guard=require('../scripts/e3-quality-fix-guard.cjs');
const sample={role:'image',contentId:42,oldRequestId:'old-exhausted-image',oldConfigurationSha256:'old-policy'};
function budget(){return{sample,requestId:'new-image',token:{contentId:42,requestId:'new-image',stage:'organize',taskId:'task',model:{provider:'deepseek',promptVersion:'read-create-quality-v2',configurationSha256:'new-policy'}},calls:Array.from({length:11},(_,i)=>({request_id:'old-'+i,stage:'organize',submitted:1})),tasks:[{id:'task',stage:'organize',state:'running',attempts:0}],links:{image:'new-image'}};}
test('quality continuation excludes old11 calls, permits only two new identities and caps submitted stage/sample/round',()=>{
 const b=budget();assert.doesNotThrow(()=>guard.assertBudget(b));
 b.calls.push({request_id:'new-image',stage:'organize',submitted:1});b.tasks[0].attempts=1;assert.doesNotThrow(()=>guard.assertBudget(b));
 b.calls.push({request_id:'new-image',stage:'organize',submitted:1});assert.throws(()=>guard.assertBudget(b),/stage completion/);
 const unknown=budget();unknown.tasks[0].state='result-unknown';assert.throws(()=>guard.assertBudget(unknown),/unknown/);
 const old=budget();old.requestId=sample.oldRequestId;old.token.requestId=old.requestId;old.links.image=old.requestId;assert.throws(()=>guard.assertBudget(old),/old exhausted/);
 const third=budget();Object.assign(third.links,{text:'new-text'});assert.throws(()=>guard.assertBudget(third));
 const full=budget();Object.assign(full.links,{video:'new-video'});full.calls.push(...Array.from({length:4},()=>({request_id:'new-image',stage:'map',submitted:1})),...Array.from({length:4},()=>({request_id:'new-video',stage:'map',submitted:1})));assert.throws(()=>guard.assertBudget(full),/round total/);
 const sampleFull=budget();sampleFull.calls.push(...Array.from({length:4},()=>({request_id:'new-image',stage:'map',submitted:1})));assert.throws(()=>guard.assertBudget(sampleFull),/sample completion/);
});
test('quality source gate keeps full ordered literal text and image scope; rejects reduction, changed raw text and changed strategy',()=>{
 const input={units:[{kind:'capturedSource',text:'原文 不是普遍结论。'},{kind:'ocr',text:'条件成立时 7岁。'}]},scope={input:{bodySha256:'body',media:[{id:136,sha256:'a',bytes:2,kind:'image'},{id:137,sha256:'b',bytes:3,kind:'image'}],ocrMediaIds:[136,137],requiresOCR:true}};
 const frozen={...sample,bodySha256:'body',media:scope.input.media.map(m=>({...m,partId:null})),units:guard.unitIdentities(input)};
 assert.doesNotThrow(()=>guard.assertInput(frozen,input,scope));
 assert.throws(()=>guard.assertInput(frozen,{units:input.units.slice(0,1)},scope));
 assert.throws(()=>guard.assertInput(frozen,{units:[input.units[0],{...input.units[1],text:'条件成立时 7 岁。'}]},scope));
 assert.throws(()=>guard.assertInput(frozen,input,{input:{...scope.input,ocrMediaIds:[136]}}));
 const old=budget();old.token.model.configurationSha256='old-policy';assert.throws(()=>guard.assertBudget(old),/distinct frozen identity/);
 for(const mode of ['quality-generate-image','quality-generate-video-retry'])assert.ok(guard.roleFor(mode));
 for(const mode of ['generate-image','quality-generate-text','quality-generate-image-retry-extra','../quality-generate-video'])assert.throws(()=>guard.roleFor(mode));
});
test('execution tools retain exact bytes before run and reject later changes, path aliases or the old r4 root',()=>{
 const project=mkdtempSync(path.resolve('.acceptance-data/editor-e3-real/quality-fix-tools-unit-'));
 mkdirSync(path.join(project,'scripts'));writeFileSync(path.join(project,'scripts/operator.cjs'),'// explicitly synthetic execution-byte fixture\n');
 const p=guard.paths(project);mkdirSync(p.root,{recursive:true});mkdirSync(p.build,{recursive:true});
 assert.equal(guard.resolve(project,p.root,p.build).root,p.root);assert.throws(()=>guard.resolve(project,p.source,p.build));assert.throws(()=>guard.resolve(project,p.root,path.join(project,'dist/editor-e3-real-r4')));
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
