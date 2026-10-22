/** Fixed, finite continuation contract. No application, DB, credential or network access. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const ROUND='e3-generation-usability-20261018-v1';
const names=Object.freeze({source:'quality-fix-20261018-a1',target:'usability-20261018-a1',build:'editor-e3-real-usability-a1'});
const roles=Object.freeze({image:{contentId:42,mediaIds:[136,137]},video:{contentId:16,mediaIds:[22],partId:'cid:42709551979',startMs:0,endMs:393787,transcriptCodePoints:2314}});
function canonical(file,mustExist=false){assert.ok(path.isAbsolute(file)&&path.normalize(file)===file);let part=path.parse(file).root;for(const segment of file.slice(part.length).split(path.sep)){part=path.join(part,segment);try{assert.ok(!fs.lstatSync(part).isSymbolicLink(),'usability continuation refuses symlinks');}catch(error){if(error.code!=='ENOENT')throw error;}}if(fs.existsSync(file))assert.equal(fs.realpathSync(file),file);else assert.equal(mustExist,false);return file;}
function paths(project=process.cwd()){canonical(project,true);const base=path.join(project,'.acceptance-data/editor-e3-real');return{project,source:path.join(base,names.source),root:path.join(base,names.target),build:path.join(project,'dist',names.build),tooling:path.join(base,'usability-tooling-20261018-a1')};}
function resolve(project,root,build){const p=paths(project);assert.equal(root,p.root,'only the new usability root is writable');assert.ok([p.build,path.join(project,'dist/editor-e3-real-usability-a2')].includes(build),'only the independent usability builds may start');canonical(root,true);canonical(build,true);return{...p,build};}
function roleFor(mode){const role=/^usability-generate-(image|video)(?:-retry)?$/.exec(mode||'')?.[1];assert.ok(role&&roles[role],'only the two approved source roles may run');return role;}
const unitIdentities=input=>input.units.map(unit=>({kind:unit.kind,textSha256:hash(unit.text),codePoints:[...unit.text].length}));
function assertUnitSource(sample,unit,resolved){assert.equal(resolved.selectedText,unit.text);if(unit.kind==='ocr'){assert.equal(sample.role,'image');assert.equal(resolved.ocr?.contentId,42);assert.ok([136,137].includes(resolved.ocr?.mediaId));assert.equal(resolved.ocr?.correctionRevision,undefined);}if(unit.kind==='transcript'){assert.equal(sample.role,'video');assert.equal(unit.reference.revision,1);const trace=resolved.transcript;assert.equal(trace?.mediaId,'22');assert.equal(trace?.partId,'cid:42709551979');assert.equal(trace?.inputSource.kind,'plain-text-response');assert.equal(trace?.inputSource.rawText,unit.text);assert.equal(trace?.inputRange?.startMs,0);assert.equal(trace?.inputRange?.endMs,393787);assert.equal(trace?.timing.state,'unknown');assert.equal([...unit.text].length,2314);}}
function assertInput(sample,input,scope){assert.equal(scope.input.bodySha256,sample.bodySha256);assert.deepEqual(scope.input.media.map(m=>({id:m.id,sha256:m.sha256,bytes:m.bytes,kind:m.kind,partId:m.partId??null})),sample.media);assert.deepEqual(unitIdentities(input),sample.units,'same complete source text/order; new policy must not shorten or change the frozen material');if(sample.role==='image'){assert.deepEqual(scope.input.ocrMediaIds,[136,137]);assert.equal(scope.input.requiresOCR,true);}else{assert.equal(scope.input.requiresASR,true);assert.equal(input.units.filter(u=>u.kind==='transcript').reduce((n,u)=>n+[...u.text].length,0),2314);}}
/** Counts every new submitted run in the sole writable round root. Unknown
 * outcomes stay in that set; a replacement request cannot reset any budget. */
