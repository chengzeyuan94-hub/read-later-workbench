import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkbenchService} from '../src/main/service.js';
import {Store} from '../src/main/store.js';
import {selectBiliRecent,requireSourceAccount,recentLimit} from '../src/main/source-collection.js';
import type {CollectionItem,CollectionSnapshot,SourceAdapter} from '../src/shared/contracts.js';
const item=(id:string,time=100,folder='saved'):CollectionItem=>({sourceId:id,title:id,author:'fixture',url:'https://fixture.invalid/'+id,kind:'text',folderIds:[folder],collectedAt:time});
const snapshot=(ids:string[],complete=true,account='fixture'):CollectionSnapshot=>({platform:'xiaohongshu',accountId:account,accountName:'fixture',folders:[{id:'saved',title:'saved'}],items:ids.map(id=>item(id)),complete:false,target:{limit:100,complete,reliable:true,reason:'fixture head'}});
const options={connections:()=>[],recentImport:{batchId:'test-batch',limit:100}};
const detail={body:'fixture body',bodyComplete:true,mediaManifestComplete:true,media:[]};

test('cross-folder merge selects account-wide newest unique IDs, preserves folders and does not invent dates',()=>{
 const result=selectBiliRecent([item('older',1,'a'),item('shared',10,'a'),item('new',30,'b'),item('shared',40,'b')],2);
 assert.deepEqual(result.items.map(i=>i.sourceId),['shared','new']);assert.deepEqual(result.items[0].folderIds,['a','b']);assert.equal(result.items[0].collectedAt,40);assert.equal(result.reliable,true);
 const missing=selectBiliRecent([{...item('no-date'),collectedAt:null,publishedAt:9999},item('dated',1)],2);assert.equal(missing.reliable,false);assert.equal(missing.items[0].sourceId,'dated');
 assert.throws(()=>recentLimit(101));assert.throws(()=>requireSourceAccount('other','fixture'),/ACCOUNT_CHANGED/);
});

