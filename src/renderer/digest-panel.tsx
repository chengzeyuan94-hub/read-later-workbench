import React, { useEffect, useRef, useState } from 'react';
import { activeDigestRequest, digestStatusLabel, type DigestAPI, type DigestArtifactResult, type DigestContentState } from '../shared/digest-contracts.js';
import { DigestArticle } from './digest-article';
import type { OcrAPI } from '../shared/ocr-contracts.js';
import { OcrResultsPanel, type OcrOpenTarget } from './ocr-panel.js';
import type { AsrAPI } from '../shared/asr-contracts.js';
import { AsrResultsPanel, type AsrOpenTarget } from './asr-panel.js';

import { asrProgressText } from './digest-queue.js';
const stageStatus: Record<string, string> = {
  'not-required': '本条资料不需要此步骤', queued: '等待处理', running: '正在处理',
  'waiting-capability': '能力尚未接入', 'waiting-network': '等待联网', 'waiting-configuration': '等待转录配置', 'result-unknown': '远端结果未知，需明确重试', 'waiting-files': '等待本地资料',
  'waiting-content': '缺少可整理内容', failed: '此步骤失败', cancelled: '已取消', succeeded: '结果已保存',
};
export function DigestProgress({ state, api, ocrApi, onOpenOcr, asrApi, onOpenAsr, contentId, error, busy, onClose, onCancel, onRetry, onRequest, onRemove }: {
  state: DigestContentState | undefined; api?: DigestAPI; ocrApi?: OcrAPI; onOpenOcr?(target: OcrOpenTarget): void; asrApi?: AsrAPI; onOpenAsr?(target: AsrOpenTarget): void; contentId: number; error?: string; busy: boolean; onClose(): void; onCancel(): void; onRetry(): void; onRequest(renew?: boolean): void; onRemove(): void;
}) {
  const host = useRef<HTMLDialogElement>(null), origin = useRef<HTMLElement | null>(null), [renew, setRenew] = useState(false);
  const [artifact, setArtifact] = useState<DigestArtifactResult | null>(null);
  useEffect(() => {
    let current = true; setArtifact(null);
    if (api) void api.artifact(contentId).then(result => { if (current) setArtifact(result); }).catch(() => { if (current) setArtifact({ state: 'not-ready', reason: '成稿版本或附件暂不可读，请检查本地资料后重试。' }); });
    return () => { current = false; };
  }, [api, contentId, state?.library?.requestId, state?.library?.active, state?.library?.completedAt]);
  useEffect(() => {
    origin.current = document.activeElement as HTMLElement; host.current?.showModal();
    return () => { host.current?.close(); if (origin.current?.isConnected) origin.current.focus(); };
  }, []);
  const request = state?.request, active = !!state && activeDigestRequest(state), library = state?.library;
  return <dialog className="digest-progress-dialog" ref={host} aria-labelledby="digest-progress-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="digest-progress-title">消化进度</h2><button aria-label="关闭消化进度" onClick={onClose}>×</button></header>
    <p className="digest-current-state" role="status">{state ? digestStatusLabel(state) : '正在读取请求状态…'}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {library?.legacy && <p className="digest-history-note">已消化 · 早期标记，保留原归类与时间。</p>}
    {(request?.synthetic || library?.synthetic) && <p className="digest-history-note">合成任务验证。本条处理结果不计入真实消化链路验收。</p>}
    {library?.candidate && <p className="digest-history-note">AI 新版本待查看。当前人工正文与导图保留。</p>}
    {!request && <p>点击消化会按本条收藏当前的来源版本和媒体范围建立处理请求。手工整理与普通导出独立可用。</p>}
    {!!request && <p>本次范围：{request.inputScope.media.filter(m => m.kind === 'image').length} 张图片、{request.inputScope.media.filter(m => m.kind === 'video').length} 段视频、{request.inputScope.media.filter(m => m.kind === 'audio').length} 段音频。</p>}
    {request?.sourceUpdated && <p className="digest-history-note">来源已更新，当前请求仍使用原范围。</p>}
    <ol className="digest-stages">{state?.stages.map(stage => <li key={stage.name}><strong>{stage.label}</strong><span>{stageStatus[stage.state] || '等待处理'}</span>{stage.transcription && stage.transcription.totalChunks > 0 && <small>{asrProgressText(stage.transcription)}</small>}{stage.reused && <small>复用已保存结果</small>}{stage.error && <small role="alert">{stage.error}</small>}</li>)}</ol>
    {ocrApi && onOpenOcr && <OcrResultsPanel waitingAsr={state?.stages.some(stage => stage.name === 'asr' && stage.required && stage.state !== 'succeeded')} api={ocrApi} contentId={contentId} onOpen={onOpenOcr} compact />}
    {asrApi && onOpenAsr && <AsrResultsPanel api={asrApi} contentId={contentId} onOpen={onOpenAsr} compact />}
    {state?.readiness.reasons.length ? <section className="digest-readiness"><h3>当前可用范围</h3>{state.readiness.reasons.map(reason => <p key={reason}>{reason}</p>)}<p>可阅读、校对图片文字、手工整理与导出。</p></section> : null}
    <p className="digest-history-note">完整成果校验保存后进入消化库；音视频不包含在 Markdown 附件中。</p>
    {artifact?.state === 'ready' ? <DigestArticle artifact={artifact} assetUrl={relative => `rlw-digest://local/${contentId}/${relative.split('/').map(encodeURIComponent).join('/')}`} /> : <p className="digest-history-note">{artifact?.state === 'not-ready' ? artifact.reason : '成稿预览尚未就绪。'}</p>}
    <footer>
      {!request && <button className="btn-primary" disabled={busy} onClick={() => onRequest()}>消化本条收藏</button>}
      {active && <button className="btn" disabled={busy} onClick={onCancel}>取消本次消化</button>}
      {request?.state === 'failed' && <button className="btn-primary" disabled={busy} onClick={onRetry}>重试</button>}
      {request?.state === 'cancelled' && <button className="btn" disabled={busy} onClick={() => onRequest()}>重新消化</button>}
      {request && <button className="text-button" disabled={busy} onClick={() => setRenew(value => !value)}>重新消化</button>}
      {library?.active && <button className="text-button" disabled={busy} onClick={onRemove}>从消化库移出</button>}
      <button className="btn" onClick={onClose}>返回阅读与整理</button>
    </footer>
    {renew && <div className="digest-renew"><p>重新固定当前来源和媒体范围，并使原请求失效。已有成果和人工稿继续保留。</p><button className="btn-primary" disabled={busy} onClick={() => { setRenew(false); onRequest(true); }}>确认重新请求本条</button><button className="btn" onClick={() => setRenew(false)}>保留原请求</button></div>}
  </dialog>;
}
