import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clone } from '../src/editor-core/model.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { exportMarkdownPackage, previewExportMedia } from '../src/main/editor-media-export.js';
import { sha256 } from '../src/main/editor-media.js';
import { setup, seed, repository, bundle, request, png } from './e1-helpers.js';

function prepared(){
 const f=setup(),id=seed(f.store),repo=repository(f.store),b=bundle(repo,id);
 f.store.detailSaved(id,{body:'真实接口的合成测试正文',bodyComplete:true,media:[{kind:'video',mime:'video/mp4',remoteUrl:'https://example.invalid/current-video',title:'本条分P 中文🙂'},{kind:'image',mime:'image/png',remoteUrl:'https://example.invalid/current-image'}]});
 const media=f.store.content(id)!.media,video=media.find(m=>m.kind==='video')!,image=media.find(m=>m.kind==='image')!;
 const bytes=Buffer.alloc(2*1024*1024+37,0x41);writeFileSync(path.join(f.root,'media','clip.mp4'),bytes);f.store.downloadSaved(video.id,'clip.mp4',bytes.length,'video/mp4');writeFileSync(path.join(f.root,'media','photo.png'),png);f.store.downloadSaved(image.id,'photo.png',png.length,'image/png');
 const asset=repo.selectImage(b.workspace.id,image.id),draft=clone(b.draft);draft.blocks=[{id:'text',type:'paragraph',runs:[{text:'已编辑中文正文，不能混入大纲。'}]},{id:'picture',type:'image',runs:[],assetRefs:[{assetId:asset.id,version:asset.version}]}];assert.equal(repo.save([request(draft)])[0].status,'saved');
 const unrelated=seed(f.store,'another-collection');f.store.detailSaved(unrelated,{body:'其他收藏',bodyComplete:true,media:[{kind:'video',mime:'video/mp4',remoteUrl:'https://example.invalid/unrelated'}]});const other=f.store.content(unrelated)!.media[0];writeFileSync(path.join(f.root,'media','unrelated.mp4'),'NEVER COPY');f.store.downloadSaved(other.id,'unrelated.mp4',10,'video/mp4');
 const parent=path.join(f.root,'exports');mkdirSync(parent);
 return{...f,id,repo,b:repo.load(b.workspace.id).bundle,video,bytes,parent};
}
const expected={draftRevision:2,mapRevision:1};
function mdIn(directory:string){return path.join(directory,readdirSync(directory).find(f=>f.endsWith('.md'))!);}

test('E4.1 optional media stays off by default, selected current media copied byte-exact with progress; moved pack stays relative',async()=>{
 const f=prepared();try{
  const preview=previewExportMedia(f.repo,f.b.workspace.id);assert.equal(preview.items.length,1);assert.equal(preview.items[0].mediaId,f.video.id);assert.equal(preview.totalBytes,f.bytes.length);assert.equal(preview.missingCount,0);
  const normal=await exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,path.join(f.parent,'中文🙂.md'),{operationId:'default'});assert.equal(normal.mediaFiles,0);assert.equal(normal.files,2);assert.equal(normal.mediaBytes,0);assert.match(readFileSync(mdIn(normal.path!),'utf8'),/音视频文件未包含/);assert.ok(!readdirSync(normal.path!).includes('media'));
  const progress:any[]=[];
  const result=await exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,path.join(f.parent,'中文🙂.md'),{includeLocalMedia:true,operationId:'media',onProgress:p=>progress.push(p)});
  assert.equal(result.mediaFiles,1);assert.equal(result.mediaBytes,f.bytes.length);assert.equal(result.offlineComplete,true);assert.equal(result.files,3);assert.ok(progress.filter(p=>p.phase==='copying').length>3);assert.equal(progress.at(-1).copiedBytes,progress.at(-1).totalBytes);assert.ok(progress.every((p,i)=>!i||p.copiedBytes>=progress[i-1].copiedBytes));
  const moved=path.join(f.root,'搬移目录');renameSync(result.path!,moved);const text=readFileSync(mdIn(moved),'utf8');assert.match(text,/已编辑中文正文/);assert.doesNotMatch(text,/导图大纲|音视频文件未包含|rlw-media:|file:\/\//);
  const links=[...text.matchAll(/\]\(((?:media|assets)\/[^)]+)\)/g)].map(m=>m[1]);assert.ok(links.some(p=>p.startsWith('media/')));for(const link of links)assert.ok(statSync(path.join(moved,link)).size>0);const video=links.find(x=>x.startsWith('media/'))!;assert.equal(sha256(readFileSync(path.join(moved,video))),sha256(f.bytes));assert.equal(readdirSync(path.join(moved,'media')).length,1);
 }finally{f.close();}
});

