import React, { useEffect, useState } from 'react';
import type { AsrAPI, AsrContentState, AsrJobState } from '../shared/asr-contracts.js';
import type { SourceReference } from '../editor-core/model.js';
import './asr-workspace.css';

export interface AsrOpenTarget { contentId: number; resultId: string; revision?: number; range?: SourceReference['range'] }
export const asrJobLabel: Record<AsrJobState, string> = { preparing: '正在探测／准备本地音频', queued: '待上传', uploading: '正在转录', succeeded: '转录已保存 · 待校对', 'waiting-network': '等待联网', 'waiting-configuration': '等待转录配置', 'waiting-files': '等待固定原件', 'result-unknown': '远端结果未知 · 需明确重试', failed: '本项失败', cancelled: '已取消' };
export function AsrResultsPanel({ api, contentId, onOpen, compact = false, onConfigure, pipelineComplete = false }: { api: AsrAPI; contentId: number; onOpen(target: AsrOpenTarget): void; compact?: boolean; onConfigure?(): Promise<void>; pipelineComplete?: boolean }) {
  const [state, setState] = useState<AsrContentState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState<number | null>(null);
  useEffect(() => { let active = true; const read = () => { void api.list(contentId).then(value => { if (active) { setState(value); setError(''); } }).catch(() => { if (active) setError('转录状态暂不可读，已有资料保留。'); }); }; read(); const timer = setInterval(read, 1500); return () => { active = false; clearInterval(timer); }; }, [api, contentId]);
  async function retry(mediaId: number, acknowledgeUnknown = false) { setBusy(true); try { setState(await api.retry(contentId, mediaId, acknowledgeUnknown)); setUnknown(null); setError(''); } catch (error) { setError(error instanceof Error ? error.message : '重试未完成。'); } finally { setBusy(false); } }
  const progress = state?.progress;
  return <section className={`e2-asr-panel ${compact ? 'compact' : ''}`} aria-label="音视频转录结果" data-testid="asr-results-panel"><header><h3>音视频转录{progress && progress.totalChunks > 0 ? ` ${progress.succeeded}/${progress.totalChunks} 输入分片` : ''}</h3></header>
    {!state ? <p role="status">正在读取转录状态…</p> : <>
      {!state.authorized && <p>本条尚未建立转录请求。如需转录，请使用「消化」或明确恢复本条请求。</p>}
      {progress && <p className="e2-muted">本次 {progress.totalMedia} 个媒体／分P，已准备 {progress.preparedMedia} 个；确定分片 {progress.totalChunks} 个，已保存 {progress.succeeded} 个。</p>}
      {!state.capability.available && <p role="status">{state.capability.reason || '转录能力尚未就绪。'}</p>}
      {!state.capability.configured && (onConfigure || api.configureCredentials) && <button disabled={busy} onClick={() => { setBusy(true); void (onConfigure ? onConfigure() : api.configureCredentials!()).catch(() => setError('安全配置未完成。')).finally(() => setBusy(false)); }} className="btn">安全配置转录密钥</button>}
      {progress && progress.totalChunks > 0 && progress.succeeded === progress.totalChunks && progress.preparedMedia === progress.totalMedia && <p className="e2-asr-ready">{pipelineComplete ? '本次转录来源已保存。完整成果与新版本状态见笔记顶栏。' : '转录已完成，等待整理／生成。完整消化尚未完成，不新增消化库记录。'}</p>}
      <ol className="e2-asr-jobs">{state.jobs.map(job => <li key={job.id} data-asr-state={job.state} data-asr-media={job.mediaId}><div><strong>{job.title || `媒体 ${job.mediaId}`} · {job.partId}{job.chunkOrder === undefined ? '' : ` · 输入分片 ${job.chunkOrder + 1}`}</strong><span>{asrJobLabel[job.state]}{job.reused ? ' · 已保存结果复用' : ''}</span>{job.inputRange && <small>输入范围 {job.inputRange.startMs}–{job.inputRange.endMs} ms。</small>}{job.error && <small role="alert">{job.error}</small>}</div>{job.resultId && <button data-testid="asr-open-result" onClick={() => onOpen({ contentId, resultId: job.resultId!, revision: 1 })}>查看转录／校对</button>}{['failed', 'waiting-network', 'waiting-configuration', 'waiting-files', 'result-unknown'].includes(job.state) && <button disabled={busy} onClick={() => job.retryMayDuplicateCharge || job.state === 'result-unknown' ? setUnknown(job.mediaId) : void retry(job.mediaId)}>重试此媒体未完成分片</button>}</li>)}</ol>
      {unknown !== null && <div className="e2-asr-warning" role="alert"><p>此输入曾提交但本地未取得确定结果。重新上传可能产生重复调用与计费。</p><button disabled={busy} onClick={() => void retry(unknown, true)}>明确重新上传此媒体未完成分片</button><button onClick={() => setUnknown(null)}>暂不重发</button></div>}
      {state.results.some(result => !result.active) && <details><summary>历史转录版本</summary><ul>{state.results.filter(result => !result.active).map(result => <li key={result.resultId}>{result.partId} · 输入分片 {result.chunkOrder + 1}<button onClick={() => onOpen({ contentId, resultId: result.resultId, revision: result.adopted.revision })}>查看保留版本</button></li>)}</ul></details>}
    </>}{error && <p className="e2-error" role="alert">{error}</p>}</section>;
}
