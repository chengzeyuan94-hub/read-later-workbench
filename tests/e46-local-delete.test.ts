import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WorkbenchService} from '../src/main/service.js';
import {Store} from '../src/main/store.js';
import type {CollectionItem,CollectionSnapshot,Platform,SourceAdapter} from '../src/shared/contracts.js';

const item=(id:string):CollectionItem=>({sourceId:id,title:id,author:'fixture',url:'https://fixture.invalid/'+id,kind:'text',folderIds:['saved'],collectedAt:100});
const snapshot=(platform:Platform,ids:string[],account='fixture'):CollectionSnapshot=>({platform,accountId:account,accountName:'fixture',folders:[{id:'saved',title:'saved'}],items:ids.map(item),complete:false,target:{limit:100,complete:true,reliable:true,reason:'fixture head'}});
const options={connections:()=>[],recentImport:{batchId:'e46-batch',limit:100}};
const img=(key:string)=>({kind:'image' as const,remoteUrl:'https://fixture.invalid/'+key,mime:'image/png',resourceKey:key});
const detailOf=(key:string)=>({body:'fixture body',bodyComplete:true,mediaManifestComplete:true,media:[img(key)]});
const okImage=async()=>new Response('image',{headers:{'content-type':'image/png'}});
const tick=async(ms=40)=>new Promise(r=>setTimeout(r,ms));
const until=async(fn:()=>boolean,rounds=200)=>{for(let i=0;i<rounds&&!fn();i++)await tick(25);assert.ok(fn(),'等待超时');};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db=(service:WorkbenchService)=>(service as any).store.db as import('better-sqlite3').Database;
const create=(dir:string,detail:SourceAdapter['detail'],extra:Record<string,unknown>={})=>new WorkbenchService(dir,[
 {platform:'xiaohongshu',collect:async()=>snapshot('xiaohongshu',['x1','x2']),verifyAccount:async()=>{},detail} as SourceAdapter,
],{...options,fetch:async()=>okImage(),...extra});

