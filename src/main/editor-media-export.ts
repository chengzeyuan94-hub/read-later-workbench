import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, createReadStream, createWriteStream, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { EditorExportKind, EditorExportMediaItem, EditorExportMediaPreview, EditorExportProgress, EditorExportResult } from '../shared/editor-contracts.js';
import type { DigestInternalScope } from '../shared/digest-contracts.js';
import { exportFilename, prepareMarkdown } from './editor-export.js';
import { boundedFile, sha256 } from './editor-media.js';
import type { EditorRepository } from './editor-store.js';

type MediaInput = {item:EditorExportMediaItem;file?:string;sha256?:string;mime:string;fingerprint?:string};
const fingerprint=(s:{dev:number;ino:number;size:number;mtimeMs:number})=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
const table=(repository:EditorRepository,name:string)=>!!repository.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
/** Only the installed artifact's frozen media scope; manual-only workspaces use this collection's current media. */
function mediaInputs(repository:EditorRepository,workspaceId:string):MediaInput[]{
 const record=repository.load(workspaceId),db=repository.db;
 let scope:DigestInternalScope|undefined;
 if(table(repository,'generation_artifacts')){
  const row=db.prepare('SELECT d.scope_json FROM generation_artifacts a JOIN digest_requests d ON d.id=a.request_id WHERE a.content_id=? AND a.installed=1 ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1').get(record.contentId) as {scope_json:string}|undefined;
  if(row)scope=JSON.parse(row.scope_json);
 }
 const candidates=scope?scope.input.media.filter(m=>m.kind==='audio'||m.kind==='video').map(m=>({id:m.id,kind:m.kind as 'audio'|'video',title:m.title,mime:m.mime,bytes:m.bytes,ready:m.available,relative:scope!.fixedMediaPaths[String(m.id)],sha:m.sha256,root:path.join(repository.dataDir,'digest-inputs')})):(db.prepare("SELECT id,kind,title,mime,bytes,state,local_path FROM media WHERE content_id=? AND current=1 AND kind IN ('audio','video') ORDER BY media_order,id").all(record.contentId) as any[]).map(m=>({id:m.id,kind:m.kind as 'audio'|'video',title:m.title,mime:m.mime,bytes:m.bytes,ready:m.state==='succeeded',relative:m.local_path,sha:null,root:path.join(repository.dataDir,'media')}));
 return candidates.map(m=>{
  const item:EditorExportMediaItem={mediaId:m.id,kind:m.kind,label:m.title||`${m.kind==='video'?'视频':'音频'} ${m.id}`,bytes:Number(m.bytes)||0,status:'missing'};
  try{
   if(!m.ready||!m.relative)throw Error('该媒体尚未保存在本地');
   const file=boundedFile(m.root,m.relative),s=statSync(file);accessSync(file,constants.R_OK);
   if(!s.size||s.size!==m.bytes)throw Error('本地媒体大小与保存记录不符');
   item.status='available';return{item,file,mime:m.mime,sha256:m.sha??undefined,fingerprint:fingerprint(s)};
  }catch(error){item.reason=error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'本地媒体缺失或不可访问';return{item,mime:m.mime};}
 });
}
export function previewExportMedia(repository:EditorRepository,workspaceId:string):EditorExportMediaPreview{
 const items=mediaInputs(repository,workspaceId).map(x=>x.item);
 return{items,totalBytes:items.filter(x=>x.status==='available').reduce((n,x)=>n+x.bytes,0),missingCount:items.filter(x=>x.status==='missing').length};
}
function mediaExtension(file:string,mime:string):string{
 const known:Record<string,string>={'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac','audio/wav':'.wav','audio/x-wav':'.wav','audio/flac':'.flac','audio/ogg':'.ogg'};
 return known[mime.split(';')[0]]??(/^\.[a-zA-Z0-9]{1,8}$/.test(path.extname(file))?path.extname(file):'.bin');
}
function assertNotCancelled(signal?:AbortSignal):void{if(signal?.aborted)throw Object.assign(Error('已取消导出，当前稿件和已有目标保留'),{name:'AbortError'});}
async function durableWrite(file:string,bytes:Buffer|string):Promise<void>{const h=await open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
async function hashFile(file:string,signal?:AbortSignal):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);return hash.digest('hex');}
/** External export: no DB writes and no network. All copied bytes are validated before publication. */
export async function exportMarkdownPackage(repository:EditorRepository,workspaceId:string,kind:EditorExportKind,expected:{draftRevision:number;mapRevision:number},chosenPath:string,options:{includeLocalMedia?:boolean;operationId:string;signal?:AbortSignal;onProgress?:(progress:EditorExportProgress)=>void;failAt?:'after-write'|'before-publish'|'during-copy'}):Promise<EditorExportResult>{
 if(!path.isAbsolute(chosenPath)||chosenPath!==path.normalize(chosenPath))throw Error('导出位置无效');
 const parent=path.dirname(chosenPath);
 if(!existsSync(parent)||!lstatSync(parent).isDirectory()||realpathSync(parent)!==parent||lstatSync(parent).isSymbolicLink())throw Error('导出父目录不存在或使用别名');
 if(options.signal?.aborted)return{status:'cancelled'};
 const {bundle,assets,markdown:originalMarkdown}=prepareMarkdown(repository,workspaceId,kind,expected);
 const media=options.includeLocalMedia?mediaInputs(repository,workspaceId):[];
 if(media.some(x=>x.item.status==='missing'))throw Error('所选音视频有缺失或不可访问项，请恢复原资源后重试，或关闭“包含本地音视频”');
 const totalBytes=[...assets.values()].reduce((n,a)=>n+a.bytes.length,0)+media.reduce((n,m)=>n+m.item.bytes,0);
 let copiedBytes=0;
 const progress=(phase:EditorExportProgress['phase'],currentFile?:string)=>{assertNotCancelled(options.signal);options.onProgress?.({operationId:options.operationId,phase,copiedBytes,totalBytes,...(currentFile?{currentFile}:{})});};
 progress('preparing');
 const base=exportFilename(path.basename(chosenPath).replace(/\.md$/i,'')||bundle.workspace.userTitle),temp=await mkdtemp(path.join(parent,'.rlw-export-'));
 let markdown=originalMarkdown,target:string|undefined;
 const mediaNames=media.map(m=>({input:m,name:`media-${m.item.mediaId}${mediaExtension(m.file!,m.mime)}`}));
 if(options.includeLocalMedia){
  const description=mediaNames.length?'本包包含以下所选本地音视频（整段文件；不声明逐句时间）：\n\n'+mediaNames.map(m=>`- [${m.input.item.label.replace(/[\r\n]/g,' ').replace(/([\\`*_\[\]<>])/g,'\\$1')}](media/${m.name})（${m.input.item.bytes} 字节）`).join('\n'):'本收藏所选来源没有需要包含的本地音视频。';
  markdown=markdown.replace('音视频文件未包含。',description+'\n\n');
 }
 try{
  if(assets.size)await mkdir(path.join(temp,'assets'));
  if(media.length)await mkdir(path.join(temp,'media'));
  await durableWrite(path.join(temp,`${base}.md`),markdown);
  for(const asset of assets.values()){
   progress('copying',asset.name);await durableWrite(path.join(temp,'assets',asset.name),asset.bytes);
   if(sha256(await readFile(path.join(temp,'assets',asset.name)))!==asset.sha)throw Error('导出图片校验失败');
   copiedBytes+=asset.bytes.length;progress('copying',asset.name);
  }
  for(const {input,name}of mediaNames){
   progress('copying',input.item.label);
   const source=await open(input.file!,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    if(fingerprint(await source.stat())!==input.fingerprint)throw Error('本地媒体在导出前发生变化，请重新检查后导出');
    const hash=createHash('sha256');let copied=0;
    const meter=new Transform({transform(chunk:Buffer,_encoding,callback){hash.update(chunk);copied+=chunk.length;copiedBytes+=chunk.length;try{progress('copying',input.item.label);if(options.failAt==='during-copy')throw Error('injected export copy failure');callback(null,chunk);}catch(error){callback(error as Error);}}});
    const destination=path.join(temp,'media',name);
    await pipeline(source.createReadStream({autoClose:false}),meter,createWriteStream(destination,{flags:'wx',mode:0o600}),{signal:options.signal});
    const digest=hash.digest('hex');
    if(copied!==input.item.bytes||fingerprint(await source.stat())!==input.fingerprint||input.sha256&&digest!==input.sha256||await hashFile(destination,options.signal)!==digest)throw Error('导出音视频校验失败或原件发生变化');
    const written=await open(destination,'r+');try{await written.sync();}finally{await written.close();}
   }finally{await source.close();}
  }
  if(options.failAt==='after-write')throw Error('injected export failure');
  if(await readFile(path.join(temp,`${base}.md`),'utf8')!==markdown)throw Error('导出正文校验失败');
  progress('publishing');if(options.failAt==='before-publish')throw Error('injected export failure');
  if(assets.size||media.length){
   // Never publish over the chosen filename or an existing folder. A fresh,
   // exclusively reserved directory holds one atomically moved complete pack.
   let reservation:string;
   for(;;){reservation=path.join(parent,`${base}-${randomUUID()}`);try{await mkdir(reservation,{mode:0o700});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
   target=path.join(reservation,base);
   try{assertNotCancelled(options.signal);await rename(temp,target);}catch(e){await rm(reservation,{recursive:true,force:true});throw e;}
  }else{
   target=path.join(parent,`${base}.md`);let n=1;
   for(;;){assertNotCancelled(options.signal);try{await link(path.join(temp,`${base}.md`),target);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;target=path.join(parent,`${base} (${++n}).md`);}}
  }
  return{status:'exported',path:target,files:1+assets.size+media.length,draftRevision:bundle.draft.revision,mapRevision:bundle.map.revision,mediaIncluded:!!options.includeLocalMedia,mediaFiles:media.length,mediaBytes:media.reduce((n,m)=>n+m.item.bytes,0),offlineComplete:!!options.includeLocalMedia};
 }catch(error){if(options.signal?.aborted||(error as Error).name==='AbortError')return{status:'cancelled'};if(error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message))throw error;throw Error('导出写入或复制失败，请检查目标权限和剩余空间；当前稿件和已有文件保留');}
 finally{await rm(temp,{recursive:true,force:true});}
}
