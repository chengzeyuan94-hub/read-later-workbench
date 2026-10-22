import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkbenchService} from '../src/main/service.js';
import {classifyFailure} from '../src/main/batch-failure.js';
import type {CollectionItem,CollectionSnapshot,Platform,SourceAdapter} from '../src/shared/contracts.js';

const item=(id:string):CollectionItem=>({sourceId:id,title:id,author:'fixture',url:'https://fixture.invalid/'+id,kind:'text',folderIds:['saved'],collectedAt:100});
const snapshot=(platform:Platform,ids:string[],account='fixture'):CollectionSnapshot=>({platform,accountId:account,accountName:'fixture',folders:[{id:'saved',title:'saved'}],items:ids.map(item),complete:false,target:{limit:100,complete:true,reliable:true,reason:'fixture head'}});
const options={connections:()=>[],recentImport:{batchId:'e45-batch',limit:100}};
const img=(key:string,kind:'image'|'video'='image')=>({kind,remoteUrl:'https://fixture.invalid/'+key,mime:kind==='image'?'image/png':'video/mp4',resourceKey:key});
const detailOf=(key:string,kind:'image'|'video'='image')=>({body:'fixture body',bodyComplete:true,mediaManifestComplete:true,media:[img(key,kind)]});
const okImage=async()=>new Response('image',{headers:{'content-type':'image/png'}});
const tick=async(ms=40)=>new Promise(r=>setTimeout(r,ms));
const until=async(fn:()=>boolean,rounds=200)=>{for(let i=0;i<rounds&&!fn();i++)await tick(25);assert.ok(fn(),'等待超时');};
const lane=(service:WorkbenchService,platform:Platform)=>service.state().recentSync!.lanes!.find(l=>l.platform===platform)!;

test('classifyFailure maps realistic errors and persisted safeError text',()=>{
 assert.equal(classifyFailure(new Error('LOGIN_REQUIRED：未登录'),'media'),'auth');
 assert.equal(classifyFailure(new Error('HTTP 401'),'detail'),'auth');
 assert.equal(classifyFailure({code:-101},'collect'),'auth');
 assert.equal(classifyFailure(new Error('登录失效，请在设置中重新登录后重试'),'media'),'auth');
 assert.equal(classifyFailure(new Error('ACCOUNT_CHANGED：fixture'),'media'),'account-changed');
 assert.equal(classifyFailure(new Error('HTTP 403'),'media'),'expired-url');
 assert.equal(classifyFailure(new Error('HTTP 404'),'media'),'expired-url');
 assert.equal(classifyFailure(new Error('平台访问受限或资源地址已过期，请稍后重试以刷新地址'),'media'),'expired-url');
 assert.equal(classifyFailure(new Error('HTTP 403'),'detail'),'rate-limit');
 assert.equal(classifyFailure(new Error('HTTP 429'),'collect'),'rate-limit');
 assert.equal(classifyFailure(new Error('平台暂时限流，请稍后重试'),'detail'),'rate-limit');
 assert.equal(classifyFailure(new Error('风控校验失败'),'collect'),'rate-limit');
 assert.equal(classifyFailure(new Error('内容失效，不可访问'),'media'),'permanent');
 assert.equal(classifyFailure(new Error('格式不支持'),'media'),'permanent');
 assert.equal(classifyFailure(new Error('ENOTFOUND fixture.invalid'),'media'),'transient');
 assert.equal(classifyFailure(new Error('网络连接失败，请恢复网络后重试'),'detail'),'transient');
 assert.equal(classifyFailure(new Error('DOWNLOAD_IDLE_TIMEOUT'),'media'),'transient');
});

