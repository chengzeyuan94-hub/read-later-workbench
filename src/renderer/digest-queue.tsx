import React from 'react';
import type { DigestContentState, DigestStageRecord } from '../shared/digest-contracts';
import type { BatchDigestItem, BatchDigestState, BatchItemState } from '../shared/batch-contracts';
import type { ProcessingConfiguration } from '../shared/contracts';
import { shanghaiDayStart } from '../shared/shanghai-time';

/** E4.13：转录阶段的分钟与分片进度，抽屉与工作区共用同一格式。 */
export function asrProgressText(t: { doneMs: number; totalMs: number; doneChunks: number; totalChunks: number }): string {
  return `已转 ${(t.doneMs / 60_000).toFixed(1)} / ${(t.totalMs / 60_000).toFixed(1)} 分钟 · 第 ${t.doneChunks}/${t.totalChunks} 段`;
}

/** E4.13：顶部「消化中 N」抽屉——批量与单条消化请求统一排队展示。 */
export type QueueFix = 'open' | 'settings-asr' | 'settings-generation' | 'enable-network' | 'retry';
export interface QueueRow {
  contentId: number; title: string; requestId: string | null; batchId: string | null;
  batchItemState: BatchItemState | null;
  /** 下载 / 识别图片 / 转录 / 整理 / 导图 / 排队 */
  stage: string; stageState: string;
  progress: string | null;
  /** 当前阶段开始时间（epoch ms）；无明确时间记 null。 */
  since: number | null;
  kind: 'active' | 'waiting' | 'failed';
  reason: string | null; fix: QueueFix | null;
}

const FIX_LABELS: Record<QueueFix, string> = {
  open: '查看下载', 'settings-asr': '去设置填写', 'settings-generation': '去设置填写',
  'enable-network': '开启', retry: '重试',
};
const STAGE_NAMES: Record<string, string> = { ocr: '识别图片', asr: '转录', organize: '整理', markdown: '整理', map: '导图' };
const OPEN_STATES = ['queued', 'processing', 'waiting-download', 'failed', 'result-unknown'];

/** 具体阻塞原因与可用修复动作；null 表示无需展示的等待。 */
export function queueBlockReason(input: {
  stageName?: string; stageState?: string; requestState?: string; itemState?: string; itemReason?: string;
  config?: ProcessingConfiguration; online?: boolean;
}): { reason: string; fix: QueueFix | null } | null {
  const itemReason = input.itemReason?.trim() || undefined;
  const state = input.stageState ?? input.requestState ?? input.itemState;
  if (input.itemState === 'failed' || input.requestState === 'failed' || state === 'failed')
    return { reason: `失败：${itemReason ?? '处理未完成'}`, fix: 'retry' };
  if (input.itemState === 'result-unknown' || input.requestState === 'result-unknown' || state === 'result-unknown')
    return { reason: itemReason ? `结果未知：${itemReason}` : '结果未知：上次调用可能已提交，明确重试可能再次计费', fix: null };
  if (itemReason?.includes('冷却')) return { reason: itemReason.startsWith('平台冷却中') ? itemReason : `平台冷却中：${itemReason}`, fix: null };
  if (state === 'waiting-configuration')
    return input.stageName === 'asr'
      ? { reason: '缺少转录密钥', fix: 'settings-asr' }
      : { reason: '缺少整理密钥', fix: 'settings-generation' };
  if (state === 'waiting-network') {
    if (input.config?.asrNetworkAllowed === false || input.config?.generationNetworkAllowed === false)
      return { reason: 'AI 处理未开启', fix: 'enable-network' };
    if (input.online === false) return { reason: '当前离线，联网后继续', fix: null };
    return { reason: '等待联网', fix: null };
  }
  if (input.itemState === 'waiting-download' || state === 'waiting-files')
    return { reason: itemReason ?? '等待下载完整', fix: 'open' };
  if (state === 'waiting-content') return { reason: itemReason ?? '缺少可整理内容', fix: null };
  if (state === 'waiting-capability') return { reason: itemReason ?? '等待处理能力就绪', fix: null };
  return null;
}

function stageProgress(stage: DigestStageRecord | undefined): string | null {
  if (!stage) return null;
  if (stage.name === 'asr' && stage.transcription && stage.transcription.totalChunks > 0) return asrProgressText(stage.transcription);
  if (stage.name === 'ocr' && stage.progress) return `图片 ${stage.progress.succeeded + stage.progress.noText}/${stage.progress.total}`;
  if (['organize', 'map', 'markdown'].includes(stage.name) && stage.attempts > 0) return `${stage.label} · 第 ${stage.attempts} 次尝试`;
  return null;
}

function currentStage(stages: DigestStageRecord[]): DigestStageRecord | undefined {
  return stages.find(stage => stage.state === 'running')
    ?? stages.find(stage => stage.required && !['succeeded', 'not-required', 'cancelled'].includes(stage.state));
}

