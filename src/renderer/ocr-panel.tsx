import React, { useEffect, useState } from 'react';
import type { OcrAPI, OcrContentState, OcrJobState } from '../shared/ocr-contracts.js';
import type { SourceReference } from '../editor-core/model.js';
import './ocr-workspace.css';

export interface OcrOpenTarget { contentId: number; resultId: string; correctionRevision?: number; blockId?: string; range?: SourceReference['range'] }
export const ocrJobLabel: Record<OcrJobState | 'preparing' | 'inspecting' | 'waiting-capability', string> = { preparing: '准备固定图片', inspecting: '正在验证解码与方向', 'waiting-capability': '当前策略无法继续 · 请重新请求', queued: '范围已固定 · 排队等待', running: '正在识别', succeeded: '文字已保存 · 待校对', 'no-text': '未识别到文字', partial: '部分切片待处理', 'waiting-files': '等待固定原图', failed: '图片处理失败', cancelled: '已取消' };
export function OcrResultsPanel({ api, contentId, onOpen, onProgress, compact = false, waitingAsr = false, pipelineComplete = false }: { api: OcrAPI; contentId: number; onOpen(target: OcrOpenTarget): void; onProgress?(): void; compact?: boolean; waitingAsr?: boolean; pipelineComplete?: boolean }) {
  const [state, setState] = useState<OcrContentState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { let active = true; const read = () => { void api.list(contentId).then(value => { if (active) { setState(value); setError(''); } }).catch(() => { if (active) setError('图片文字状态暂不可读，已保存内容继续保留。'); }); }; read(); const timer = setInterval(read, 1500); return () => { active = false; clearInterval(timer); }; }, [api, contentId]);
  const progress = state?.progress, completed = progress ? progress.succeeded + progress.noText : 0;
  async function retry(mediaId: number) { setBusy(mediaId); try { setState(await api.retry(contentId, mediaId)); setError(''); } catch (error) { setError(error instanceof Error ? error.message : '重试未完成，请查看消化请求状态。'); } finally { setBusy(null); } }
  return <section className={`e11-ocr-panel ${compact ? 'compact' : ''}`} aria-label="图片文字结果" data-testid="ocr-results-panel">
    <header><h3>图片文字{progress ? ` ${completed}/${progress.total}` : ''}</h3>{onProgress && <button onClick={onProgress}>查看消化进度</button>}</header>
    {state ? <>
      <p className="e11-muted">本次范围共 {state.totalMedia} 个媒体，纳入 {state.selectedMedia} 张图片。{progress && `成功 ${progress.succeeded} · 未识别到文字 ${progress.noText} · 部分 ${progress.partial} · 失败 ${progress.failed} · 待处理 ${progress.queued + progress.running + progress.waitingFiles + (progress.preparing ?? 0) + (progress.inspecting ?? 0) + (progress.waitingCapability ?? 0)}`}</p>
      {state.requestId && state.preparation && <p className="e11-muted" data-testid="ocr-preparation-state">{state.preparation.state === 'legacy' ? '这是旧策略请求，范围与坐标保持原样；新方向策略须明确重新消化。' : state.preparation.state === 'frozen' ? `解码范围冻结完成 ${state.preparation.frozen}/${state.preparation.selected}；即将识别或读取已保存结果。` : state.preparation.state === 'blocked' ? '准备受阻：请查看逐图原因。' : `正在准备授权图片 ${state.preparation.frozen}/${state.preparation.selected}：验证固定字节、完整解码与方向。`}</p>}
      {!state.requestId && <p>尚未建立本条消化请求。如需图片文字，请使用「消化」入口。</p>}
      {!state.capability.available && <p className="e11-muted">{state.capability.reason || '本地图片识别能力暂不可用。'}</p>}
      {progress && progress.total > 0 && completed === progress.total && <p className="e11-ocr-ready">{pipelineComplete ? '本次图片文字已保存。完整成果与新版本状态见笔记顶栏。' : <>{waitingAsr ? '图片文字已保存，等待音视频转录能力；随后才能整理内容。' : '图片文字已保存，等待内容整理能力。'}完整消化尚未完成。</>}</p>}
      <ol className="e11-ocr-jobs">{state.jobs.map((job, index) => <li key={job.id} data-ocr-media={job.mediaId} data-ocr-state={job.state}><div><strong>{job.title || `图片 ${index + 1}`}</strong><span>{ocrJobLabel[job.state]}{job.reused ? ' · 复用原始结果' : ''}</span>{job.error && <small role="alert">{job.error}</small>}</div>{job.resultId && <button onMouseDown={event => event.preventDefault()} data-testid="ocr-open-result" onClick={() => onOpen({ contentId, resultId: job.resultId! })}>原图对照／校对</button>}{['failed', 'partial', 'waiting-files'].includes(job.state) && (job.recovery === 'new-request' ? <div><small>这张图片尚未成功固定到本次请求。恢复条件后，请使用「重新消化」。</small>{onProgress && <button onClick={onProgress}>打开消化请求</button>}</div> : <button disabled={busy !== null} onClick={() => void retry(job.mediaId)}>{busy === job.mediaId ? '正在重排…' : '重试此图'}</button>)}</li>)}</ol>
      {!!state.selection.length && <details><summary>查看纳入与排除原因</summary><ul>{state.selection.map(item => <li key={item.mediaId}>媒体 {item.mediaId} · {item.included ? '纳入 OCR' : '未纳入'} · {item.reason}（{item.roles.join('、') || '角色未知'}）</li>)}</ul></details>}
      {state.results.some(result => !result.active) && <details><summary>历史图片文字</summary><ul>{state.results.filter(result => !result.active).map(result => <li key={result.resultId}>图片媒体 {result.mediaId} · 保留的{result.coverage === 'partial' ? '部分' : result.coverage === 'no-text' ? '未识别到文字' : '原始'}结果 <button onClick={() => onOpen({ contentId, resultId: result.resultId })}>查看历史版本</button></li>)}</ul></details>}
    </> : <p role="status">正在读取图片文字状态…</p>}
    {error && <p className="e11-error" role="alert">{error}</p>}
  </section>;
}
