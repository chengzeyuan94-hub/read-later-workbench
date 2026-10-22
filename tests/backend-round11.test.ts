import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { xhsVideoDescriptor } from '../src/main/source-detail.js';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CollectionItem, CollectionSnapshot, Connection, DetailResult, MediaDescriptor, SourceAdapter } from '../src/shared/contracts.js';
import { Store } from '../src/main/store.js';
import { WorkbenchService } from '../src/main/service.js';

const NOW=Date.parse('2026-10-17T13:00:00+08:00');
const item=(id:string,folders=['saved']):CollectionItem=>({sourceId:id,title:id,author:'synthetic fixture',url:`https://fixture.invalid/${id}`,kind:'video',folderIds:folders});
const detail:DetailResult={body:'real fixture body',bodyComplete:true,mediaManifestComplete:true,adapterVersion:2,media:[]};
function snapshot(ids:string[], options:{reliable?:boolean; account?:string; complete?:boolean; pages?:CollectionSnapshot['recent']; scope?:string}={}):CollectionSnapshot {
  const scopeId=options.scope??'saved';
  return {platform:'xiaohongshu',accountId:options.account??'fixture',accountName:'fixture',folders:[{id:scopeId,title:scopeId}],items:ids.map(id=>item(id,[scopeId])),complete:options.complete??false,
    recent:options.pages??{scopes:[{scopeId,reliable:options.reliable??true,sort:'collection-order',orderedIds:ids,reason:'synthetic ordered first page',pages:[{cursor:'',nextCursor:null,ids,parsed:true}]}]}};
}
async function fixture(collect:()=>Promise<CollectionSnapshot>, options:Partial<ConstructorParameters<typeof WorkbenchService>[2]>={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-round11-'));
  const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect,detail:async()=>detail}],{connections:()=>[],now:()=>NOW,fetch:async()=>new Response('file',{headers:{'Content-Type':'video/mp4'}}),...options});
  return {dir,service,cleanup:async()=>{service.close();await rm(dir,{recursive:true,force:true});}};
}
async function sync(service:WorkbenchService){await service.sync();await service.waitForIdle();}

test('reliable recent checkpoint establishes baseline independently of partial history, then confirms only unseen prefix',async()=>{
  let current=snapshot(['a','b','c']);const f=await fixture(async()=>current);
  try{
    await sync(f.service);assert.equal(f.service.state().syncs[0].incrementalStatus,'baseline');assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length,0);
    assert.equal(f.service.store.account('xiaohongshu','fixture')?.complete,false);
    current=snapshot(['new','a','b','c']);await sync(f.service);
    assert.deepEqual(f.service.state().recent.filter(c => c.discovery === 'new').map(c => c.sourceId),['new']);assert.equal(f.service.state().syncs[0].state,'partial');assert.equal(f.service.state().syncs[0].incrementalStatus,'confirmed');
    await sync(f.service);assert.equal(f.service.state().contents.length,4);assert.equal(f.service.state().syncs[0].saved,0);
    assert.deepEqual(f.service.store.checkpoint('xiaohongshu','fixture','saved'),['new','a','b','c']);
  }finally{await f.cleanup();}
});

test('old observed IDs do not create a checkpoint or upgrade unknown; first reliable head only establishes baseline',async()=>{
  let current=snapshot(['a','b'],{reliable:false});const f=await fixture(async()=>current);
  try{
    await sync(f.service);assert.equal(f.service.store.checkpoint('xiaohongshu','fixture','saved'),undefined);
    current=snapshot(['unknown','a','b'],{reliable:false});await sync(f.service);
    current=snapshot(['unknown','a','b']);await sync(f.service);
    assert.equal(f.service.state().contents.find(c=>c.sourceId==='unknown')?.discovery,'unknown');assert.equal(f.service.state().syncs[0].incrementalStatus,'baseline');
    current=snapshot(['confirmed','unknown','a','b']);await sync(f.service);
    assert.deepEqual(f.service.state().recent.filter(c => c.discovery === 'new').map(c => c.sourceId),['confirmed']);
  }finally{await f.cleanup();}
});