/** 汇总批次条目与独立消化请求为统一的队列行；同一收藏只出现一次。 */
export function buildQueueRows(digests: DigestContentState[], batches: BatchDigestState[], config?: ProcessingConfiguration, online?: boolean, titles?: ReadonlyMap<number, string>): QueueRow[] {
  const digestByContent = new Map(digests.map(state => [state.contentId, state]));
  const rows: QueueRow[] = [];
  const seen = new Set<number>();
  for (const batch of batches) {
    if (batch.state === 'complete') continue;
    for (const item of batch.items) {
      if (!OPEN_STATES.includes(item.state)) continue;
      seen.add(item.contentId);
      rows.push(rowFor(item, batch.id, digestByContent.get(item.contentId), config, online, titles));
    }
  }
  for (const digest of digests) {
    if (seen.has(digest.contentId) || !digest.request || ['complete', 'cancelled'].includes(digest.request.state)) continue;
    rows.push(rowFor(null, null, digest, config, online, titles));
  }
  return rows;
}

function rowFor(item: BatchDigestItem | null, batchId: string | null, digest: DigestContentState | undefined, config?: ProcessingConfiguration, online?: boolean, titles?: ReadonlyMap<number, string>): QueueRow {
  const stages = item?.stages?.length ? item.stages : (digest?.stages ?? []);
  const stage = item?.state === 'waiting-download' ? undefined : currentStage(stages);
  const requestState = digest?.request?.state, itemState = item?.state;
  const failed = itemState === 'failed' || itemState === 'result-unknown' || requestState === 'failed' || requestState === 'result-unknown';
  const waiting = !failed && (itemState === 'waiting-download' || itemState === 'queued' || requestState === 'queued'
    || stage?.state.startsWith('waiting-') || requestState?.startsWith('waiting-'));
  const block = queueBlockReason({
    stageName: stage?.name, stageState: stage?.state, requestState, itemState, itemReason: item?.reason ?? stage?.error, config, online,
  });
  return {
    contentId: item?.contentId ?? digest!.contentId,
    title: item?.title ?? titles?.get(item?.contentId ?? digest!.contentId) ?? '',
    requestId: item?.requestId ?? digest?.request?.id ?? null,
    batchId, batchItemState: itemState ?? null,
    stage: itemState === 'waiting-download' ? '下载' : stage ? STAGE_NAMES[stage.name] ?? stage.label : '排队',
    stageState: stage?.state ?? requestState ?? itemState ?? 'queued',
    progress: stageProgress(stage),
    since: digest?.request?.updatedAt ?? item?.startedAt ?? item?.selectedAt ?? null,
    kind: failed ? 'failed' : waiting ? 'waiting' : 'active',
    reason: block?.reason ?? null, fix: block?.fix ?? null,
  };
}

/** 队列摘要：转录中 n · 等待 n · 已完成今日 n（Asia/Shanghai 自然日）。 */
export function digestQueueSummary(rows: QueueRow[], digests: DigestContentState[], now: number): { transcribing: number; waiting: number; doneToday: number } {
  const dayStart = shanghaiDayStart(now);
  return {
    transcribing: rows.filter(row => row.kind === 'active' && row.stage === '转录').length,
    waiting: rows.filter(row => row.kind === 'waiting').length,
    doneToday: digests.filter(state => state.request?.state === 'complete' && (state.request.completedAt ?? 0) >= dayStart).length,
  };
}

/** 顶栏「消化中 N」的 N：所有未结束的消化请求（含单条与批量）。 */
export function digestActiveCount(digests: DigestContentState[]): number {
  return digests.filter(state => !!state.request && !['complete', 'cancelled'].includes(state.request.state)).length;
}

export function elapsedText(since: number | null, now: number): string | null {
  if (since === null || !Number.isFinite(since)) return null;
  const ms = Math.max(0, now - since), minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚进入此阶段';
  if (minutes < 60) return `此阶段已 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `此阶段已 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
}

export function DigestQueue({ digests, batches, config, online, busy, titles, onOpen, onFix }: {
  digests: DigestContentState[]; batches: BatchDigestState[]; config?: ProcessingConfiguration; online?: boolean; busy?: boolean;
  titles?: ReadonlyMap<number, string>;
  onOpen(contentId: number): void; onFix(row: QueueRow, fix: QueueFix): void;
}) {
  const rows = buildQueueRows(digests, batches, config, online, titles);
  if (!rows.length) return null;
  const now = Date.now(), summary = digestQueueSummary(rows, digests, now);
  return <section className="digest-queue" aria-label="消化进度" data-testid="digest-queue">
    <p className="digest-queue-summary" role="status">转录中 {summary.transcribing} · 等待 {summary.waiting} · 已完成今日 {summary.doneToday}</p>
    <ul className="digest-queue-items">{rows.map(row => <li key={`${row.batchId ?? 'single'}-${row.contentId}`} data-kind={row.kind}>
      <div className="digest-queue-main">
        <button className="text-button" onClick={() => onOpen(row.contentId)}>{row.title || `收藏 ${row.contentId}`}</button>
        <span className="digest-queue-stage">{row.stage}{row.stageState === 'running' ? '中' : ''}</span>
      </div>
      {row.progress && <small className="digest-queue-progress">{row.progress}</small>}
      {elapsedText(row.since, now) && <small className="digest-queue-elapsed">{elapsedText(row.since, now)}</small>}
      {row.reason && <small className="digest-queue-reason" role={row.kind === 'failed' ? 'alert' : undefined}>{row.reason}</small>}
      {row.fix && <button className="btn" disabled={busy} onClick={() => onFix(row, row.fix!)}>{FIX_LABELS[row.fix]}</button>}
    </li>)}</ul>
  </section>;
}