function assertBudget({sample,requestId,token,calls,tasks,links,baselineRunIds,requests}){
 assert.equal(token.contentId,sample.contentId);assert.equal(token.requestId,requestId);
 assert.notEqual(requestId,sample.oldRequestId,'old exhausted request is never retried');
 assert.equal(token.model.provider,'deepseek');assert.equal(token.model.promptVersion,'read-create-usability-v3');
 assert.ok(token.model.configurationSha256!==sample.oldConfigurationSha256,'new usability policy must have a distinct frozen identity');
 assert.ok(['organize','map'].includes(token.stage));
 assert.ok(Array.isArray(baselineRunIds)&&baselineRunIds.length===15&&new Set(baselineRunIds).size===15,'exact old15 ledger identities required');
 assert.ok(Array.isArray(requests),'request ownership is required for cross-request budgets');
 assert.ok(Object.keys(links).every(role=>Object.hasOwn(roles,role)));
 const linked=Object.entries(links).flatMap(([role,value])=>(Array.isArray(value)?value:[value]).map(id=>({role,id})));
 assert.equal(new Set(linked.map(link=>link.id)).size,linked.length,'request identity cannot belong to two roles');
 assert.ok(linked.some(link=>link.role===sample.role&&link.id===requestId),'current request must be explicitly linked to this round');
 const baseline=new Set(baselineRunIds),newCalls=calls.filter(call=>!baseline.has(call.run_id));
 for(const call of newCalls){const owner=requests.find(row=>row.request_id===call.request_id),link=linked.find(row=>row.id===call.request_id);assert.ok(owner&&link,'unlinked new call is outside the finite round');assert.equal(owner.content_id,roles[link.role].contentId,'request source ownership cannot change');}
 const submitted=newCalls.filter(call=>call.submitted===1);
 assert.ok(submitted.length<8,'new round total completion budget exhausted');
 const sampleIds=requests.filter(row=>row.content_id===sample.contentId).map(row=>row.request_id);
 const sampleCalls=submitted.filter(call=>sampleIds.includes(call.request_id));
 assert.ok(sampleCalls.length<4,'sample completion budget exhausted across requests');
 assert.ok(sampleCalls.filter(call=>call.stage===token.stage).length<2,'stage completion budget exhausted across requests');
 assert.equal(tasks.filter(task=>task.stage===token.stage).length,1,'one frozen chunk per stage');
 const task=tasks.find(task=>task.id===token.taskId);assert.ok(task&&task.attempts<2);
 assert.ok(!newCalls.some(call=>call.status==='result-unknown'),'unknown paid result requires review, never automatic retry');
 assert.ok(!tasks.some(task=>task.state==='result-unknown'),'unknown paid result requires review, never automatic retry');
}
function freezeSources(project,directory,files){canonical(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});const records=[];for(const file of files){assert.ok(typeof file==='string'&&!path.isAbsolute(file)&&!file.split('/').includes('..'));const source=canonical(path.join(project,file),true),bytes=fs.readFileSync(source),sha256=hash(bytes),copy=path.join(directory,sha256+'-'+path.basename(file));if(fs.existsSync(copy))assert.equal(hash(fs.readFileSync(copy)),sha256);else fs.writeFileSync(copy,bytes,{flag:'wx',mode:0o600});assert.equal(hash(fs.readFileSync(source)),sha256);records.push({file,sha256,snapshot:path.relative(project,copy)});}return records;}
function verifySources(project,records){for(const record of records){assert.equal(hash(fs.readFileSync(canonical(path.join(project,record.file),true))),record.sha256,'reviewed tool source changed');assert.equal(hash(fs.readFileSync(canonical(path.join(project,record.snapshot),true))),record.sha256,'frozen execution source missing/changed');}}
module.exports={ROUND,names,roles,hash,canonical,paths,resolve,roleFor,unitIdentities,assertInput,assertUnitSource,assertBudget,freezeSources,verifySources};