test('damaged head, cursor gap, anchor mismatch and reordered old IDs do not contaminate last good checkpoint',async()=>{
  let current=snapshot(['a','b','c']);const f=await fixture(async()=>current);
  try{
    await sync(f.service);
    const cases=[snapshot(['badhead','a','b'],{reliable:false}),snapshot(['gap','a','b'],{pages:{scopes:[{scopeId:'saved',reliable:true,sort:'collection-order',orderedIds:['gap','a','b'],reason:'gap fixture',pages:[{cursor:'',nextCursor:'next',ids:['gap'],parsed:true},{cursor:'wrong',nextCursor:null,ids:['a','b'],parsed:true}]}]}}),snapshot(['missing','other']),snapshot(['reordered','a','c','b'])];
    for(const value of cases){current=value;await sync(f.service);assert.equal(f.service.state().syncs[0].incrementalStatus,'unknown');assert.deepEqual(f.service.store.checkpoint('xiaohongshu','fixture','saved'),['a','b','c']);assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length,0);}
    current=snapshot(['fresh','a','b','c']);await sync(f.service);assert.deepEqual(f.service.state().recent.filter(c => c.discovery === 'new').map(c => c.sourceId),['fresh']);
  }finally{await f.cleanup();}
});

test('tail failure permits a trustworthy continuous head while account and new scope first checks remain baseline',async()=>{
  let current=snapshot(['a','b','c']);const f=await fixture(async()=>current);
  try{
    await sync(f.service);
    current=snapshot(['n','a','b'],{pages:{scopes:[{scopeId:'saved',reliable:true,sort:'collection-order',orderedIds:['n','a','b'],reason:'tail failed after trustworthy prefix',pages:[{cursor:'',nextCursor:'c1',ids:['n','a'],parsed:true},{cursor:'c1',nextCursor:'c2',ids:['b'],parsed:true}]}]}});await sync(f.service);
    assert.equal(f.service.state().contents.find(c=>c.sourceId==='n')?.discovery,'new');
    current=snapshot(['other-account','a','b'],{account:'second'});await sync(f.service);assert.equal(f.service.state().syncs[0].incrementalStatus,'baseline');assert.notEqual(f.service.state().contents.find(c=>c.sourceId==='other-account')?.discovery,'new');
    current=snapshot(['old-in-new-folder','a','b'],{scope:'new-folder'});await sync(f.service);assert.equal(f.service.state().syncs[0].incrementalStatus,'baseline');assert.equal(f.service.state().contents.find(c=>c.sourceId==='old-in-new-folder')?.discovery,'unknown');
  }finally{await f.cleanup();}
});

test('resume intent survives old failed collect lock and repeated resume events coalesce to exactly one follow-up',async()=>{
  let rejectFirst!:(e:Error)=>void;const first=new Promise<void>((_,reject)=>{rejectFirst=reject;});let calls=0,active=0,maxActive=0;
  const f=await fixture(async()=>{calls++;active++;maxActive=Math.max(active,maxActive);try{if(calls===1)await first;return snapshot(['a','b']);}finally{active--;}});
  try{
    const started=f.service.sync();f.service.pause();f.service.resume();f.service.pause();f.service.resume();rejectFirst(new Error('Network offline'));
    await started;await f.service.waitForIdle();assert.equal(calls,2);assert.equal(maxActive,1);
    assert.deepEqual(f.service.state().syncs.map(s=>s.state),['partial','failed']);assert.equal(f.service.state().syncs[0].trigger,'resume');assert.deepEqual(f.service.state().scheduler?.pending,[]);
  }finally{await f.cleanup();}
});

