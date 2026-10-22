// E4.3 P1 shared renderer terms + pure decision helpers (unit-tested).
// digestStatusLabel lives in src/shared and keeps its vocabulary; these helpers
// translate its output and related state into the E4.3 terms without touching contracts.
import type { ContentRecord, MediaRecord, ProcessingConfiguration, WorkbenchState } from '../shared/contracts.js';
import type { DigestContentState } from '../shared/digest-contracts.js';
import { activeDigestRequest, digestStatusLabel } from '../shared/digest-contracts.js';

const termMap: Record<string, string> = {
 '历史入库，尚未完成新消化': '已消化 · 早期标记',
 '已入库 · 新生成版本待采用': '已消化 · AI 新版本待查看',
 '已完成入库': '已消化',
 '消化失败，可重试': '需要处理',
 '已取消消化': '已取消',
 '未开始消化': '未消化',
 '远端处理结果未知，需明确重试': '远端结果未知',
 '排队等待': '正在消化 · 排队中',
};
/** Map shared digestStatusLabel output to E4.3 terms. Keeps synthetic/legacy prefixes. */
export function digestStateLabel(state: DigestContentState | undefined, legacyByDate?: boolean): string {
 if (!state) return legacyByDate ? '已消化 · 早期标记' : '未消化';
 const raw = digestStatusLabel(state);
 const synthetic = state.library?.active && state.library.synthetic ? '模拟验证 · ' : '';
 const legacyRunning = state.library?.active && state.library.legacy && activeDigestRequest(state) ? '已消化 · 早期标记 · ' : '';
 return synthetic + legacyRunning + (termMap[raw] ?? raw);
}
export const kindShortName: Record<string, string> = { image: '图文', video: '视频', audio: '音频', text: '文字' };
export const platformShortName = (platform: string): string => ({ xiaohongshu: '小红书', bilibili: 'B站', weibo: '微博', zhihu: '知乎', twitter: 'X' })[platform] ?? platform;

/** Card status chip, priority 失败 > 处理中 > 自动下载已暂停 > 已消化 > 未完整离线. */
export type CardChip = 'failed' | 'processing' | 'paused' | 'digested' | 'incomplete';
export function cardChip(input: { failed?: boolean; processing?: boolean; paused?: boolean; digested?: boolean; offlineComplete?: boolean }): CardChip | null {
 if (input.failed) return 'failed';
 if (input.processing) return 'processing';
 if (input.paused) return 'paused';
 if (input.digested) return 'digested';
 if (!input.offlineComplete) return 'incomplete';
 return null;
}
export const cardChipLabel: Record<CardChip, string> = { failed: '保存失败', processing: '处理中', paused: '自动下载已暂停', digested: '已消化', incomplete: '未完整离线' };

/** Per-card footer action: 消化 / 查看进度 / 打开笔记 (paused disables it, label 自动下载已暂停). */
export function cardAction(input: { digested?: boolean; processing?: boolean; paused?: boolean }): 'digest' | 'progress' | 'note' | 'paused' {
 if (input.paused) return 'paused';
 if (input.digested) return 'note';
 if (input.processing) return 'progress';
 return 'digest';
}
export const cardActionLabel: Record<ReturnType<typeof cardAction>, string> = { digest: '消化', progress: '查看进度', note: '打开笔记', paused: '自动下载已暂停' };

/** E4.3 §9a precheck: returns what is missing before a new digest request may start. */
export interface PrecheckMissing { generationConfigured: boolean; generationNetwork: boolean; asrConfigured: boolean; asrNetwork: boolean }
export function precheckMissing(config: ProcessingConfiguration | undefined, needsAsr: boolean): PrecheckMissing | null {
 if (!config) return null; // old runtimes: keep current behaviour
 const missing: PrecheckMissing = {
  generationConfigured: !config.generationConfigured,
  generationNetwork: config.generationNetworkAllowed === false,
  asrConfigured: needsAsr && !config.asrConfigured,
  asrNetwork: needsAsr && config.asrNetworkAllowed === false,
 };
 return Object.values(missing).some(Boolean) ? missing : null;
}
export function precheckNeedsAsr(content: Pick<ContentRecord, 'kind' | 'media'>): boolean {
 return content.kind === 'video' || content.kind === 'audio' || content.media.some(media => media.current !== false && (media.kind === 'video' || media.kind === 'audio'));
}

/** Bottom selection bar counts: 已选 N 条 · 图片 X 张 · 已知音视频 Y 分钟. */
export function selectionStats(items: { media: MediaRecord[] }[]): { count: number; images: number; avMinutes: number } {
 const media = items.flatMap(item => item.media.filter(m => m.current !== false));
 return { count: items.length, images: media.filter(m => m.kind === 'image').length, avMinutes: media.filter(m => m.kind !== 'image').reduce((n, m) => n + (m.durationSeconds ?? 0) / 60, 0) };
}

