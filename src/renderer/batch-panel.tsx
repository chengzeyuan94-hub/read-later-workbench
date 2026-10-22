import { PLATFORMS, PLATFORM_NAMES } from '../shared/platforms';
import React, { useEffect, useState } from 'react';
import type { ContentRecord, RecentSyncState, WorkbenchState } from '../shared/contracts';
import type { BatchDigestAPI, BatchDigestState, BatchItemState } from '../shared/batch-contracts';
import './batch-panel.css';

const labels: Record<BatchItemState,string> = {'waiting-download':'等待下载完整',queued:'排队中',processing:'正在消化',complete:'已完成',candidate:'AI 新版本待查看',failed:'需要处理','result-unknown':'远端结果未知',cancelled:'已取消'};
import { batchSelectionReason } from './batch-eligibility';
export { batchSelectionReason };
const laneClock=(until:number)=>new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(until));
export function RecentSyncSummary({scope,contents,deleted,paused,progress,syncLine,syncRange,onToggle,onResumePlatform,onLogin}:{scope:RecentSyncState;contents:ContentRecord[];deleted?:WorkbenchState['deleted'];paused:boolean;progress?:WorkbenchState['progress'];syncLine?:string;syncRange?:string;onToggle:()=>void;onResumePlatform?:(platform:string)=>void;onLogin?:(platform:string)=>void}) {
  const [optimistic,setOptimistic]=useState<boolean|null>(null);
  useEffect(()=>setOptimistic(null),[paused]);
  const effective=optimistic??paused;
  const remaining=(progress?.mediaQueued??0)+(progress?.mediaRunning??0);
  const rangeLine=syncRange==='all'?'本次检查全部收藏':`本次检查最近 ${syncRange??'100'} 条`;
  const line=effective?'下载已暂停':remaining>0?`正在下载：已保存 ${progress?.mediaSaved??0} · 剩余 ${remaining} 个文件 · 正文待取 ${progress?.bodyPending??0} 条 · 失败 ${progress?.mediaFailed??0}`:'全部下载完成';
  return <section className="batch-panel" aria-label="最近收藏同步进度"><div className="batch-heading"><h2>最近收藏同步 <small>{syncRange==='all'?'同步全部收藏':`每次同步最近 ${syncRange??'100'} 条`}</small></h2><button className="btn" onClick={()=>{setOptimistic(!effective);onToggle();}}>{effective?'继续下载':'暂停后续下载'}</button></div>{!!syncLine&&<p className="sync-last">{syncLine}</p>}<p className="download-progress" role="status">{line}</p><div className="batch-platforms">{PLATFORMS.map(platform=>{
    const current=scope.scopes.find(s=>s.platform===platform),items=current?contents.filter(c=>c.platform===platform&&c.accountId===current.accountId&&current.targetIds.includes(c.sourceId)):[];
    const deletedHere=current?(deleted??[]).filter(d=>d.platform===platform&&d.accountId===current.accountId&&current.targetIds.includes(d.sourceId)).length:0;
    const downloading=contents.filter(c=>c.platform===platform).flatMap(c=>c.media).filter(m=>m.current!==false&&(m.state==='queued'||m.state==='running')).length;
    const lane=scope.lanes?.find(l=>l.platform===platform);
    const active=lane?lane.active.details+lane.active.images+lane.active.videos:0;
    const laneText=!lane?undefined:
      lane.mode==='running'?`下载中${lane.active.details?` · 正文 ${lane.active.details}`:''}${lane.active.images?` · 图片 ${lane.active.images}`:''}${lane.active.videos?` · 视频 ${lane.active.videos}`:''}`:
      lane.mode==='cooldown'?`冷却中，${laneClock(lane.until??0)} 自动继续${lane.reason?`（${lane.reason}）`:''}`:
      lane.mode==='login'?'需要重新登录':
      lane.mode==='paused'?`已暂停${lane.reason?`（${lane.reason}）`:''}`:
      lane.mode==='done'?'已全部完成':
      active?'下载中':`排队中 · 待取 ${lane.queued.details+lane.queued.media}`;
    return <div key={platform} data-platform={platform} data-mode={lane?.mode??''}><b>{PLATFORM_NAMES[platform]}</b><span>{items.length} 条已在本地 · {items.filter(c=>c.offline).length} 条离线完整{downloading>0?` · 下载中 ${downloading}`:''}{deletedHere>0?` · 已删除 ${deletedHere}`:''}</span><small>{laneText??(current?`${rangeLine}${current.targetComplete?'':` · ${current.reason}`}`:'等待本次同步')}</small>{lane?.mode==='login'&&!!onLogin&&<button className="text-button" onClick={()=>onLogin(platform)}>去登录</button>}{lane?.mode==='paused'&&!!onResumePlatform&&<button className="text-button" onClick={()=>onResumePlatform(platform)}>继续此平台</button>}</div>;
  })}</div><p>旧收藏与人工稿保留；只处理明确选中的内容。</p>{!!scope.pausedContentDownloads?.length&&<p role="status">{scope.pausedContentDownloads.length} 条收藏未纳入自动下载，原始记录保留。</p>}</section>;
}