test('disabled auto sync suppresses recovery collection while preserving explicit manual sync',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return snapshot(['a','b']);});
  try{f.service.autoSync(false);f.service.pause();f.service.resume();f.service.setOnline(false);f.service.setOnline(true);await f.service.waitForIdle();assert.equal(calls,0);await sync(f.service);assert.equal(calls,1);assert.equal(f.service.state().scheduler?.nextCheckAt,null);}finally{await f.cleanup();}
});

test('only fresh verified login clears authentication error; cancelling or stale verified connection cannot clear it',async()=>{
  let connection:Connection={platform:'xiaohongshu',state:'expired',method:'fixture',message:'expired'};
  const f=await fixture(async()=>{throw new Error('LOGIN_REQUIRED');},{connections:()=>[connection]});
  try{
    await sync(f.service);connection={...connection,state:'connected',message:'window closed'};assert.equal(f.service.state().connections[0].state,'expired');
    connection={...connection,verifiedAt:NOW-1};assert.equal(f.service.state().connections[0].state,'expired');
    connection={...connection,verifiedAt:NOW+1};assert.equal(f.service.state().connections[0].state,'connected');assert.equal(f.service.state().syncs.length,1);
  }finally{await f.cleanup();}
});

async function storeFixture(){const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-round11-store-'));const store=new Store(dir);const value=snapshot(['v']);store.saveSnapshot(value,[{item:value.items[0],discovery:'historical'}],NOW);return{dir,store,id:store.contents()[0].id,cleanup:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};}
const video=(url:string,order=1,title='P1',version='original'):MediaDescriptor=>({kind:'video',remoteUrl:url,resourceKey:`bili:cid-${order}:mp4:qn32`,sourceIdentity:`cid-${order}`,version,order,title});
async function savedFile(f:Awaited<ReturnType<typeof storeFixture>>,mediaId:number,body='video'){const name=`${mediaId}.mp4`;await writeFile(path.join(f.dir,'media',name),body);f.store.downloadSaved(mediaId,name,Buffer.byteLength(body),'video/mp4');}

test('failed subtitle/body refresh preserves source text, saved subtitles and edited draft',async()=>{
  const f=await storeFixture();try{
    f.store.detailSaved(f.id,{...detail,body:'original',subtitle:'saved subtitle',subtitleStatus:'valid'});f.store.db.prepare('UPDATE contents SET edited_body=? WHERE id=?').run('user edit',f.id);
    f.store.detailSaved(f.id,{...detail,body:'',bodyComplete:false,bodyStatus:'unavailable',subtitle:'',subtitleStatus:'unavailable'});
    let value=f.store.content(f.id)!;assert.equal(value.body,'original');assert.equal(value.bodyComplete,true);assert.equal(value.subtitle,'saved subtitle');assert.equal((f.store.db.prepare('SELECT edited_body FROM contents WHERE id=?').get(f.id) as any).edited_body,'user edit');
    f.store.detailSaved(f.id,{...detail,subtitle:''});assert.equal(f.store.content(f.id)!.subtitle,'saved subtitle');
    f.store.detailSaved(f.id,{...detail,subtitle:'replacement',subtitleStatus:'valid'});assert.equal(f.store.content(f.id)!.subtitle,'replacement');
  }finally{await f.cleanup();}
});

test('stable media identity reuses verified success across CDN and signature changes without a queued duplicate',async()=>{
  const f=await storeFixture();try{
    f.store.detailSaved(f.id,{...detail,media:[video('https://cdn-one.invalid/path-a?trid=old&upsig=old')]});const old=f.store.content(f.id)!.media[0];await savedFile(f,old.id);
    f.store.detailSaved(f.id,{...detail,media:[video('https://cdn-two.invalid/path-b?trid=new&upsig=new')]});const value=f.store.content(f.id)!;
    assert.equal(value.media.length,1);assert.equal(value.media[0].id,old.id);assert.equal(value.offline,true);assert.equal(f.store.nextDownload(),undefined);assert.equal(await readFile(path.join(f.dir,'media',value.media[0].localPath!),'utf8'),'video');
  }finally{await f.cleanup();}
});

test('legacy signature changes reuse saved path and recovered P1 is ordered before already successful P2',async()=>{
  const f=await storeFixture();try{
    f.store.detailSaved(f.id,{...detail,bodyComplete:false,mediaManifestComplete:false,media:[{kind:'video',remoteUrl:'https://old.invalid/P2.mp4?trid=old'}]});const p2=f.store.content(f.id)!.media[0];await savedFile(f,p2.id,'part2');
    f.store.detailSaved(f.id,{...detail,media:[{kind:'video',remoteUrl:'https://new.invalid/P1.mp4?trid=one'},{kind:'video',remoteUrl:'https://new.invalid/P2.mp4?trid=new'}]});
    const value=f.store.content(f.id)!;assert.equal(value.media.length,2);assert.equal(value.media[1].id,p2.id);assert.equal(value.media[1].state,'succeeded');assert.equal(value.media[0].order,0);assert.equal(value.media[1].order,1);
    await savedFile(f,value.media[0].id,'part1');assert.equal(f.store.content(f.id)!.offline,true);
  }finally{await f.cleanup();}
});

test('different resource versions retain historical originals but only current manifest determines offline and player order',async()=>{
  const f=await storeFixture();try{
    const url='https://fixture.invalid/video.mp4';f.store.detailSaved(f.id,{...detail,media:[video(url,1,'P1','v1')]});const old=f.store.content(f.id)!.media[0];await savedFile(f,old.id,'old');
    f.store.detailSaved(f.id,{...detail,media:[video(url,1,'P1 revised','v2')]});let value=f.store.content(f.id)!;assert.equal(value.media.length,1);assert.notEqual(value.media[0].id,old.id);assert.equal(value.offline,false);assert.equal(f.store.media(old.id)?.current,false);assert.equal(await readFile(path.join(f.dir,'media',old.localPath??`${old.id}.mp4`),'utf8'),'old');
    await savedFile(f,value.media[0].id,'new');value=f.store.content(f.id)!;assert.equal(value.offline,true);assert.equal(value.media[0].title,'P1 revised');
  }finally{await f.cleanup();}
});

test('missing/size-mismatched local success is not offline and retries while forced decode repair preserves original file',async()=>{
  const f=await storeFixture();try{
    f.store.detailSaved(f.id,{...detail,media:[video('https://fixture.invalid/video.mp4')]});const original=f.store.content(f.id)!.media[0];await savedFile(f,original.id,'good');assert.equal(f.store.content(f.id)!.offline,true);
    await writeFile(path.join(f.dir,'media',`${original.id}.mp4`),'corrupt-size');assert.equal(f.store.content(f.id)!.offline,false);f.store.retry(f.id);assert.equal(f.store.content(f.id)!.media[0].state,'queued');
    await savedFile(f,original.id,'bad');f.store.retry(f.id,original.id);const replacement=f.store.content(f.id)!.media[0];assert.notEqual(replacement.id,original.id);assert.equal(f.store.media(original.id)?.current,false);assert.equal(await readFile(path.join(f.dir,'media',`${original.id}.mp4`),'utf8'),'bad');
    f.store.detailSaved(f.id,{...detail,media:[video('https://fixture.invalid/video.mp4?new=sign')]});assert.equal(f.store.content(f.id)!.media[0].id,replacement.id);await savedFile(f,replacement.id,'fixed');assert.equal(f.store.content(f.id)!.offline,true);
    assert.throws(()=>f.store.retry(f.id,999),/不属于/);
  }finally{await f.cleanup();}
});

test('v1 migration snapshots consistently, preserves identity/digest/edited/files and repairs legacy missing-video once across restarts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-round11-migration-'));await writeFile(path.join(dir,'unused'),'fixture');
  const binding=path.resolve('.runtime/node24.node');const old=new Database(path.join(dir,'workbench.sqlite'),{nativeBinding:binding});
  old.exec(`CREATE TABLE contents (id INTEGER PRIMARY KEY,platform TEXT NOT NULL,account_id TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,url TEXT NOT NULL,kind TEXT NOT NULL,published_at INTEGER,collected_at INTEGER,first_discovered_at INTEGER NOT NULL,discovery TEXT NOT NULL,source_body TEXT NOT NULL DEFAULT '',edited_body TEXT,body_complete INTEGER NOT NULL DEFAULT 0,subtitle TEXT NOT NULL DEFAULT '',detail_state TEXT NOT NULL DEFAULT 'queued',detail_error TEXT,digested_at INTEGER,last_reviewed_at INTEGER,UNIQUE(platform,account_id,source_id));
    CREATE TABLE media(id INTEGER PRIMARY KEY,content_id INTEGER NOT NULL,kind TEXT NOT NULL,remote_url TEXT NOT NULL,referer TEXT,mime TEXT NOT NULL DEFAULT 'application/octet-stream',state TEXT NOT NULL DEFAULT 'queued',local_path TEXT,bytes INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(content_id,remote_url));
    INSERT INTO contents(id,platform,account_id,source_id,title,author,url,kind,first_discovered_at,discovery,source_body,edited_body,body_complete,subtitle,detail_state,digested_at) VALUES(1,'xiaohongshu','old','saved','saved','fixture','https://fixture.invalid/1','video',1,'historical','saved body','user edit',1,'saved subtitle','succeeded',123),(2,'xiaohongshu','old','broken','broken','fixture','https://fixture.invalid/2','video',2,'historical','retained description',NULL,0,'','succeeded',NULL);
    INSERT INTO media(id,content_id,kind,remote_url,mime,state,local_path,bytes)VALUES(1,1,'video','https://fixture.invalid/a.mp4','video/mp4','succeeded','1.mp4',5);
    PRAGMA user_version=1;`);old.close();
  let store=new Store(dir);
  try{
    await writeFile(path.join(dir,'media','1.mp4'),'saved');assert.equal(store.content(1)?.offline,true);assert.equal(store.content(1)?.digestedAt,123);assert.equal(store.content(1)?.subtitle,'saved subtitle');assert.equal((store.db.prepare('SELECT edited_body FROM contents WHERE id=1').get() as any).edited_body,'user edit');assert.equal(store.content(2)?.detailState,'queued');assert.equal(store.content(2)?.repairState,'queued');
    const backup=store.setting('migrationBackup','');assert.ok(backup.endsWith('.sqlite'));const archived=new Database(backup,{nativeBinding:binding,readonly:true});assert.equal(archived.pragma('user_version',{simple:true}),1);assert.equal((archived.prepare('SELECT count(*) AS n FROM contents').get() as any).n,2);archived.close();
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM fixed_batch').get() as any).n,2);store.detailRunning(2);store.detailFailed(2,'明确不支持格式');assert.equal(store.content(2)?.repairAttempts,1);store.close();store=new Store(dir);
    assert.equal(store.content(2)?.detailState,'failed');assert.equal(store.content(2)?.repairAttempts,1);assert.equal(store.content(1)?.offline,true);assert.equal((await readdir(dir)).filter(f=>f.startsWith('workbench-pre-v4')).length,1);assert.equal(await readFile(path.join(dir,'media','1.mp4'),'utf8'),'saved');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('checkpoint and first discovery persist across restart without making an already unknown object new',async()=>{
  let current=snapshot(['a','b']);const f=await fixture(async()=>current);let restarted:WorkbenchService|undefined;
  try{
    await sync(f.service);current=snapshot(['unknown','a','b'],{reliable:false});await sync(f.service);f.service.close();
    restarted=new WorkbenchService(f.dir,[{platform:'xiaohongshu',collect:async()=>snapshot(['fresh','a','b']),detail:async()=>detail}],{connections:()=>[],now:()=>NOW+1000});
    await sync(restarted);assert.deepEqual(restarted.state().recent.filter(c => c.discovery === 'new').map(c => c.sourceId),['fresh']);assert.equal(restarted.state().contents.find(c=>c.sourceId==='unknown')?.firstDiscoveredAt,NOW);assert.equal(restarted.state().contents.find(c=>c.sourceId==='unknown')?.discovery,'unknown');
  }finally{restarted?.close();await f.cleanup();}
});

test('checkpoint, observations and content commit atomically when saving a collected snapshot fails',async()=>{
  let current=snapshot(['a','b']);const f=await fixture(async()=>current);
  try{
    await sync(f.service);const original=f.service.store.saveSnapshot.bind(f.service.store);
    f.service.store.saveSnapshot=(...args)=>{original(...args);throw new Error('Injected storage failure after content writes');};
    current=snapshot(['new','a','b']);await f.service.sync();assert.equal(f.service.state().syncs[0].state,'failed');assert.match(f.service.state().syncs[0].message,/已回滚/);assert.equal(f.service.state().syncs[0].failed,1);
    assert.deepEqual(f.service.store.checkpoint('xiaohongshu','fixture','saved'),['a','b']);assert.equal(f.service.store.known('xiaohongshu','fixture').has('new'),false);assert.equal(f.service.store.find('xiaohongshu','fixture','new'),undefined);
    f.service.store.saveSnapshot=original;await sync(f.service);assert.equal(f.service.store.content(f.service.store.find('xiaohongshu','fixture','new')!)?.discovery,'new');
  }finally{await f.cleanup();}
});


test('known old IDs moved before checkpoint anchor cannot make an unseen neighbour new or advance checkpoint',async()=>{
  let current=snapshot(['a','b','c']);const f=await fixture(async()=>current);
  try{
    await sync(f.service);current=snapshot(['c','unseen','a','b']);await sync(f.service);
    assert.equal(f.service.state().syncs[0].incrementalStatus,'unknown');assert.equal(f.service.state().contents.find(c=>c.sourceId==='unseen')?.discovery,'unknown');assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length,0);
    assert.deepEqual(f.service.store.checkpoint('xiaohongshu','fixture','saved'),['a','b','c']);
  }finally{await f.cleanup();}
});

