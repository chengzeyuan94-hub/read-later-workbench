import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AsrRepository, AsrAuthorization } from './asr-store.js';
import { boundedFile } from './editor-media.js';
import { asrFileSha256 } from './asr-media.js';
import { mediaResponse } from './media.js';
import { toStoredPath } from './fs-paths.js';
import type { MediaRecord } from '../shared/contracts.js';
/** Playback always resolves the exact source part frozen for this saved result. */
export async function asrMediaResponse(request:Request,repository:AsrRepository,contentId:number,resultId:string):Promise<Response>{
 try{
  const result=repository.read(contentId,resultId,1).result;
  const row=repository.db.prepare('SELECT json FROM asr_authorizations WHERE request_id=? AND content_id=?').get(result.requestId,contentId) as {json:string}|undefined;
  if(!row)throw Error();const authorization=JSON.parse(row.json) as AsrAuthorization;
  const item=authorization.media.find(m=>m.media.id===result.mediaId&&m.partId===result.partId&&m.sourceIdentity===result.sourceIdentity);
  if(!item||item.media.sha256!==result.originalSha256)throw Error();
  const root=repository.digest.inputsDir,file=boundedFile(root,item.relativePath),info=await stat(file);
  if(info.size!==item.media.bytes||await asrFileSha256(file)!==result.originalSha256)throw Error();
  return mediaResponse(request,root,{id:result.mediaId,state:'succeeded',localPath:toStoredPath(path.relative(root,file)),mime:item.media.mime} as MediaRecord);
 }catch{return new Response('本次转录的固定原件缺失、变化或不属于此媒体／分P',{status:404});}
}