test('recent import backfills observed history beyond legacy 15 without draining unrelated old queue; repeats stay idempotent',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-sync-'));let service:WorkbenchService|undefined;
 const ids=Array.from({length:100},(_,i)=>'source-'+i);const calls:string[]=[];
 try{
  const prior=new Store(dir);const old=snapshot([...ids,'outside'],false);prior.saveSnapshot(old,[{item:item('outside'),discovery:'historical'}],1);prior.db.close();
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async input=>{assert.equal(input?.recentLimit,100);return snapshot(ids);},detail:async(content,input)=>{assert.equal(input?.expectedAccountId,'fixture');calls.push(content.sourceId);return detail;}};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();await service.sync();
  assert.equal(service.state().contents.length,101);assert.equal(service.state().autoSync,true,'auto-sync follows the persisted setting in batch mode');assert.equal(service.state().syncs[0].saved,100);assert.equal(service.state().recentSync?.scopes[0].targetComplete,true);assert.equal(service.state().recentSync?.scopes[0].historyComplete,false);
  assert.equal(service.recentImport!.nextDetail()?.sourceId,'source-0');assert.throws(()=>service!.retry(service!.store.find('xiaohongshu','fixture','outside')!),/本轮/);
  await service.sync();assert.equal(service.state().contents.length,101);assert.equal(service.state().syncs[0].saved,0);assert.equal(calls.length,0);
  assert.equal(service.state().contents.find(c=>c.sourceId==='outside')?.detailState,'queued');
  service.close();service=undefined;
  service=new WorkbenchService(dir,[adapter],options);assert.equal(service.state().downloadsPaused,true);assert.equal(service.state().recentSync!.scopes[0].targetIds.length,100);
  assert.equal(service.recentImport!.nextDetail()?.sourceId,'source-0');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('completed batch accumulates its target across syncs and rejects a different account transactionally',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-account-'));let current=snapshot(['a','b']);
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>current,detail:async()=>detail}],options);service.pauseDownloads();
 try{
  // E4.7: the target accumulates — newly observed ids join the previous scope and
  // are saved as history (their collectedAt precedes the last sync window).
  await service.sync();current=snapshot(['new','a']);await service.sync();assert.deepEqual(service.state().recentSync!.scopes[0].targetIds,['a','b','new']);assert.deepEqual(service.state().recentSync!.scopes[0].observedIds,['new','a']);assert.notEqual(service.store.find('xiaohongshu','fixture','new'),undefined);
  assert.equal(service.state().contents.find(c=>c.sourceId==='new')?.discovery,'historical');
  current=snapshot(['intruder'],true,'different');await service.sync();assert.equal(service.state().syncs[0].state,'failed');assert.equal(service.store.find('xiaohongshu','different','intruder'),undefined);assert.equal(service.state().recentSync!.scopes[0].accountId,'fixture');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('target download queue skips unrelated media and verifies the pinned account before fetching',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-media-'));let requests=0,verifications=0;
 const mediaDetail={...detail,media:[{kind:'image' as const,remoteUrl:'https://fixture.invalid/image.png',mime:'image/png',resourceKey:'fixture-image'}]};
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot(['inside']),detail:async()=>mediaDetail,verifyAccount:async account=>{verifications++;assert.equal(account,'fixture');}}],{...options,fetch:async()=>{requests++;return new Response('fixture-image',{headers:{'content-type':'image/png'}});}});
 service.pauseDownloads();
 try{
  const outside=snapshot(['outside']);service.store.saveSnapshot(outside,[{item:item('outside'),discovery:'historical'}],1);service.store.detailSaved(service.store.find('xiaohongshu','fixture','outside')!,mediaDetail);
  await service.sync();service.resumeDownloads();await service.waitForIdle();
  assert.equal(requests,1);assert.equal(verifications,1);assert.equal(service.state().contents.find(c=>c.sourceId==='outside')!.media[0].state,'queued');
  assert.equal(service.state().contents.find(c=>c.sourceId==='inside')!.media[0].state,'succeeded');
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('download pause aborts the in-flight resource, requeues it and dispatches nothing until explicit resume',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-pause-'));let fetching=false,requests=0;
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot(['a','b']),verifyAccount:async()=>{},detail:async content=>({...detail,media:[{kind:'image',remoteUrl:'https://fixture.invalid/'+content.sourceId,resourceKey:content.sourceId}]})}],{...options,fetch:async()=>{requests++;if(requests===1){fetching=true;return new Promise<Response>(()=>{});}return new Response('image',{headers:{'content-type':'image/png'}});}});
 try{
  await service.sync();for(let i=0;i<100&&!fetching;i++)await new Promise(r=>setTimeout(r,10));assert.equal(fetching,true);
  service.pauseDownloads();await service.waitForIdle();
  assert.equal(requests,1);assert.equal(service.state().contents.find(c=>c.sourceId==='a')!.media[0].state,'queued');assert.equal(service.state().contents.find(c=>c.sourceId==='b')!.media[0].state,'queued');
  service.resumeDownloads();await service.waitForIdle();assert.equal(requests,3,'a is refetched after abort; b fetches once its detail lands');
  assert.equal(service.state().contents.every(c=>c.media.every(m=>m.state==='succeeded')),true);
 }finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('account mismatch before media fetch prevents network download and pauses only that platform target queue',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-wrong-account-'));let requests=0;
 const service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot(['a','b']),verifyAccount:async()=>{throw Error('ACCOUNT_CHANGED：fixture');},detail:async()=>({...detail,media:[{kind:'image',remoteUrl:'https://fixture.invalid/a',resourceKey:'a'}]})}],{...options,fetch:async()=>{requests++;return new Response('not-allowed');}});
 try{await service.sync();await service.waitForIdle();assert.equal(requests,0);assert.match(service.state().recentSync!.scopes[0].reason,/切回原账号/);assert.equal(service.state().contents.every(c=>c.media.every(m=>m.state==='queued')),true);}
 finally{service.close();await rm(dir,{recursive:true,force:true});}
});

test('actual Bilibili collector reads only each folder head and merges global latest100 without claiming full history',async()=>{
 const {readBiliFavorites}=await import('../src/main/source-collection.js');const pages:string[]=[];
 const rows=(folder:string)=>Array.from({length:300},(_,i)=>({id:folder==='a'?i+1:i+1001,bvid:'fixture',title:'fixture',fav_time:folder==='a'?10000-i:20000-i}));
 const result=await readBiliFavorites({recentLimit:100},{account:async()=>({mid:7,uname:'fixture'}),folders:async()=>({list:[{id:'a'},{id:'b'}]}),page:async(folder,page)=>{pages.push(folder+page);return {medias:rows(folder).slice((page-1)*40,page*40),has_more:true,info:{media_count:300}};}});
 assert.deepEqual(pages,['a1','a2','a3','b1','b2','b3']);assert.equal(result.items.length,100);assert.equal(result.items[0].sourceId,'av1001');assert.equal(result.items[99].sourceId,'av1100');assert.equal(result.target?.complete,true);assert.equal(result.complete,false);
});

test('Bilibili damaged folder and missing or reversed favorite times cannot be mislabeled as target-complete',async()=>{
 const {readBiliFavorites}=await import('../src/main/source-collection.js');
 const io={account:async()=>({mid:7,uname:'fixture'}),folders:async()=>({list:[{id:'a'}]}),page:async()=>({medias:[{id:1,fav_time:10},{id:2,fav_time:20}],has_more:false})};
 const reversed=await readBiliFavorites({recentLimit:100},io);assert.equal(reversed.target?.complete,false);assert.equal(reversed.target?.reliable,false);
 const failed=await readBiliFavorites({recentLimit:100},{...io,page:async()=>{throw Error('HTTP 429');}});assert.equal(failed.target?.complete,false);assert.equal(failed.complete,false);
 await assert.rejects(()=>readBiliFavorites({recentLimit:100,expectedAccountId:'8'},io),/ACCOUNT_CHANGED/);
 let accounts=0;await assert.rejects(()=>readBiliFavorites({recentLimit:100},{...io,account:async()=>({mid:++accounts===1?7:8})}),/ACCOUNT_CHANGED/);
});