test('v3 B站 metadata repair is bounded, preserves files and applies actual P titles and order without redownloading',async()=>{
  const f=await storeFixture();let store=f.store;
  try{
    // Produce a saved legacy P2-before-P1 manifest in an isolated database.
    store.db.prepare("UPDATE contents SET platform='bilibili',adapter_version=0,detail_state='succeeded',body_complete=1,manifest_complete=1 WHERE id=?").run(f.id);
    store.db.prepare("INSERT INTO media(content_id,kind,remote_url,mime,state,local_path,bytes,media_order,current) VALUES(?,'video',?,'video/mp4','succeeded',?,2,?,1)").run(f.id,'https://old.invalid/p2.mp4?trid=old','p2.mp4',0);
    store.db.prepare("INSERT INTO media(content_id,kind,remote_url,mime,state,local_path,bytes,media_order,current) VALUES(?,'video',?,'video/mp4','succeeded',?,2,?,1)").run(f.id,'https://old.invalid/p1.mp4?trid=old','p1.mp4',1);
    await writeFile(path.join(f.dir,'media','p1.mp4'),'P1');await writeFile(path.join(f.dir,'media','p2.mp4'),'P2');
    store.db.pragma('user_version=3');store.close();store=new Store(f.dir);
    assert.equal(store.content(f.id)?.detailState,'queued');assert.equal(store.content(f.id)?.repairState,'queued');assert.equal(store.content(f.id)?.repairAttempts,0);assert.ok(store.setting('migrationBackup','').includes('pre-v4'));
    store.detailRunning(f.id);store.detailSaved(f.id,{...detail,media:[video('https://new.invalid/p1.mp4?trid=new',1,'P1 actual'),video('https://new.invalid/p2.mp4?trid=new',2,'P2 actual')]});
    const content=store.content(f.id)!;assert.deepEqual(content.media.map(m=>m.title),['P1 actual','P2 actual']);assert.deepEqual(content.media.map(m=>m.localPath),['p1.mp4','p2.mp4']);assert.ok(content.media.every(m=>!!m.resourceKey));assert.equal(store.nextDownload(),undefined);assert.equal(content.repairAttempts,1);assert.equal(content.repairState,'succeeded');assert.equal(content.offline,true);
    store.close();store=new Store(f.dir);assert.equal(store.content(f.id)?.detailState,'succeeded');assert.equal(store.content(f.id)?.repairAttempts,1);assert.equal(await readFile(path.join(f.dir,'media','p2.mp4'),'utf8'),'P2');
  }finally{store.close();await f.cleanup();}
});