test('delete purges payload rows and files, keeps contents tombstone and exclusion from state',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 const service=create(dir,async c=>detailOf(c.sourceId));
 try{
  await service.sync();await service.waitForIdle();
  await until(()=>service.state().contents.every(c=>c.media.every(m=>m.state==='succeeded')));
  const target=service.state().contents.find(c=>c.sourceId==='x1')!;
  const other=service.state().contents.find(c=>c.sourceId==='x2')!;
  const filePath=path.join(dir,'media',target.media[0].localPath!);
  assert.ok(existsSync(filePath),'media file saved before delete');
  const thumbDir=path.join(dir,'media','.thumbs'),thumbFile=path.join(thumbDir,`${target.media[0].id}-1-1-w480.jpg`);
  await mkdir(thumbDir,{recursive:true});await writeFile(thumbFile,'t');
  const preview=await service.deletePreview([target.id]);
  const result=await service.deleteContents([target.id]);
  assert.deepEqual(result.deleted,[target.id]);assert.equal(result.blocked.length,0);
  assert.equal(result.bytesFreed,preview.bytes,'deletePreview bytes match bytes_freed');
  assert.ok(result.bytesFreed>0);
  assert.ok(!(db(service).prepare('SELECT 1 FROM media WHERE content_id=?').get(target.id)),'media rows purged');
  assert.ok(!(db(service).prepare('SELECT 1 FROM pending_file_deletions').get()),'pending ledger drained');
  assert.ok(db(service).prepare('SELECT 1 FROM contents WHERE id=?').get(target.id),'contents tombstone kept');
  assert.ok(db(service).prepare('SELECT 1 FROM content_deletions WHERE content_id=?').get(target.id),'deletion row recorded');
  assert.ok(!existsSync(filePath),'media file unlinked');
  assert.ok(!existsSync(thumbFile),'cached thumbnail purged with the media');
  const state=service.state();
  assert.ok(!state.contents.some(c=>c.id===target.id),'state contents excludes deleted');
  assert.ok(state.contents.some(c=>c.id===other.id));
  assert.deepEqual((state.deleted??[]).map(d=>d.contentId),[target.id]);
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('re-sync skips deleted identity and records the skip in the sync row',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 const service=create(dir,async c=>detailOf(c.sourceId));
 try{
  await service.sync();await service.waitForIdle();
  const target=service.state().contents.find(c=>c.sourceId==='x1')!;
  await service.deleteContents([target.id]);await service.waitForIdle();
  await service.sync(undefined,'manual');await service.waitForIdle();
  const state=service.state();
  assert.ok(!state.contents.some(c=>c.sourceId==='x1'),'deleted item not re-imported');
  const syncRow=state.syncs.find(s=>s.platform==='xiaohongshu')!;
  assert.ok(syncRow.message.includes('已删除'),'skip counted in the sync row');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('restore re-queues detail and the next pump re-fetches body and media',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 const service=create(dir,async c=>detailOf(c.sourceId));
 try{
  await service.sync();await service.waitForIdle();
  const target=service.state().contents.find(c=>c.sourceId==='x1')!;
  await service.deleteContents([target.id]);
  await service.restoreDeleted(target.id);
  await until(()=>{const c=service.state().contents.find(row=>row.id===target.id);return !!c&&c.media.some(m=>m.state==='succeeded');},300);
  assert.equal(service.state().deleted!.length,0,'tombstone cleared after restore');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('delete refuses items with an in-flight lane task and resumes after',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 let release:(()=>void)|undefined;
 const service=create(dir,async c=>{if(c.sourceId!=='x1')return detailOf(c.sourceId);await new Promise<void>(r=>release=()=>r());return detailOf('x1');});
 try{
  await service.sync();
  const target=service.state().contents.find(c=>c.sourceId==='x1')!;
  await until(()=>!!release&&(service.state().deletionBlocked??[]).some(row=>row.contentId===target.id));
  const preview=await service.deletePreview([target.id]);
  assert.equal(preview.blocked.length,1);assert.match(preview.blocked[0].reason,/正文|下载/);
  release!();
  await until(()=>service.state().contents.every(c=>c.media.every(m=>m.state==='succeeded')),300);
  await until(()=>!(service.state().deletionBlocked??[]).some(row=>row.contentId===target.id));
  const second=await service.deletePreview([target.id]);
  assert.equal(second.blocked.length,0,'block clears once the task finishes');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('active digest request is blocked from deletion',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 const service=create(dir,async c=>detailOf(c.sourceId),{editorEnabled:true});
 try{
  await service.sync();await service.waitForIdle();
  const store=(service as unknown as {store:Store}).store;
  const target=service.state().contents.find(c=>c.sourceId==='x1')!;
  store.digestPipeline!.request(target.id);
  const preview=await service.deletePreview([target.id]);
  assert.equal(preview.blocked.length,1);assert.match(preview.blocked[0].reason,/消化/);
  const result=await service.deleteContents([target.id]);
  assert.deepEqual(result.deleted,[]);assert.equal(result.blocked.length,1);
  store.digestPipeline!.cancel(target.id);
  assert.equal((await service.deletePreview([target.id])).blocked.length,0,'block clears after cancel');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('shared editor asset survives while another content references it, then is freed',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 const service=create(dir,async c=>detailOf(c.sourceId),{editorEnabled:true});
 try{
  await service.sync();await service.waitForIdle();
  const a=service.state().contents.find(c=>c.sourceId==='x1')!,b=service.state().contents.find(c=>c.sourceId==='x2')!;
  await mkdir(path.join(dir,'editor-assets'),{recursive:true});
  await writeFile(path.join(dir,'editor-assets','sharedsha'),'shared-payload');
  const ws=(id:string,contentId:number)=>{db(service).prepare('INSERT INTO editor_workspaces(id,content_id,platform,account_id,source_id,json,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0)').run(id,contentId,'xiaohongshu','fixture','sid'+contentId,'{}');
   db(service).prepare('INSERT INTO editor_assets(id,version,workspace_id,media_id,json) VALUES(?,?,?,?,?)').run('asset'+id,'v',id,0,JSON.stringify({relativePath:'sharedsha'}));};
  ws('wsa',a.id);ws('wsb',b.id);
  await service.deleteContents([a.id]);
  assert.ok(existsSync(path.join(dir,'editor-assets','sharedsha')),'shared asset kept while referenced');
  await service.deleteContents([b.id]);
  assert.ok(!existsSync(path.join(dir,'editor-assets','sharedsha')),'shared asset freed with last reference');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('pending file deletions are drained on open and out-of-root paths refused',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-'));
 const outside=await mkdtemp(path.join(os.tmpdir(),'rlw-e46-out-'));
 try{
  const inside=path.join(dir,'media','victim.txt'),escaped=path.join(outside,'keep.txt');
  await mkdir(path.join(dir,'media'),{recursive:true});
  await writeFile(inside,'x');await writeFile(escaped,'x');
  const store=new Store(dir);
  store.db.prepare('INSERT INTO pending_file_deletions(path,created_at) VALUES(?,0)').run(inside);
  store.db.prepare('INSERT INTO pending_file_deletions(path,created_at) VALUES(?,0)').run(escaped);
  (store as unknown as {processPendingDeletions:()=>void}).processPendingDeletions();
  assert.ok(!existsSync(inside),'pending file inside root unlinked');
  assert.ok(existsSync(escaped),'out-of-root path refused');
  assert.equal((store.db.prepare('SELECT COUNT(*) c FROM pending_file_deletions').get() as {c:number}).c,0,'pending ledger cleared either way');
  store.close();
 }finally{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
