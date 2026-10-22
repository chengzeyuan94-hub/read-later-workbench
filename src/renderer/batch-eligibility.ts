import type { ContentRecord, WorkbenchState } from '../shared/contracts.js';

/** Batch card eligibility. E4.4 §6: recent-scope membership is no longer required;
 * paused downloads, finished digests, batch ownership and the initial check stay. */
export function batchSelectionReason(content:ContentRecord,state:WorkbenchState|null,ownedIds:readonly number[]|null):string|undefined {
  if(state&&state.recentSync?.pausedContentDownloads?.some(item=>item.contentId===content.id))return '此条自动下载已暂停';
  const digest=state?.digestStates?.find(item=>item.contentId===content.id);
  if(digest?.request?.state==='complete'&&!digest.request.synthetic||digest?.library?.active&&!digest.library.synthetic)return '已有消化成果，直接打开阅读';
  if(ownedIds===null)return '正在核对批次状态';
  if(ownedIds.includes(content.id))return '已加入批次，请查看批次进度';
  return undefined;
}