test('legacy B站 repair failure or confirmed unavailable result does not automatically requeue on restart',async()=>{
  for(const terminal of ['failed','unavailable'] as const){
    const f=await storeFixture();let store=f.store;
    try{
      store.db.prepare("UPDATE contents SET platform='bilibili',adapter_version=0,detail_state='failed' WHERE id=?").run(f.id);store.db.pragma('user_version=3');store.close();store=new Store(f.dir);
      assert.equal(store.content(f.id)?.detailState,'queued');store.detailRunning(f.id);
      if(terminal==='failed')store.detailFailed(f.id,'网络失败，可重试');
      else store.detailSaved(f.id,{...detail,body:'',bodyComplete:false,bodyStatus:'unavailable',mediaManifestComplete:false,availability:'unavailable',manifestError:'内容明确不可访问'});
      const state=store.content(f.id)!;assert.equal(state.repairAttempts,1);assert.equal(state.repairState,'failed');store.close();store=new Store(f.dir);
      assert.equal(store.content(f.id)?.repairAttempts,1);assert.notEqual(store.content(f.id)?.detailState,'queued');assert.equal(store.nextDetail(),undefined);
    }finally{store.close();await f.cleanup();}
  }
});


test('explicit retry failures queues each failed content once, leaves complete files and has no automatic retry loop',async()=>{
  const f=await storeFixture();try{
    const items=['repair','media','complete'].map(id=>item(id));const snap=snapshot(items.map(i=>i.sourceId));
    f.store.saveSnapshot(snap,items.map(item=>({item,discovery:'historical'})),NOW);
    const repair=f.store.find('xiaohongshu','fixture','repair')!,failed=f.store.find('xiaohongshu','fixture','media')!,complete=f.store.find('xiaohongshu','fixture','complete')!;
    f.store.db.prepare("UPDATE contents SET detail_state='failed',repair_state='failed',repair_attempts=1 WHERE id=?").run(repair);
    f.store.detailSaved(failed,{...detail,media:[video('https://fixture.invalid/fail')]});f.store.downloadFailed(f.store.content(failed)!.media[0].id,'fixture failure');
    f.store.detailSaved(complete,{...detail,media:[video('https://fixture.invalid/complete')]});await savedFile(f,f.store.content(complete)!.media[0].id,'complete');
    assert.equal(f.store.retryFailures(),2);assert.equal(f.store.content(repair)?.repairState,'queued');assert.equal(f.store.content(repair)?.repairAttempts,1);assert.equal(f.store.content(failed)?.detailState,'queued');assert.equal(f.store.content(complete)?.offline,true);
    assert.equal(f.store.retryFailures(),0);assert.equal(f.store.content(repair)?.repairAttempts,1);
  }finally{await f.cleanup();}
});