test('Bilibili duplicate terminal page cannot turn a truncated prefix into a complete target',async()=>{
 const {readBiliFavorites}=await import('../src/main/source-collection.js');
 const result=await readBiliFavorites({recentLimit:100},{account:async()=>({mid:7}),folders:async()=>({list:[{id:'a'}]}),page:async(_,page)=>({medias:Array.from({length:40},(_,i)=>({id:i+1,fav_time:100-i})),has_more:page===1})});
 assert.equal(result.items.length,40);assert.equal(result.target?.complete,false);assert.equal(result.complete,false);
});

test('Bilibili explicit continuation overrides totals and empty or short nonterminal pages remain partial',async()=>{
 const {readBiliFavorites}=await import('../src/main/source-collection.js');
 const base={account:async()=>({mid:7}),folders:async()=>({list:[{id:'a'}]})};
 for(const size of [0,1]){
  let calls=0;
  const result=await readBiliFavorites({recentLimit:100},{...base,page:async()=>{calls++;return {medias:Array.from({length:size},(_,i)=>({id:i+1,fav_time:100-i})),has_more:true,info:{media_count:40}};}});
  assert.equal(calls,1);assert.equal(result.items.length,size);assert.equal(result.target?.complete,false);assert.equal(result.complete,false);assert.match(result.warning!,/非终页/);
 }
 const requested:number[]=[];
 const result=await readBiliFavorites({recentLimit:100},{...base,page:async(_,page)=>{requested.push(page);return {medias:Array.from({length:40},(_,i)=>({id:(page-1)*40+i+1,fav_time:1000-(page-1)*40-i})),has_more:page===1,info:{media_count:40}};}});
 assert.deepEqual(requested,[1,2]);assert.equal(result.items.length,80);assert.equal(result.target?.complete,true);
});

test('Bilibili total-only pagination fallback requires observed unique entries, never page capacity',async()=>{
 const {readBiliFavorites}=await import('../src/main/source-collection.js');
 const base={account:async()=>({mid:7}),folders:async()=>({list:[{id:'a'}]})};
 for(const size of [0,1]){
  const result=await readBiliFavorites({recentLimit:100},{...base,page:async()=>({medias:Array.from({length:size},(_,i)=>({id:i+1,fav_time:100-i})),info:{media_count:40}})});
  assert.equal(result.target?.complete,false);assert.equal(result.complete,false);
 }
 for(const size of [0,1,40]){
  const result=await readBiliFavorites({recentLimit:100},{...base,page:async()=>({medias:Array.from({length:size},(_,i)=>({id:i+1,fav_time:100-i})),info:{media_count:size}})});
  assert.equal(result.target?.complete,true);assert.equal(result.complete,true);assert.equal(result.items.length,size);
 }
});