test('E4.1 collision, missing media, write/stream failures and cancellation preserve target and saved documents',async()=>{
 const f=prepared();try{
  const chosen=path.join(f.parent,'旧目标.md');writeFileSync(chosen,'USER TARGET');const before=JSON.stringify(f.repo.load(f.b.workspace.id).bundle);
  for(const failAt of ['after-write','before-publish','during-copy'] as const){await assert.rejects(exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,chosen,{includeLocalMedia:true,operationId:failAt,failAt}),/导出写入或复制失败/);assert.deepEqual(readdirSync(f.parent),['旧目标.md']);}
  const controller=new AbortController();const cancelled=await exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,chosen,{includeLocalMedia:true,operationId:'cancel',signal:controller.signal,onProgress:p=>{if(p.copiedBytes>png.length)controller.abort();}});assert.equal(cancelled.status,'cancelled');assert.deepEqual(readdirSync(f.parent),['旧目标.md']);
  const a=await exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,chosen,{includeLocalMedia:true,operationId:'a'}),b=await exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,chosen,{includeLocalMedia:true,operationId:'b'});assert.notEqual(a.path,b.path);assert.equal(readFileSync(chosen,'utf8'),'USER TARGET');assert.equal(JSON.stringify(f.repo.load(f.b.workspace.id).bundle),before);
  writeFileSync(path.join(f.root,'media','clip.mp4'),'damaged');const preview=previewExportMedia(f.repo,f.b.workspace.id);assert.equal(preview.missingCount,1);assert.match(preview.items[0].reason!,/大小/);await assert.rejects(exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,chosen,{includeLocalMedia:true,operationId:'missing'}),/缺失或不可访问/);assert.equal(readFileSync(chosen,'utf8'),'USER TARGET');
  await assert.rejects(exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',{draftRevision:1,mapRevision:1},chosen,{operationId:'stale'}),/版本/);
 }finally{f.close();}
});

test('E4.1 installed-result scope exports fixed authorized media; newly added collection media is not silently included',async()=>{
 const f=prepared();try{
  const digest=new DigestRepository(f.store.db,f.root,f.repo),request=digest.request(f.id).request!;
  f.store.db.exec('CREATE TABLE generation_artifacts(id TEXT PRIMARY KEY,request_id TEXT,content_id INTEGER,installed INTEGER,created_at INTEGER)');f.store.db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?)').run('fixture-installed',request.id,f.id,1,1);
  const old=f.store.content(f.id)!.media;f.store.detailSaved(f.id,{body:'稍后变化',bodyComplete:true,media:[...old.map(m=>({kind:m.kind as any,mime:m.mime,remoteUrl:m.kind==='video'?'https://example.invalid/current-video':'https://example.invalid/current-image'})),{kind:'video',mime:'video/mp4',remoteUrl:'https://example.invalid/later-part'}]});
  const preview=previewExportMedia(f.repo,f.b.workspace.id);assert.deepEqual(preview.items.map(x=>x.mediaId),[f.video.id]);assert.equal(preview.missingCount,0);
  writeFileSync(path.join(f.root,'media','clip.mp4'),'later altered original');const result=await exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,path.join(f.parent,'固定版本.md'),{includeLocalMedia:true,operationId:'frozen'});assert.equal(result.mediaFiles,1);const relative=/\]\((media\/[^)]+)\)/.exec(readFileSync(mdIn(result.path!),'utf8'))![1];assert.equal(sha256(readFileSync(path.join(result.path!,relative))),sha256(f.bytes));
 }finally{f.close();}
});


test('E4.1 simulated ENOSPC/EACCES stream failures leave old target, clean staging and saved draft intact',async()=>{
 const f=prepared(),original=fs.createWriteStream;try{
  const target=path.join(f.parent,'已有中文.md');writeFileSync(target,'KEEP USER BYTES');const before=JSON.stringify(f.repo.load(f.b.workspace.id).bundle);
  for(const code of ['ENOSPC','EACCES']){
   // Explicit mechanism fault: no disk filling or permission changes to user data.
   fs.createWriteStream=(()=>new Writable({write(_chunk,_encoding,callback){callback(Object.assign(Error('injected filesystem failure'),{code}));}})) as unknown as typeof fs.createWriteStream;syncBuiltinESMExports();
   await assert.rejects(exportMarkdownPackage(f.repo,f.b.workspace.id,'draft',expected,target,{includeLocalMedia:true,operationId:code}),/目标权限和剩余空间/);
   assert.equal(readFileSync(target,'utf8'),'KEEP USER BYTES');assert.deepEqual(readdirSync(f.parent),['已有中文.md']);assert.equal(JSON.stringify(f.repo.load(f.b.workspace.id).bundle),before);
  }
 }finally{fs.createWriteStream=original;syncBuiltinESMExports();f.close();}
});