function oldXhsVideo(url:string,sourceIdentity:string):MediaDescriptor {
  const hash=createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0,24);
  const version=`h264:720x1280:800000:${hash}`;
  return{kind:'video',mime:'video/mp4',remoteUrl:url,resourceKey:`xiaohongshu:v:video:${version}`,sourceIdentity,version,role:'main',order:0,title:'原视频'};
}
const newXhsVideo=(url:string,extra:Record<string,unknown>={})=>xhsVideoDescriptor('v',url,'https://www.xiaohongshu.com/explore/v',{videoId:'reliable-platform-video-id',videoCodec:'h264',width:720,height:1280,videoBitrate:800000,format:'mp4',...extra});

test('old adapter2 XHS path-hash key adopts current video identity without redownloading at matching canonical location and rendition',async()=>{
  const f=await storeFixture();try{
    const url='https://old.xhscdn.com/signed-path/video.mp4?signature=old';
    const hash=createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0,24);
    f.store.detailSaved(f.id,{...detail,media:[oldXhsVideo(url,`note:v:video:${hash}`)]});const old=f.store.content(f.id)!.media[0];await savedFile(f,old.id,'original-video');
    f.store.detailSaved(f.id,{...detail,media:[newXhsVideo('https://new.xhscdn.com/signed-path/video.mp4?signature=fresh')]});
    let content=f.store.content(f.id)!;assert.equal(content.media.length,1);assert.equal(content.media[0].id,old.id);assert.equal(content.offline,true);assert.equal(f.store.nextDownload(),undefined);assert.ok(content.media[0].resourceKey?.includes(':video:'));
    // After bounded adoption, ordinary identity matching survives timed path signatures too.
    f.store.detailSaved(f.id,{...detail,media:[newXhsVideo('https://another.xhscdn.com/new-signed-path/video.mp4?signature=later')]});
    content=f.store.content(f.id)!;assert.equal(content.media[0].id,old.id);assert.equal(content.media.length,1);assert.equal(content.offline,true);assert.equal(f.store.nextDownload(),undefined);assert.equal(await readFile(path.join(f.dir,'media',content.media[0].localPath!),'utf8'),'original-video');
  }finally{await f.cleanup();}
});

