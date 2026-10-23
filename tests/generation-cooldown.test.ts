import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { EditorRepository,migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { migrateAsrSchema } from '../src/main/asr-store.js';
import { GenerationRepository,migrateGenerationSchema } from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { GenerationRunner,type GenerationProviderAdapter } from '../src/main/generation-runner.js';
import { SiliconFlowGenerationProvider,GENERATION_MODEL_POLICY } from '../src/main/generation-provider.js';
import type { GenerationModelSelection } from '../src/shared/generation-contracts.js';

const model:GenerationModelSelection={provider:'siliconflow',model:'cooldown-fixture-no-service',discoveredAt:1,accountModelsSha256:'a'.repeat(64),publishedContextTokens:65536,providerOutputLimitTokens:null,inputBudgetUtf8Bytes:32000,maxOutputTokens:16384,applicationContextBudgetTokens:65536,responseFormat:'json_object',promptVersion:'read-create-source-grounded-v1',configurationSha256:'b'.repeat(64),capabilitySources:['synthetic fixture; zero real HTTP']};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,timeout=1500){const end=Date.now()+timeout;while(!check()){assert.ok(Date.now()<end,'condition did not become true before deadline');await sleep(5);}}
function fixture(count=1){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'generation-cooldown-')),store=new Store(root);
 const items=Array.from({length:count},(_,index)=>({sourceId:`cooldown-${index}`,title:`合成限流 ${index}`,author:'mechanism',url:`https://www.xiaohongshu.com/explore/cooldown-${index}`,kind:'text' as const,folderIds:[]}));
 store.saveSnapshot({platform:'xiaohongshu',accountId:'synthetic-only',accountName:'合成机制',folders:[],complete:true,items},items.map(item=>({item,discovery:'historical' as const})),1);
 const ids=items.map(item=>store.find('xiaohongshu','synthetic-only',item.sourceId)!);
 for(const [index,id]of ids.entries())store.detailSaved(id,{body:`合成正文 ${index}：只有满足条件时才可使用。`,bodyComplete:true,mediaManifestComplete:true,media:[]});
 migrateEditorSchema(store.db,root,{targetVersion:7});const editor=new EditorRepository(store.db,root);migrateAsrSchema(store.db,root);const digest=new DigestRepository(store.db,root,editor);migrateGenerationSchema(store.db,root);migrateE44Schema(store.db,root);const generation=new GenerationRepository(store.db,root,editor,digest);generation.setCapability(true,true);
 return{root,store,ids,editor,digest,generation,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
type Fixture=ReturnType<typeof fixture>;
function authorize(f:Fixture,id=f.ids[0]){f.digest.request(id);f.generation.authorize(id);f.generation.prepareReady();const pending=f.generation.pendingModel();assert.ok(pending);assert.equal(pending.contentId,id);f.generation.beginModelDiscovery(pending.requestId);f.generation.setModel(pending.requestId,model);}
function task(f:Fixture,id=f.ids[0]):{state:string;attempts:number;not_before:number}{return f.store.db.prepare('SELECT t.state,t.attempts,t.not_before FROM generation_tasks t JOIN generation_requests g ON g.request_id=t.request_id WHERE g.content_id=?').get(id) as ReturnType<typeof task>;}
function cooling(f:Fixture,delay:number,id=f.ids[0]){authorize(f,id);const token=f.generation.next()!;assert.equal(token.contentId,id);f.generation.markSubmitted(token);f.generation.fail(token,'rate-limit',true,delay);return task(f,id).not_before;}
function localProvider(calls:{contentRevision:string;at:number}[],onCall?:(input:Parameters<GenerationProviderAdapter['organize']>[0])=>Promise<never>):GenerationProviderAdapter{return{configured:()=>true,async discoverModel(){return model;},async ensureModel(value){return value;},async organize(input){input.onSubmit();calls.push({contentRevision:input.input.sourceRevisionId,at:Date.now()});if(onCall)return onCall(input);throw Object.assign(Error('synthetic provider failure'),{code:'provider-error',submitted:true});},async map(){throw Error('unexpected map dispatch');}};}

test('429 explicit retry yields the event loop, survives repeated kicks, and wakes once without an early paid POST',async(t)=>{
 const f=fixture();let gets=0,ensures=0;const posts:number[]=[];
 const provider=new SiliconFlowGenerationProvider({apiKey:()=> 'dummy-local-response-only',networkAllowed:true,fetchImpl:(async(_url:unknown,init:RequestInit)=>{if(init.method==='GET'){gets++;return new Response(JSON.stringify({object:'list',data:[{id:GENERATION_MODEL_POLICY.candidates[0].id}]}),{headers:{'content-type':'application/json'}});}posts.push(Date.now());return new Response(null,{status:posts.length===1?429:500,headers:posts.length===1?{'retry-after':'1'}:{}});}) as typeof fetch});
 const originalEnsure=provider.ensureModel.bind(provider);provider.ensureModel=async(...args)=>{ensures++;return originalEnsure(...args);};
 const runner=new GenerationRunner(f.generation,provider,{networkAllowed:true});
 try{
  f.digest.request(f.ids[0]);f.generation.authorize(f.ids[0]);runner.start();await until(()=>f.generation.status(f.ids[0]).tasks[0]?.errorCode==='rate-limit');
  const before=task(f),ensureBefore=ensures;assert.equal(before.attempts,1);assert.ok(before.not_before-Date.now()>500);assert.equal(f.generation.nextWakeAt(),null,'a failed task is not an automatic retry');
  f.generation.retry(f.ids[0]);assert.equal(f.generation.pendingVerification(),null);assert.equal(f.generation.next(),null);assert.equal(f.generation.nextWakeAt(),before.not_before);
  const start=Date.now(),timerDelay=await new Promise<number>(resolve=>{setTimeout(()=>resolve(Date.now()-start),0);for(let i=0;i<200;i++)runner.kick();});
  const ensureCallsDuringCooldown=ensures-ensureBefore;assert.ok(timerDelay<1500,`zero-delay timer was starved for ${timerDelay}ms`);/* 200 synchronous kicks should finish in tens of ms; the bound only catches loop monopolisation and tolerates loaded CI runners */assert.equal(ensureCallsDuringCooldown,0);assert.equal(posts.length,1);assert.deepEqual(task(f),{state:'queued',attempts:1,not_before:before.not_before});
  const wake=(runner as unknown as {wake:ReturnType<typeof setTimeout>|null}).wake;assert.ok(wake);assert.equal(wake.hasRef(),false);
  await until(()=>posts.length===2);assert.ok(posts[1]>=before.not_before,'retry POST must respect persisted cooldown');assert.equal(gets,1);assert.equal(task(f).attempts,2);
  const exhaustedEnsures=ensures;f.generation.retry(f.ids[0]);for(let i=0;i<20;i++)runner.kick();await sleep(30);assert.equal(posts.length,2);assert.equal(ensures,exhaustedEnsures);assert.equal(f.generation.nextWakeAt(),null);assert.equal(task(f).attempts,2);
  t.diagnostic(JSON.stringify({realHttp:0,injectedGets:gets,injectedPosts:posts.length,repeatedKicks:200,zeroTimerDelayMs:timerDelay,ensureCallsDuringCooldown,retryPostAfterDeadlineMs:posts[1]-before.not_before,paidAttempts:task(f).attempts}));
 }finally{runner.stop();f.close();}
});

test('an expired cooldown without explicit retry does not authorize another call',async()=>{
 const f=fixture(),calls:{contentRevision:string;at:number}[]=[],runner=new GenerationRunner(f.generation,localProvider(calls),{networkAllowed:true});
 try{const due=cooling(f,60);runner.start();await sleep(100);for(let i=0;i<10;i++)runner.kick();assert.ok(Date.now()>=due);assert.equal(calls.length,0);assert.equal(task(f).state,'failed');assert.equal(task(f).attempts,1);assert.equal(task(f).not_before,due);assert.equal(f.generation.pendingVerification(),null);assert.equal(f.generation.nextWakeAt(),null);}finally{runner.stop();f.close();}
});

test('a cooling first request cannot block a different due request',async()=>{
 const f=fixture(2),calls:{contentRevision:string;at:number}[]=[],runner=new GenerationRunner(f.generation,localProvider(calls),{networkAllowed:true});
 try{
  const due=cooling(f,180);f.generation.retry(f.ids[0]);authorize(f,f.ids[1]);const firstRevision=f.digest.internalScope(f.generation.status(f.ids[0]).requestId!).input.revisionId,secondRevision=f.digest.internalScope(f.generation.status(f.ids[1]).requestId!).input.revisionId;
  assert.equal(f.generation.pendingVerification()!.contentId,f.ids[1]);runner.start();await until(()=>calls.some(call=>call.contentRevision===secondRevision));assert.ok(calls[0].at<due);assert.equal(calls[0].contentRevision,secondRevision);assert.equal(task(f).attempts,1);
  await until(()=>calls.length===2);assert.equal(calls[1].contentRevision,firstRevision);assert.ok(calls[1].at>=due);assert.equal(task(f).attempts,2);assert.equal(task(f,f.ids[1]).attempts,1);
 }finally{runner.stop();f.close();}
});

test('timer callbacks can cancel, stop, or disable networking during cooldown and pending wakes are cancelled',async()=>{
 for(const action of ['cancel','stop','offline'] as const){const f=fixture(),calls:{contentRevision:string;at:number}[]=[],runner=new GenerationRunner(f.generation,localProvider(calls),{networkAllowed:true});try{
  const due=cooling(f,120);f.generation.retry(f.ids[0]);runner.start();const start=Date.now();await new Promise<void>(resolve=>setTimeout(()=>{if(action==='cancel')runner.cancel(f.ids[0]);else if(action==='stop')runner.stop();else runner.setNetworkAllowed(false);resolve();},5));
  assert.ok(Date.now()-start<80,`${action} signal must be processed during cooldown`);assert.equal((runner as unknown as {wake:unknown}).wake,null);assert.equal(task(f).not_before,due);assert.equal(task(f).attempts,1);await sleep(Math.max(0,due-Date.now())+25);assert.equal(calls.length,0);assert.equal(task(f).attempts,1);
  if(action==='stop'){runner.start();await until(()=>calls.length===1);}else if(action==='offline'){runner.setNetworkAllowed(true);await until(()=>calls.length===1);}else{assert.equal(task(f).state,'cancelled');runner.kick();await sleep(10);assert.equal(calls.length,0);}
 }finally{runner.stop();f.close();}}
});

test('restart preserves not_before and only resumes the retry explicitly queued before restart',async()=>{
 const f=fixture(2),calls:{contentRevision:string;at:number}[]=[];let runner:GenerationRunner|undefined;
 try{
  const due=cooling(f,100);f.generation.retry(f.ids[0]);const failedDue=cooling(f,100,f.ids[1]);const wantedRevision=f.digest.internalScope(f.generation.status(f.ids[0]).requestId!).input.revisionId;
  f.generation=new GenerationRepository(f.store.db,f.root,f.editor,f.digest);runner=new GenerationRunner(f.generation,localProvider(calls),{networkAllowed:true});runner.start();assert.equal(task(f).not_before,due);assert.equal(task(f,f.ids[1]).not_before,failedDue);assert.equal(calls.length,0);
  await until(()=>calls.length===1);await sleep(30);assert.equal(calls[0].contentRevision,wantedRevision);assert.ok(calls[0].at>=due);assert.equal(task(f).attempts,2);assert.equal(task(f,f.ids[1]).attempts,1);assert.equal(task(f,f.ids[1]).state,'failed');
 }finally{runner?.stop();f.close();}
});

test('stop and network revocation after a cooled retry submits preserve unknown results and the two-call cap through restart',async()=>{
 for(const action of ['stop','offline'] as const){const f=fixture(),calls:{contentRevision:string;at:number}[]=[];let runner:GenerationRunner|undefined,restartedRunner:GenerationRunner|undefined;try{
  cooling(f,50);f.generation.retry(f.ids[0]);const provider=localProvider(calls,input=>new Promise<never>((_resolve,reject)=>{input.signal.addEventListener('abort',()=>reject(Object.assign(Error('synthetic aborted response'),{code:'result-unknown',submitted:true})),{once:true});}));runner=new GenerationRunner(f.generation,provider,{networkAllowed:true});runner.start();await until(()=>calls.length===1);assert.equal(task(f).attempts,2);
  if(action==='stop')runner.stop();else runner.setNetworkAllowed(false);await sleep(5);assert.equal(task(f).state,'result-unknown');assert.equal(task(f).attempts,2);runner.stop();
  f.generation=new GenerationRepository(f.store.db,f.root,f.editor,f.digest);restartedRunner=new GenerationRunner(f.generation,localProvider(calls),{networkAllowed:true});restartedRunner.start();f.generation.retry(f.ids[0]);restartedRunner.kick();await sleep(15);assert.equal(task(f).state,'result-unknown');assert.equal(calls.length,1);
  f.generation.retry(f.ids[0],true);restartedRunner.kick();await sleep(15);assert.equal(task(f).attempts,2);assert.equal(calls.length,1);assert.equal(f.generation.nextWakeAt(),null);restartedRunner.cancel(f.ids[0]);assert.equal(task(f).state,'cancelled');assert.equal(task(f).attempts,2);
 }finally{runner?.stop();restartedRunner?.stop();f.close();}}
});
