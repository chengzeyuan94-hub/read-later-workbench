import { lstatSync,mkdirSync,realpathSync } from 'node:fs';
import path from 'node:path';

/** A path refusal never includes a private path or OS stack in the public error. */
export class AsrPathError extends Error {readonly code='permission-denied';constructor(){super('转录目录使用链接、别名或不安全路径；请恢复普通本地目录后重试');}}
function entry(file:string){try{return lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
/** Check every ancestor before creating the next component. Never use recursive mkdir on untrusted descendants. */
export function asrDirectory(directory:string,create=false):string{
 if(!path.isAbsolute(directory)||path.normalize(directory)!==directory)throw new AsrPathError();
 let cursor=path.parse(directory).root;
 for(const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,part);let info=entry(cursor);
  if(!info){if(!create)throw new AsrPathError();mkdirSync(cursor,{mode:0o700});info=entry(cursor);}
  if(!info||info.isSymbolicLink()||!info.isDirectory()||realpathSync(cursor)!==cursor)throw new AsrPathError();
 }
 return directory;
}
export function ensureAsrDirectory(root:string,directory:string):string{
 asrDirectory(root);if(directory!==root&&!directory.startsWith(root+path.sep))throw new AsrPathError();
 return asrDirectory(directory,true);
}
/** The temporary and published leaf are checked independently of their parent. */
export function asrPublishTarget(root:string,file:string):string{
 if(!path.isAbsolute(file)||path.normalize(file)!==file||!file.startsWith(root+path.sep))throw new AsrPathError();
 ensureAsrDirectory(root,path.dirname(file));const info=entry(file);
 if(info&&(info.isSymbolicLink()||!info.isFile()||realpathSync(file)!==file))throw new AsrPathError();
 return file;
}