test('old XHS path-hash version with a reliable platform videoId adopts across signed path changes at the same rendition',async()=>{
  const f=await storeFixture();try{
    f.store.detailSaved(f.id,{...detail,media:[oldXhsVideo('https://old.xhscdn.com/old-signed-path/video.mp4','note:v:video:reliable-platform-video-id')]});const old=f.store.content(f.id)!.media[0];await savedFile(f,old.id);
    f.store.detailSaved(f.id,{...detail,media:[newXhsVideo('https://new.xhscdn.com/new-signed-path/video.mp4')]});const content=f.store.content(f.id)!;
    assert.equal(content.media[0].id,old.id);assert.equal(content.media.length,1);assert.equal(content.offline,true);assert.equal(f.store.nextDownload(),undefined);
  }finally{await f.cleanup();}
});

test('legacy XHS adoption refuses changed rendition, changed reliable video identity and unproven path changes',async()=>{
  for(const scenario of ['rendition','identity','unproven-path','current-version'] as const){
    const f=await storeFixture();try{
      const url='https://old.xhscdn.com/original/video.mp4';const hash=createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0,24);
      const prior=scenario==='current-version'?newXhsVideo(url):oldXhsVideo(url,scenario==='unproven-path'?`note:v:video:${hash}`:'note:v:video:reliable-platform-video-id');
      f.store.detailSaved(f.id,{...detail,media:[prior]});const old=f.store.content(f.id)!.media[0];await savedFile(f,old.id);
      const next=scenario==='rendition'?newXhsVideo(url,{videoBitrate:1200000}):scenario==='identity'||scenario==='current-version'?newXhsVideo(url,{videoId:'a-different-platform-video-id'}):newXhsVideo('https://new.xhscdn.com/unproven-other/video.mp4');
      f.store.detailSaved(f.id,{...detail,media:[next]});const content=f.store.content(f.id)!;
      assert.notEqual(content.media[0].id,old.id,scenario);assert.equal(content.media[0].state,'queued',scenario);assert.equal(f.store.media(old.id)?.current,false);assert.equal(await readFile(path.join(f.dir,'media',`${old.id}.mp4`),'utf8'),'video');
    }finally{await f.cleanup();}
  }
});