test('lanes cap one detail and two images per platform while a second platform progresses independently',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-lanes-'));
 let xhsDetails=0,xhsDetailsMax=0,biliMedia=0;
 const release:(()=>void)[]=[];const gate=()=>new Promise<Response>(r=>release.push(()=>r(new Response('image',{headers:{'content-type':'image/png'}}))));
 const service=new WorkbenchService(dir,[
  {platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['x1','x2','x3']),verifyAccount:async()=>{},detail:async c=>{xhsDetails++;xhsDetailsMax=Math.max(xhsDetailsMax,xhsDetails);await tick(60);xhsDetails--;return detailOf(c.sourceId);}},
  {platform:'bilibili',collect:async()=>snapshot('bilibili',['b1']),verifyAccount:async()=>{},detail:async()=>detailOf('b1')} as SourceAdapter,
 ],{...options,fetch:async(_u,_i,p)=>{if(p==='bilibili'){biliMedia++;return okImage();}return gate();}});
 try{
  await service.sync();
  await until(()=>service.state().contents.find(c=>c.sourceId==='b1')?.media[0]?.state==='succeeded',150);
  assert.ok(biliMedia===1,'the other platform finishes while xhs fetches wait');
  assert.ok(xhsDetailsMax<=1,'at most one detail per platform');
  await until(()=>release.length>=2,120);
  assert.equal(release.length,2,'at most two image downloads per platform lane');
  assert.equal(lane(service,'xiaohongshu').active.images,2);
  for(let i=0;i<300&&service.state().contents.some(c=>c.media.some(m=>m.state==='queued'||m.state==='running'));i++){
   for(const done of release.splice(0))done();await tick(40);
  }
  assert.ok(service.state().contents.every(c=>c.media.every(m=>m.state==='succeeded')));
  await service.waitForIdle();
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('a video occupies the whole platform media lane and global video cap is two',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-video-'));
 const service=new WorkbenchService(dir,[
  {platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['v1','v2']),verifyAccount:async()=>{},detail:async c=>detailOf(c.sourceId,'video')},
  {platform:'bilibili',collect:async()=>snapshot('bilibili',['w1','w2','w3']),verifyAccount:async()=>{},detail:async c=>detailOf(c.sourceId,'video')} as SourceAdapter,
 ],{...options,fetch:async()=>new Promise<Response>(()=>{})});
 try{
  await service.sync();
  await until(()=>lane(service,'xiaohongshu').active.videos===1&&lane(service,'bilibili').active.videos===1&&lane(service,'bilibili').queued.media===2,200);
  assert.equal(lane(service,'xiaohongshu').active.videos,1,'one video per platform lane');
  assert.equal(lane(service,'bilibili').active.videos,1,'second platform runs in parallel');
  assert.equal(service.state().recentSync!.lanes!.reduce((n,l)=>n+l.active.videos,0),2,'global video cap');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('an expired media URL refreshes its detail twice then cools the platform down',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-expired-'));let details=0,fetches=0;
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['a']),verifyAccount:async()=>{},detail:async()=>{details++;return detailOf('a');}}],
  {...options,fetch:async()=>{fetches++;return new Response('',{status:403});}});
 try{
  await service.sync();
  await until(()=>lane(service,'xiaohongshu').mode==='cooldown',300);
  assert.equal(details,3,'initial detail plus two refreshes');
  assert.equal(fetches,3,'each refresh reissues the media fetch');
  assert.equal(service.recentImport!.state().scopes[0].reason,'fixture head','platform is cooled, not hard-paused');
  assert.equal(service.state().contents[0].media[0].state,'queued','the media stays queued for after the cooldown');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('rate-limit cools down with growing levels, persists across restart, auto-resumes and resets on success',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-cooldown-'));let now=1_000_000,limited=true;
 const make=()=>new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>{if(limited)throw new Error('HTTP 429');return snapshot('xiaohongshu',['a']);},verifyAccount:async()=>{},detail:async()=>detailOf('a')}],{...options,now:()=>now,fetch:okImage});
 let service=make();
 try{
  await service.sync();
  assert.equal(lane(service,'xiaohongshu').mode,'cooldown');
  const first=lane(service,'xiaohongshu').until!;assert.ok(first>=now+2*60_000&&first<=now+144_001,'level 0 is two minutes plus up-to-20% jitter');
  // E4.9: a failure while the platform is already cooling is the same incident —
  // it must not escalate the level.
  await service.sync();assert.equal(lane(service,'xiaohongshu').until,first,'a failure during an active cooldown does not escalate');
  // Expiry keeps the level; the next failure after expiry escalates from it.
  now=first+1;await service.sync();assert.ok(lane(service,'xiaohongshu').until!>=now+5*60_000,'failing again after expiry reaches level 1');
  now=lane(service,'xiaohongshu').until!+1;await service.sync();assert.ok(lane(service,'xiaohongshu').until!>=now+15*60_000,'level 2');
  now=lane(service,'xiaohongshu').until!+1;await service.sync();assert.ok(lane(service,'xiaohongshu').until!>=now+30*60_000,'level 3');
  now=lane(service,'xiaohongshu').until!+1;await service.sync();
  assert.equal(lane(service,'xiaohongshu').mode,'paused','a fifth rate-limit without success hard-pauses');
  service.resumePlatform('xiaohongshu');assert.equal(service.state().recentSync!.lanes!.find(l=>l.platform==='xiaohongshu'),undefined);
  await service.sync();service.close();
  service=make();
  assert.equal(lane(service,'xiaohongshu').mode,'cooldown','cooldown survives a restart');
  now=lane(service,'xiaohongshu').until!+1;
  await until(()=>service.state().recentSync!.lanes!.find(l=>l.platform==='xiaohongshu')===undefined,120);
  limited=false;await service.sync();
  assert.equal(service.store.setting('batchCooldown:xiaohongshu',''),'','a successful collect resets the cooldown');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('an expired cooldown keeps its level; two hours without failure resets it',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-level-'));let now=1_000_000;
 const events:string[]=[];
 const make=()=>new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>{throw new Error('HTTP 429');},verifyAccount:async()=>{},detail:async()=>detailOf('a')}],{...options,now:()=>now,fetch:okImage,evidence:(event)=>{events.push(event);}});
 const service=make();
 try{
  await service.sync();
  const first=lane(service,'xiaohongshu').until!;
  const levelEvents=()=>events.filter(e=>e==='batch-platform-cooldown').length;
  assert.equal(levelEvents(),1);
  await service.sync();assert.equal(levelEvents(),1,'same-incident failures during cooldown log no new escalation');
  // Expire: the record keeps its level so the next failure escalates, not restarts.
  now=first+1;(service as any).expireWaits();(service as any).expireWaits();
  await service.sync();assert.ok(lane(service,'xiaohongshu').until!>=now+5*60_000,'next failure after expiry escalates from the kept level');
  assert.equal(levelEvents(),2);
  // Two quiet hours after the last failure forget the level entirely.
  now=lane(service,'xiaohongshu').until!+1;(service as any).expireWaits();
  now+=2*60*60*1000;(service as any).expireWaits();
  assert.equal(service.store.setting('batchCooldown:xiaohongshu',''),'','two quiet hours reset the escalation level');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('auth failures pause for relogin and auto-clear on verification; a wrong account stays paused',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-auth-'));let gate:'auth'|'changed'|'ok'='auth';
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['a']),verifyAccount:async()=>{if(gate==='auth')throw new Error('LOGIN_REQUIRED');if(gate==='changed')throw new Error('ACCOUNT_CHANGED：fixture');},detail:async()=>detailOf('a')}],{...options,fetch:okImage});
 try{
  await service.sync();await until(()=>lane(service,'xiaohongshu').mode==='login');
  gate='ok';service.loginVerified('xiaohongshu');
  await until(()=>service.state().contents[0].media[0].state==='succeeded',150);
  assert.equal(lane(service,'xiaohongshu').mode,'done');
  gate='changed';const broken=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-changed-'));
  const other=new WorkbenchService(broken,[{platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['a']),verifyAccount:async()=>{if(gate==='changed')throw new Error('ACCOUNT_CHANGED：fixture');},detail:async()=>detailOf('a')}],{...options,fetch:okImage});
  try{
   await other.sync();await until(()=>lane(other,'xiaohongshu').mode==='paused');
   assert.match(lane(other,'xiaohongshu').reason!,/切回原账号/);
   other.loginVerified('xiaohongshu');await tick(120);
   assert.equal(lane(other,'xiaohongshu').mode,'paused','a mismatching verification does not clear the pause');
   gate='ok';other.loginVerified('xiaohongshu');
   await until(()=>lane(other,'xiaohongshu').mode!=='paused',150);
  }finally{other.close();await rm(broken,{recursive:true,force:true});}
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('transient failures back off per item then fail; five in a row escalate to cooldown',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-transient-'));let now=1_000_000;
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['t1','t2','t3','t4','t5','t6']),verifyAccount:async()=>{},detail:async()=>{throw new Error('ENOTFOUND fixture.invalid');}}],{...options,now:()=>now,fetch:okImage});
 try{
  await service.sync();
  await until(()=>lane(service,'xiaohongshu').mode==='cooldown',400);
  assert.equal(service.store.setting('batchCooldown:xiaohongshu','').length>0,true,'five consecutive transients escalate');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('a timed-out detail counts as transient with a recorded retry',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-dtimeout-'));
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['a']),detail:async()=>new Promise(()=>{})}],{...options,detailTimeoutMs:60,fetch:okImage});
 try{
  await service.sync();
  await until(()=>service.recentImport!.retryState(`detail:${service.state().contents[0].id}`).attempts===1,150);
  assert.equal(service.state().contents[0].detailState,'queued');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('a collect timeout is a transient sync failure, not a platform pause',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-ctimeout-'));
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>new Promise<CollectionSnapshot>(()=>{}),detail:async()=>detailOf('a')}],{...options,collectTimeoutMs:60});
 try{
  await service.sync();
  assert.equal(service.state().syncs[0].state,'failed');
  assert.equal(service.state().recentSync!.scopes.length,0,'a transient collect failure never pauses the platform');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('timer syncs skip cooling platforms and record it; manual syncs still attempt and a success resets',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-skip-'));let now=1_000_000,collects=0,limited=true;
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>{collects++;if(limited)throw new Error('HTTP 429');return snapshot('xiaohongshu',['a']);},detail:async()=>detailOf('a')}],{...options,now:()=>now,fetch:okImage});
 try{
  await service.sync();assert.equal(lane(service,'xiaohongshu').mode,'cooldown');
  const before=collects;await service.sync(undefined,'timer');
  assert.equal(collects,before,'timer never touches a cooling platform');
  assert.equal(service.state().syncs[0].state,'partial');
  assert.match(service.state().syncs[0].message!,/已跳过/);
  limited=false;await service.sync();
  assert.equal(collects,before+1,'manual sync still attempts the platform');
  assert.equal(service.store.setting('batchCooldown:xiaohongshu',''),'');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('startup clears pre-E4.5 pauses but keeps auth pauses',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e45-migrate-'));const evidence:string[]=[];
 const adapters:SourceAdapter[]=[
  {platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['a']),detail:async()=>detailOf('a')},
  {platform:'bilibili',collect:async()=>snapshot('bilibili',['b']),detail:async()=>detailOf('b')},
 ];
 let service:WorkbenchService|undefined=new WorkbenchService(dir,adapters,{...options,evidence:e=>evidence.push(e)});
 try{
  await service.sync();service.pauseDownloads();
  service.recentImport!.pausePlatform('xiaohongshu','平台暂时限流，请稍后重试');
  service.recentImport!.pausePlatform('bilibili','登录失效');
  service.store.setSetting('batchPause:bilibili',JSON.stringify({kind:'auth',reason:'登录失效',at:1}));
  service.close();service=undefined;
  service=new WorkbenchService(dir,adapters,{...options,evidence:e=>evidence.push(e)});
  const paused=service.recentImport!.pausedScopes().map(s=>s.platform);
  assert.deepEqual(paused,['bilibili'],'only the auth pause survives; the legacy rate-limit pause is cleared once');
  assert.ok(evidence.includes('batch-pause-migrated'));
  assert.equal(lane(service,'bilibili').mode,'login');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});