test('single-content download exclusions preserve rows, skip preferred detail/media, survive restart and global resume',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-single-pause-')),details:string[]=[],downloads:string[]=[];
 const mediaDetail=(id:string)=>({...detail,media:[{kind:'image' as const,remoteUrl:'https://fixture.invalid/'+id,mime:'image/png',resourceKey:id}]});
 const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>snapshot(['paused-detail','paused-media','neighbor']),verifyAccount:async()=>{},detail:async content=>{details.push(content.sourceId);return mediaDetail(content.sourceId);}};
 const fixtureOptions={...options,fetch:async(url:string)=>{downloads.push(url);return new Response('synthetic image',{headers:{'content-type':'image/png'}});}};
 let service:WorkbenchService|undefined=new WorkbenchService(dir,[adapter],fixtureOptions);service.pauseDownloads();
 try{
  await service.sync();const a=service.store.find('xiaohongshu','fixture','paused-detail')!,b=service.store.find('xiaohongshu','fixture','paused-media')!;
  service.store.detailSaved(b,mediaDetail('paused-media'));
  const rows=()=>({contents:service!.store.db.prepare('SELECT * FROM contents WHERE id IN (?,?) ORDER BY id').all(a,b),media:service!.store.db.prepare('SELECT * FROM media WHERE content_id IN (?,?) ORDER BY id').all(a,b)}),before=rows();
  service.pauseContentDownload(a);service.pauseContentDownload(b,'此条未纳入自动下载');assert.deepEqual(rows(),before);
  assert.throws(()=>service!.pauseContentDownload(a,'not-approved-reason'),/原因/);
  service.retry(a);service.resumeDownloads();await service.waitForIdle();
  assert.deepEqual(details,['neighbor']);assert.deepEqual(downloads,['https://fixture.invalid/neighbor']);
  assert.equal(service.store.content(a)!.detailState,'queued');assert.equal(service.store.content(b)!.media[0].state,'queued');
  assert.equal(service.recentImport!.state().pausedContentDownloads.length,2);
  service.close();service=undefined;service=new WorkbenchService(dir,[adapter],fixtureOptions);
  assert.equal(service.recentImport!.isDownloadPaused(a),true);assert.equal(service.recentImport!.isDownloadPaused(b),true);
  service.retry(b);service.resumeDownloads();await service.waitForIdle();
  assert.deepEqual(details,['neighbor']);assert.deepEqual(downloads,['https://fixture.invalid/neighbor']);
  assert.equal(service.recentImport!.nextDetail(),undefined);assert.equal(service.recentImport!.nextDownload({preferred:b}),undefined);
  assert.equal(service.recentImport!.state().pausedContentDownloads.every(p=>p.reason==='此条未纳入自动下载'),true);
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('single-content pause rejects non-batch use and content outside the fixed recent scope',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-single-pause-scope-'));let service:WorkbenchService|undefined=new WorkbenchService(dir,[],{connections:()=>[]});
 try{
  assert.throws(()=>service!.pauseContentDownload(1),/独立同步/);service.close();service=undefined;
  service=new WorkbenchService(dir,[{platform:'xiaohongshu',collect:async()=>snapshot(['inside']),detail:async()=>detail}],options);service.pauseDownloads();await service.sync();
  const outside=item('outside');service.store.saveSnapshot(snapshot(['outside']),[{item:outside,discovery:'historical'}],1);
  assert.throws(()=>service!.pauseContentDownload(service!.store.find('xiaohongshu','fixture','outside')!),/目标范围/);
  assert.throws(()=>service!.pauseContentDownload(NaN),/目标范围/);assert.equal(service.recentImport!.pausedContentDownloads().length,0);
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('batch mode honours the persisted autoSync setting instead of forcing manual only',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-autosync-'));let service:WorkbenchService|undefined;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>snapshot(['a']),detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();
  assert.equal(service.state().autoSync,true,'fixed-batch roots follow the same default as normal mode');
  service.autoSync(false);assert.equal(service.state().autoSync,false);assert.equal(service.state().scheduler?.nextCheckAt,null);
  service.autoSync(true);assert.equal(service.state().autoSync,true,'autoSync(true) must not throw in batch mode');
  service.close();service=undefined;
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();assert.equal(service.state().autoSync,true,'the choice persists across restarts');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('an enabled batch scheduler runs the same recent-import path on a timer trigger',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-timer-'));let service:WorkbenchService|undefined;
 let now=1_000_000,collectCalls=0;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>{collectCalls++;return snapshot(['timer-1','timer-2']);},detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],{...options,now:()=>now});service.pauseDownloads();
  now+=31*60*1000; // past the next 30-minute check
  for(let i=0;i<50&&!collectCalls;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(collectCalls,1);
  for(let i=0;i<50&&service.state().syncs[0]?.state==='running';i++)await new Promise(r=>setTimeout(r,50));
  assert.equal(service.state().syncs[0].trigger,'timer');assert.equal(service.state().recentSync!.scopes[0].targetIds.length,2);assert.equal(service.state().contents.length,2);
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('a timer trigger during a manual run attaches to it instead of double-collecting',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-concurrent-'));let service:WorkbenchService|undefined;
 let collectCalls=0,finish!:()=>void;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>{collectCalls++;await new Promise<void>(r=>{finish=r;});return snapshot(['a']);},detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();
  const manual=service.sync(),timer=service.sync(undefined,'timer');
  await new Promise(r=>setTimeout(r,50));assert.equal(collectCalls,1);
  finish();await Promise.all([manual,timer]);assert.equal(collectCalls,1);
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('rolling scope: new favourites import as new, range shrink keeps everything, widening stays historical',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-rolling-'));let service:WorkbenchService|undefined;
 let now=1_000_000,collectOptions:unknown;
 const snap=(rows:{id:string;at:number}[]) => ({platform:'xiaohongshu' as const,accountId:'fixture',accountName:'fixture',folders:[{id:'saved',title:'saved'}],items:rows.map(r=>item(r.id,r.at)),complete:true,target:{limit:100,complete:true,reliable:true,reason:'fixture'}});
 let current=snap([{id:'a',at:100},{id:'b',at:200}]);
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async input=>{collectOptions=input;return current;},detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],{...options,now:()=>now});service.pauseDownloads();
  await service.sync(); // baseline: everything historical
  assert.equal(service.state().syncs[0].incrementalStatus,'baseline');assert.equal(service.state().syncs[0].incrementalNew,0);
  assert.equal(service.state().contents.every(c=>c.discovery==='historical'),true);

  // Second sync: two favourites newer than the last check window → new.
  now+=60_000;
  current=snap([{id:'n1',at:now-30_000},{id:'n2',at:now},{id:'a',at:100},{id:'b',at:200}]);
  await service.sync();
  const sync=service.state().syncs[0];
  assert.equal(sync.incrementalStatus,'confirmed');assert.equal(sync.incrementalNew,2);
  assert.equal(service.state().contents.find(c=>c.sourceId==='n1')?.discovery,'new');
  assert.equal(service.state().contents.find(c=>c.sourceId==='n2')?.discovery,'new');
  assert.equal(service.state().contents.find(c=>c.sourceId==='a')?.discovery,'historical');
  assert.deepEqual(service.state().recentSync!.scopes[0].targetIds,['a','b','n1','n2'],'targets accumulate');
  assert.equal(service.recentImport!.nextDetail()?.sourceId,'a','new items queue details like the rest');

  // Shrinking the range deletes nothing and never shrinks the accumulated scope.
  service.setSyncRange('10');
  await service.sync();
  assert.equal(service.state().contents.length,4);assert.deepEqual(service.state().recentSync!.scopes[0].targetIds,['a','b','n1','n2']);
  assert.deepEqual(collectOptions,{recentLimit:10,expectedAccountId:'fixture'});

  // Widening imports older favourites as history, never as new.
  service.setSyncRange('100');
  current=snap([{id:'n2',at:now},{id:'a',at:100},{id:'b',at:200},{id:'n1',at:now-30_000},{id:'old1',at:50},{id:'old2',at:60}]);
  await service.sync();
  assert.equal(service.state().contents.find(c=>c.sourceId==='old1')?.discovery,'historical');
  assert.equal(service.state().syncs[0].incrementalNew,0);
  assert.deepEqual(service.state().recentSync!.scopes[0].targetIds,['a','b','n1','n2','old1','old2']);
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('sync range validates, persists, reaches the adapter and all selects full history',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-range-'));let service:WorkbenchService|undefined;
 let collectOptions:unknown;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async input=>{collectOptions=input;const s=snapshot(['x']);if(input?.recentLimit)s.target!.limit=input.recentLimit;if(input?.fullHistory)s.target=undefined as never;return s;},detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();
  assert.equal(service.state().syncRange,'100');
  assert.throws(()=>service!.setSyncRange('5' as never),/无效/);
  service.setSyncRange('30');assert.equal(service.state().syncRange,'30');
  await service.sync();assert.equal((collectOptions as {recentLimit?:number}).recentLimit,30);
  service.setSyncRange('all');assert.equal(service.state().syncRange,'all');
  await service.sync();assert.equal((collectOptions as {fullHistory?:boolean}).fullHistory,true);
  assert.equal((collectOptions as {expectedAccountId?:string}).expectedAccountId,'fixture','the pinned batch account is still required');
  service.close();service=undefined;
  service=new WorkbenchService(dir,[adapter],options);assert.equal(service.state().syncRange,'all','persisted across restart');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('tombstoned collections stay skipped under every sync range',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-tombstone-range-'));let service:WorkbenchService|undefined;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>snapshot(['a','b']),detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();
  await service.sync();
  const id=service.store.find('xiaohongshu','fixture','a')!;
  service.deleteContents([id]);
  await service.sync();
  assert.match(service.state().syncs[0].message!,/已跳过已删除 1 条/);
  service.setSyncRange('all');
  await service.sync();
  assert.match(service.state().syncs[0].message!,/已跳过已删除 1 条/,'all-range sync also skips the tombstone');
  assert.equal(service.store.content(id)!.detailState,'queued');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('adapter full-history paging: end-of-list marks complete, safety cap marks partial',async()=>{
 const {readBiliFavorites}=await import('../src/main/source-collection.js');
 const {readZhihuFavorites,readWeiboFavoritePages}=await import('../src/main/social-source-core.js');
 // Bilibili already pages every folder to has_more=false under fullHistory.
 const bili=await readBiliFavorites({fullHistory:true},{account:async()=>({mid:7,uname:'f'}),folders:async()=>({list:[{id:'a'}]}),page:async(_,page)=>({medias:page===1?[{id:1,fav_time:10},{id:2,fav_time:20},{id:3,fav_time:30}]:[],has_more:false,info:{media_count:3}})});
 assert.equal(bili.complete,true);assert.equal(bili.items.length,3);assert.equal(bili.target,undefined,'no recent target under full history');
 await assert.rejects(()=>readBiliFavorites({fullHistory:true,recentLimit:100},{account:async()=>({mid:7}),folders:async()=>({list:[]}),page:async()=>({})}),/互斥/);

 let zhihuCalls=0;
 const zresult=await readZhihuFavorites({fullHistory:true},{account:async()=>({id:'z',name:'z',token:'me'}),
  get:async(path:string)=>{zhihuCalls++;
   if(path.includes('/collections?'))return {data:[{id:1,title:'夹'}],paging:{is_end:true}};
   const end=zhihuCalls>3;return {data:Array.from({length:20},(_,i)=>({content:{type:'answer',id:String(zhihuCalls*100+i),question:{title:'q'},created_time:1},collected_time:2})),paging:{is_end:end,next:end?'':`https://www.zhihu.com/api/v4/collections/1/items?offset=${zhihuCalls*20}`}};},
  delay:async()=>{}});
 assert.equal(zresult.complete,true);assert.equal(zresult.items.length,60);
 // An unterminated stream never claims complete.
 const zcap=await readZhihuFavorites({fullHistory:true},{account:async()=>({id:'z',name:'z',token:'me'}),
  get:async(path:string)=>{
   if(path.includes('/collections?'))return {data:[{id:1,title:'夹'}],paging:{is_end:true}};
   return {data:Array.from({length:20},(_,i)=>({content:{type:'answer',id:String(Math.floor(Math.random()*1e9)),question:{title:'q'},created_time:1},collected_time:2})),paging:{is_end:false,next:'https://www.zhihu.com/api/v4/collections/1/items?offset=999999'}};},
  delay:async()=>{}});
 assert.equal(zcap.complete,false,'a broken cursor ends the folder as partial, never complete');

 const card=(n:number)=>({url:`https://weibo.com/1/Post${n}`,author:'a',text:`post ${n}`});
 const wpage=(n:number,last:boolean)=>({page:n,routePage:n,navigationAccountIds:['a'],pageSelfAccountId:'a',total:2,
  slots:[{key:`s${n}`,card:card(n),unavailable:false}],slotsReliable:true,paginationVerified:true,previousDisabled:n===1,nextPage:last?null:n+1,terminal:last,blocked:false});
 const wresult=await readWeiboFavoritePages({fullHistory:true},{account:async()=>({id:'a',name:'a'}),page:async(_a,n)=>wpage(n,n===2),delay:async()=>{}});
 assert.equal(wresult.complete,true);assert.equal(wresult.items.length,2);
 // mid-page stop without terminal stays partial
 const wpartial=await readWeiboFavoritePages({fullHistory:true},{account:async()=>({id:'a',name:'a'}),page:async(_a,n)=>({...wpage(n,false),nextPage:null}),delay:async()=>{}});
 assert.equal(wpartial.complete,false);
});

test('mid-page rate limit keeps the partial collect and the platform cools down',async()=>{
 // Adapter level: a 限流 page failure ends the zhihu collect as partial with
 // the already-read items kept, flagged limited rather than thrown away.
 const {readZhihuFavorites,readWeiboFavoritePages}=await import('../src/main/social-source-core.js');
 let zhihuCalls=0;
 const zlimited=await readZhihuFavorites({fullHistory:true},{account:async()=>({id:'z',name:'z',token:'me'}),
  get:async(path:string)=>{zhihuCalls++;
   if(path.includes('/collections?'))return {data:[{id:1,title:'夹'}],paging:{is_end:true}};
   if(zhihuCalls>2)throw new Error('知乎访问受限或触发限流（HTTP 429），请在登录窗口检查后重试');
   return {data:Array.from({length:20},(_,i)=>({content:{type:'answer',id:String(zhihuCalls*100+i),question:{title:'q'},created_time:1},collected_time:2})),paging:{is_end:false,next:`https://www.zhihu.com/api/v4/collections/1/items?offset=${zhihuCalls*20}`}};},
  delay:async()=>{}});
 assert.equal(zlimited.complete,false);assert.equal(zlimited.items.length,20,'page-one items are kept');
 assert.match(zlimited.limited??'',/限流/);
 // Weibo's own blocked-page signal takes the same partial path.
 const wlimited=await readWeiboFavoritePages({fullHistory:true},{account:async()=>({id:'a',name:'a'}),
  page:async(_a:unknown,n:number)=>{if(n===2)throw new Error('微博访问受限或触发限流（HTTP 403），请在登录窗口检查后重试');return {page:n,routePage:n,navigationAccountIds:['a'],pageSelfAccountId:'a',total:9,slots:[{key:`s${n}`,card:{url:`https://weibo.com/1/P${n}`,author:'a',text:'t'},unavailable:false}],slotsReliable:true,paginationVerified:true,previousDisabled:n===1,nextPage:n+1,terminal:false,blocked:false};},
  delay:async()=>{}});
 assert.equal(wlimited.complete,false);assert.equal(wlimited.items.length,1);assert.match(wlimited.limited??'',/访问受限/);
 // Auth failures still throw — they are not a collectible partial.
 await assert.rejects(()=>readWeiboFavoritePages({fullHistory:true},{account:async()=>({id:'a',name:'a'}),page:async()=>{throw new Error('LOGIN_REQUIRED：微博登录失效');}}),/LOGIN_REQUIRED/);

 // Service level: a limited snapshot saves items, records a partial row and
 // puts the platform into cooldown rather than marking it succeeded.
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-limited-'));let service:WorkbenchService|undefined;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>({...snapshot(['a','b']),limited:'小红书访问受限或触发限流（HTTP 429）',complete:false,target:{limit:100,complete:false,reliable:true,reason:'小红书访问受限或触发限流（HTTP 429）'}}),detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();
  await service.sync();
  assert.equal(service.state().contents.length,2,'already-collected items are saved');
  const sync=service.state().syncs[0];
  assert.equal(sync.state,'partial');assert.match(sync.message??'',/限流/);
  assert.equal(service.state().recentSync!.lanes!.find(l=>l.platform==='xiaohongshu')?.mode,'cooldown','the platform cools down after a limited collect');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('favourite-order rank follows platform order: new on top, interpolated between, appended below, stable on disagreement',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-rank-'));let service:WorkbenchService|undefined;let current=snapshot(['a','b','c']);
 const rank=(s:WorkbenchService,id:string)=>s.state().contents.find(c=>c.sourceId===id)?.favoriteRank;
 try{
  const adapter:SourceAdapter={platform:'xiaohongshu',collect:async()=>current,detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],options);service.pauseDownloads();
  await service.sync();
  assert.deepEqual(['a','b','c'].map(id=>rank(service!,id)),[3,2,1],'baseline ranks follow snapshot order');
  // New favourites above the first known item rise above the current max;
  // one observed between two anchors interpolates strictly between them.
  current=snapshot(['n1','a','n2','b']);await service.sync();
  assert.equal(rank(service,'n1'),4);assert.equal(rank(service,'a'),3);assert.equal(rank(service,'n2'),2.5);assert.equal(rank(service,'b'),2);assert.equal(rank(service,'c'),1);
  // Older items appended after the last anchor sink below it.
  current=snapshot(['a','b','c','o1','o2']);await service.sync();
  assert.equal(rank(service,'o1'),0);assert.equal(rank(service,'o2'),-1);assert.equal(rank(service,'c'),1);
  // A later snapshot disagreeing about known items never reorders them.
  current=snapshot(['b','a']);await service.sync();
  assert.equal(rank(service,'a'),3);assert.equal(rank(service,'b'),2,'known ranks keep their values');
  // Tombstoned items are never ranked.
  const zid=service.store.find('xiaohongshu','fixture','c')!;
  service.store.db.prepare('DELETE FROM content_favorite_order WHERE content_id=?').run(zid);
  service.deleteContents([zid]);
  current=snapshot(['z2','c','a']);await service.sync();
  assert.equal(service.store.content(zid)!.favoriteRank,undefined,'the tombstone stays unranked');
  assert.equal(rank(service,'z2'),5,'the new head item still ranks above the current max');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('startup backfill seeds ranks from observed_json and collected_at fills once, never overwrites',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-rankfill-'));let service:WorkbenchService|undefined;
 try{
  const store=new Store(dir);
  const snap=snapshot(['a','b','c','d']);
  snap.items[3].collectedAt=null;
  store.saveSnapshot(snap,snap.items.map(i=>({item:i,discovery:'historical' as const})),1);
  // Simulate a pre-upgrade database: no ranks at all.
  store.db.prepare('DELETE FROM content_favorite_order').run();
  const {RecentImport}=await import('../src/main/recent-import.js');
  new RecentImport(store,{batchId:'test-batch',limit:100});
  store.db.prepare("INSERT INTO recent_import_scopes VALUES('test-batch','xiaohongshu','fixture',100,'[\"a\",\"b\",\"c\",\"d\"]','[\"c\",\"a\",\"d\",\"b\"]',1,1,1,'r',NULL,1,1)").run();
  new RecentImport(store,{batchId:'test-batch',limit:100});
  const ranks=new Map((store.db.prepare('SELECT c.source_id,o.rank FROM contents c JOIN content_favorite_order o ON o.content_id=c.id').all() as {source_id:string;rank:number}[]).map(r=>[r.source_id,r.rank]));
  assert.deepEqual(ranks.get('c'),4);assert.deepEqual(ranks.get('a'),3);assert.deepEqual(ranks.get('d'),2);assert.deepEqual(ranks.get('b'),1,'backfill follows the latest observed order, not snapshot order');
  // A later snapshot with a favourite time fills a NULL collected_at; a known value is never overwritten.
  store.saveSnapshot(snap,[{item:{...item('d'),collectedAt:500},discovery:'historical'}],2);
  assert.equal(store.content(store.find('xiaohongshu','fixture','d')!)!.collectedAt,500);
  store.saveSnapshot(snap,[{item:{...item('d'),collectedAt:900},discovery:'historical'}],3);
  assert.equal(store.content(store.find('xiaohongshu','fixture','d')!)!.collectedAt,500,'existing collected_at is never overwritten');
  store.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('startup requeues X details once when an unreadable quote had blocked the own body',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-xquote-'));let service:WorkbenchService|undefined;
 try{
  const store=new Store(dir);
  const snap={...snapshot(['q1','q2','ok']),platform:'twitter' as const};
  store.saveSnapshot(snap,snap.items.map(i=>({item:i,discovery:'historical' as const})),1);
  // Simulate the pre-fix state: own body dropped because the quote was unreadable.
  for(const sourceId of ['q1','q2'])store.db.prepare("UPDATE contents SET detail_state='succeeded',body_complete=0,manifest_error='引用帖未完整取得' WHERE source_id=?").run(sourceId);
  store.db.prepare("UPDATE contents SET detail_state='succeeded',body_complete=1,manifest_error='X 长文章只有摘要，完整文章正文尚未取得' WHERE source_id='ok'").run();
  store.db.prepare("INSERT INTO contents(platform,account_id,source_id,title,author,url,kind,detail_state,body_complete,manifest_error,discovery,first_discovered_at) VALUES('twitter','fixture','gone','t','a','u','text','succeeded',0,'引用帖未完整取得','historical',1)").run();
  store.db.prepare("INSERT INTO content_deletions(content_id,deleted_at,bytes_freed) SELECT id,1,0 FROM contents WHERE source_id='gone'").run();
  store.close();
  const events:unknown[]=[];
  const adapter:SourceAdapter={platform:'twitter',collect:async()=>snap,detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],{...options,evidence:event=>{events.push(event);}});
  const content=(id:string)=>service!.state().contents.find(c=>c.sourceId===id)!;
  assert.equal(content('q1').detailState,'queued');assert.equal(content('q2').detailState,'queued');
  assert.equal(content('ok').detailState,'succeeded','the long-article item is not quote-blocked and is left alone');
  assert.equal(service.store.content(service.store.find('twitter','fixture','gone')!)!.detailState,'succeeded','tombstones are not requeued');
  assert.ok(events.includes('x-quote-body-repair'),'the one-shot repair logs an evidence event');
  service.close();
  service=new WorkbenchService(dir,[adapter],options);
  service.store.db.prepare("UPDATE contents SET detail_state='succeeded' WHERE source_id IN ('q1','q2')").run();
  service.close();service=undefined;
  service=new WorkbenchService(dir,[adapter],options);
  assert.equal(content('q1').detailState,'succeeded','the repair runs once, guarded by the settings flag');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('startup requeues X article summaries once for the full-body adapter',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-batch-xarticle-'));let service:WorkbenchService|undefined;
 try{
  const store=new Store(dir);
  const snap={...snapshot(['a1','a2','ok','gone']),platform:'twitter' as const};
  store.saveSnapshot(snap,snap.items.map(i=>({item:i,discovery:'historical' as const})),1);
  // Simulate the pre-adapter state: an X Article saved with only its summary.
  for(const sourceId of ['a1','a2'])store.db.prepare("UPDATE contents SET detail_state='succeeded',body_complete=0,manifest_error='X 长文章只有摘要，完整文章正文尚未取得' WHERE source_id=?").run(sourceId);
  store.db.prepare("UPDATE contents SET detail_state='succeeded',body_complete=1,manifest_error='X 长文章只有摘要，完整文章正文尚未取得' WHERE source_id='ok'").run();
  store.db.prepare("UPDATE contents SET detail_state='succeeded',body_complete=0,manifest_error='X 长文章只有摘要，完整文章正文尚未取得' WHERE source_id='gone'").run();
  store.db.prepare("INSERT INTO content_deletions(content_id,deleted_at,bytes_freed) SELECT id,1,0 FROM contents WHERE source_id='gone'").run();
  store.close();
  const events:unknown[]=[];
  const adapter:SourceAdapter={platform:'twitter',collect:async()=>snap,detail:async()=>detail};
  service=new WorkbenchService(dir,[adapter],{...options,evidence:event=>{events.push(event);}});
  const content=(id:string)=>service!.state().contents.find(c=>c.sourceId===id)!;
  assert.equal(content('a1').detailState,'queued');assert.equal(content('a2').detailState,'queued');
  assert.equal(content('ok').detailState,'succeeded','an item with a complete body is not requeued even when the reason matches');
  assert.equal(service.store.content(service.store.find('twitter','fixture','gone')!)!.detailState,'succeeded','tombstones are not requeued');
  assert.ok(events.includes('x-article-body-repair'),'the one-shot repair logs an evidence event');
  service.close();
  service=new WorkbenchService(dir,[adapter],options);
  service.store.db.prepare("UPDATE contents SET detail_state='succeeded' WHERE source_id IN ('a1','a2')").run();
  service.close();service=undefined;
  service=new WorkbenchService(dir,[adapter],options);
  assert.equal(content('a1').detailState,'succeeded','the repair runs once, guarded by the settings flag');
 }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});