export async function createBatch(api:BatchDigestAPI,selected:ContentRecord[],readState:()=>Promise<WorkbenchState>,onBatchItems:(ids:number[])=>void):Promise<{created:number;excluded:number;owned:number[]}>{
  const [state,currentBatches]=await Promise.all([readState(),api.list()]);
  const owned=currentBatches.flatMap(batch=>batch.items.filter(item=>!['complete','candidate','failed','result-unknown','cancelled'].includes(item.state)).map(item=>item.contentId));onBatchItems(owned);
  const eligible=selected.map(item=>state.contents.find(content=>content.id===item.id)).filter((content):content is ContentRecord=>!!content&&!batchSelectionReason(content,state,owned));
  if(!eligible.length)throw Error('所选内容已完成、已在批次中或不在本轮范围，选择已更新。');
  await api.create(eligible.map(item=>item.id));
  return{created:eligible.length,excluded:selected.length-eligible.length,owned};
}
export function BatchPanel({api,selected,onClear,onOpen,onRefresh,onBatchItems,readState,embedded}:{api:BatchDigestAPI;selected:ContentRecord[];onClear:()=>void;onOpen:(contentId:number)=>void;onRefresh:()=>void;onBatchItems:(ids:number[])=>void;readState:()=>Promise<WorkbenchState>;embedded?:boolean}) {
  const [batches,setBatches]=useState<BatchDigestState[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const refresh=async()=>{try{const current=await api.list();setBatches(current);onBatchItems(current.flatMap(batch=>batch.items.filter(item=>!['complete','candidate','failed','result-unknown','cancelled'].includes(item.state)).map(item=>item.contentId)));}catch{setError('暂时无法读取批次进度，已有资料保留。');}};
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>clearInterval(timer);},[api,onBatchItems]);
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await refresh();onRefresh();}catch(e){setError(e instanceof Error?e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/,''):'批次操作未完成');}finally{setBusy(false);}};
  const media=selected.flatMap(c=>c.media.filter(m=>m.current!==false)),minutes=media.filter(m=>m.kind!=='image').reduce((n,m)=>n+(m.durationSeconds??0)/60,0);
  const createSelected=async()=>{
    setNotice('');
    const result=await createBatch(api,selected,readState,onBatchItems);
    onClear();
    if(result.excluded)setNotice(`已排除 ${result.excluded} 条状态变化的内容，为其余 ${result.created} 条建立消化批次。`);
  };
  const selectionBar=<div className="batch-heading"><div><h2>批量消化</h2><p>已选 {selected.length} 条 · {media.filter(m=>m.kind==='image').length} 张图片 · 已知音视频 {minutes.toFixed(1)} 分钟</p></div><div className="batch-actions"><button className="btn" disabled={!selected.length||busy} onClick={onClear}>清空</button><button className="btn-primary" disabled={!selected.length||busy} onClick={()=>void run(createSelected)}>消化所选 {selected.length||''}</button></div></div>;
  return <section className="batch-panel" aria-label="处理队列">{!embedded&&selectionBar}{error&&<p role="alert" className="inline-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {batches.map((batch,index)=>{const summary=[`${batch.items.length} 条`,batch.counts.complete?`已完成 ${batch.counts.complete}`:'',batch.counts.candidate?`AI 新版本 ${batch.counts.candidate}`:'',batch.counts.failed+batch.counts['result-unknown']?`需处理 ${batch.counts.failed+batch.counts['result-unknown']}`:'',(batch.counts.processing||batch.counts.queued||batch.counts['waiting-download'])?`进行中 ${(batch.counts.processing||0)+(batch.counts.queued||0)+(batch.counts['waiting-download']||0)}`:''].filter(Boolean).join(' · ');return <details className="batch-run" key={batch.id} open={index===0}><summary>{summary} <span>{batch.state==='paused'?'已暂停':batch.state==='complete'?'已完成':batch.state==='attention'?'查看原因':'进行中'}</span></summary><div className="batch-run-body"><div className="batch-heading"><p>本批用量：转录 {batch.budget.asrMinutes.toFixed(1)} 分钟 · 上传 {batch.budget.asrPosts} 次 · 生成 {batch.budget.generationPosts} 次</p>{batch.state!=='complete'&&<button className="btn" disabled={busy} onClick={()=>void run(()=>batch.state==='running'?api.pause(batch.id):api.resume(batch.id))}>{batch.state==='running'?'暂停后续处理':'继续此批次'}</button>}</div>{batch.reason&&<p>{batch.reason}</p>}<ul className="batch-items">{batch.items.map(item=><li key={item.contentId}><button className="text-button" onClick={()=>onOpen(item.contentId)}>{item.title}</button><span>{item.state==='processing'?(item.stages.find(stage=>stage.state==='running')?.label||item.stages.find(stage=>stage.required&&!['succeeded','not-required'].includes(stage.state))?.label||labels[item.state]):labels[item.state]}</span>{item.reason&&<small>{item.reason}</small>}{item.state==='failed'&&item.retryCount<1&&item.requestId&&<button className="btn" disabled={busy} onClick={()=>void run(()=>api.retry(batch.id,item.contentId))}>重试</button>}{!['complete','candidate','cancelled'].includes(item.state)&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>api.cancelItem(batch.id,item.contentId))}>取消此条</button>}</li>)}</ul></div></details>;})}
    {!batches.length&&<p className="e3-muted">暂无处理队列。</p>}
  </section>;
}