/** Sync chip text: 小红书 129 · B站 115 … — per-platform local counts. */
export function syncChipText(state: WorkbenchState): string {
 const scope = state.recentSync; if (!scope) return '';
 const remaining = (state.progress?.mediaQueued ?? 0) + (state.progress?.mediaRunning ?? 0);
 return scope.scopes.map(entry => {
  const local = state.contents.filter(c => c.platform === entry.platform && c.accountId === entry.accountId).length;
  return `${platformShortName(entry.platform)} ${local}`;
 }).join(' · ') + (remaining > 0 ? ` · 下载中 剩 ${remaining}` : '');
}

export interface SyncRunSummary { at: number; platforms: number; saved: number; limited: boolean }
/** The latest finished run = sync rows starting within `windowMs` of the newest start. */
export function syncRunSummary(syncs: WorkbenchState['syncs'], windowMs = 120_000): SyncRunSummary | null {
 if (!syncs.length) return null;
 const at = Math.max(...syncs.map(s => s.startedAt));
 const run = syncs.filter(s => s.state !== 'running' && at - s.startedAt <= windowMs);
 if (!run.length) return null;
 return { at, platforms: run.length, saved: run.reduce((n, s) => n + s.saved, 0), limited: run.some(s => s.state !== 'succeeded') };
}
export function syncRunLine(syncs: WorkbenchState['syncs'], date: (at: number) => string): string {
 const run = syncRunSummary(syncs);
 return run ? `最近同步 ${date(run.at)} · ${run.platforms} 个平台完成 · 新增 ${run.saved} 条${run.limited ? ' · 部分平台受限' : ''}` : '';
}

/** E4.5 top progress bar: pure state → {mode,pct,label}; `history` is a mutable
 *  session ref the caller keeps between renders. */
export interface TopProgressHistory { maxPct: number; samples: { at: number; saved: number }[]; hadWork: boolean; finishedAt: number }
export const topProgressHistory = (): TopProgressHistory => ({ maxPct: 0, samples: [], hadWork: false, finishedAt: 0 });
export type TopProgressMode = 'hidden' | 'syncing' | 'downloading' | 'cooldown' | 'paused' | 'finished';
export interface TopProgressResult { mode: TopProgressMode; pct: number; label: string; until?: number }
const topProgressClock = (until: number) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(until));
export function topProgress(state: Pick<WorkbenchState, 'busy' | 'progress' | 'downloadsPaused' | 'recentSync'>, history: TopProgressHistory, now: number): TopProgressResult {
 const progress = state.progress;
 const saved = progress?.mediaSaved ?? 0;
 const remaining = (progress?.mediaQueued ?? 0) + (progress?.mediaRunning ?? 0);
 if (state.busy.length) {
  const names = state.busy.slice(0, 3).map(platformShortName).join('、');
  return { mode: 'syncing', pct: 0, label: `正在同步收藏列表：${names}${state.busy.length > 3 ? '…' : ''}` };
 }
 if (remaining > 0) history.hadWork = true;
 if (remaining === 0 && history.hadWork) { history.finishedAt = now; history.hadWork = false; history.maxPct = 0; }
 if (remaining === 0) {
  if (history.finishedAt && now - history.finishedAt < 3000) return { mode: 'finished', pct: 100, label: '全部下载完成' };
  history.finishedAt = 0;
  return { mode: 'hidden', pct: 0, label: '' };
 }
 history.finishedAt = 0;
 if (state.downloadsPaused) return { mode: 'paused', pct: history.maxPct, label: '下载已暂停' };
 const lanes = state.recentSync?.lanes ?? [];
 const working = lanes.filter(lane => lane.queued.details + lane.queued.media + lane.active.details + lane.active.images + lane.active.videos > 0);
 if (working.length && working.every(lane => lane.mode === 'cooldown' || lane.mode === 'paused' || lane.mode === 'login')) {
  const untils = working.filter(lane => lane.mode === 'cooldown' && lane.until).map(lane => lane.until!);
  const earliest = untils.length ? Math.min(...untils) : undefined;
  return { mode: 'cooldown', pct: history.maxPct, until: earliest, label: earliest ? `等待平台冷却 · ${topProgressClock(earliest)} 自动继续` : '部分平台需要处理' };
 }
 const pct = Math.max(0, Math.min(100, Math.round((saved / (saved + remaining)) * 100)));
 history.maxPct = Math.max(history.maxPct, pct);
 history.samples.push({ at: now, saved });
 history.samples = history.samples.filter(sample => now - sample.at <= 60_000);
 let eta = '';
 if (history.samples.length >= 3) {
  const first = history.samples[0], last = history.samples[history.samples.length - 1];
  const rate = last.at > first.at ? (last.saved - first.saved) / (last.at - first.at) : 0;
  if (rate > 0) eta = ` · 约 ${Math.max(1, Math.ceil(remaining / rate / 60_000))} 分钟`;
 }
 return { mode: 'downloading', pct: history.maxPct, label: `下载中 ${history.maxPct}% · 剩余 ${remaining} 个文件${eta}` };
}
