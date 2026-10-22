import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAction, cardChip, digestStateLabel, precheckMissing, precheckNeedsAsr, selectionStats, syncChipText, syncRunLine, syncRunSummary, topProgress, topProgressHistory } from '../src/renderer/ui-terms.js';
import type { DigestContentState } from '../src/shared/digest-contracts.js';

const digest = (over: Partial<DigestContentState>): DigestContentState => ({ contentId: 1, request: null, stages: [], library: null, readiness: { ready: true, reasons: [] }, capabilities: { ocr: true, asr: true, organize: true, map: true, markdown: true }, ...over });

test('digestStateLabel maps shared labels to E4.3 terms', () => {
 assert.equal(digestStateLabel(undefined), '未消化');
 assert.equal(digestStateLabel(undefined, true), '已消化 · 早期标记');
 assert.equal(digestStateLabel(digest({ library: { active: true, legacy: false, source: 'ai', enteredAt: 1, completedAt: 1, lastReviewedAt: null, removedAt: null, requestId: null, candidate: false, synthetic: false } })), '已消化');
 assert.equal(digestStateLabel(digest({ library: { active: true, legacy: false, source: 'ai', enteredAt: 1, completedAt: 1, lastReviewedAt: null, removedAt: null, requestId: null, candidate: true, synthetic: false } })), '已消化 · AI 新版本待查看');
 assert.equal(digestStateLabel(digest({ library: { active: true, legacy: true, source: 'legacy', enteredAt: 1, completedAt: null, lastReviewedAt: null, removedAt: null, requestId: null, candidate: false, synthetic: false } })), '已消化 · 早期标记');
 assert.equal(digestStateLabel(digest({ library: { active: true, legacy: false, source: 'ai', enteredAt: 1, completedAt: 1, lastReviewedAt: null, removedAt: null, requestId: null, candidate: false, synthetic: true } })), '模拟验证 · 已消化');
 assert.equal(digestStateLabel(digest({ request: { id: 'r1', contentId: 1, state: 'failed' } as never })), '需要处理');
});

test('cardChip honours 失败 > 处理中 > 暂停 > 已消化 > 未完整离线 priority', () => {
 assert.equal(cardChip({ failed: true, processing: true, digested: true }), 'failed');
 assert.equal(cardChip({ processing: true, paused: true, digested: true }), 'processing');
 assert.equal(cardChip({ paused: true, digested: false }), 'paused');
 assert.equal(cardChip({ digested: true, offlineComplete: false }), 'digested');
 assert.equal(cardChip({ offlineComplete: false }), 'incomplete');
 assert.equal(cardChip({ offlineComplete: true }), null);
});

test('cardAction picks 消化 / 查看进度 / 打开笔记 / paused', () => {
 assert.equal(cardAction({}), 'digest');
 assert.equal(cardAction({ processing: true }), 'progress');
 assert.equal(cardAction({ digested: true }), 'note');
 assert.equal(cardAction({ paused: true }), 'paused');
});

test('precheckMissing: undefined config keeps old behaviour; flags require fixes', () => {
 assert.equal(precheckMissing(undefined, true), null);
 assert.equal(precheckMissing({ asrConfigured: true, asrNetworkAllowed: true, generationConfigured: true, generationNetworkAllowed: true }, true), null);
 const gen = precheckMissing({ asrConfigured: true, asrNetworkAllowed: true, generationConfigured: false, generationNetworkAllowed: false }, false)!;
 assert.equal(gen.generationConfigured, true); assert.equal(gen.generationNetwork, true);
 assert.equal(gen.asrConfigured, false); assert.equal(gen.asrNetwork, false);
 const asr = precheckMissing({ asrConfigured: false, asrNetworkAllowed: false, generationConfigured: true, generationNetworkAllowed: true }, true)!;
 assert.equal(asr.asrConfigured, true); assert.equal(asr.asrNetwork, true);
 assert.equal(precheckMissing({ asrConfigured: false, asrNetworkAllowed: false, generationConfigured: true, generationNetworkAllowed: true }, false), null);
});

test('precheckNeedsAsr for video/audio kinds or av media', () => {
 assert.equal(precheckNeedsAsr({ kind: 'video', media: [] }), true);
 assert.equal(precheckNeedsAsr({ kind: 'audio', media: [] }), true);
 assert.equal(precheckNeedsAsr({ kind: 'image', media: [{ id: 1, kind: 'image' } as never] }), false);
 assert.equal(precheckNeedsAsr({ kind: 'image', media: [{ id: 1, kind: 'video' } as never] }), true);
 assert.equal(precheckNeedsAsr({ kind: 'image', media: [{ id: 1, kind: 'video', current: false } as never] }), false);
});

test('selectionStats counts images and av minutes', () => {
 const stats = selectionStats([
  { media: [{ kind: 'image' }, { kind: 'video', durationSeconds: 120 }, { kind: 'audio', durationSeconds: 60 }] as never[] },
  { media: [{ kind: 'image' }, { kind: 'image', current: false }] as never[] },
 ]);
 assert.deepEqual(stats, { count: 2, images: 2, avMinutes: 3 });
});

test('syncChipText uses short platform names and per-platform local counts', () => {
 const text = syncChipText({
  recentSync: { batchId: 'b', limit: 100, scopes: [
   { platform: 'xiaohongshu', accountId: 'a', targetIds: ['1', '2'], observedIds: [], targetComplete: false, historyComplete: false, reliable: true, reason: '', startedAt: 0, updatedAt: 0 },
   { platform: 'bilibili', accountId: 'a', targetIds: ['3'], observedIds: [], targetComplete: true, historyComplete: false, reliable: true, reason: '', startedAt: 0, updatedAt: 0 },
  ] },
  contents: [
   { id: 1, platform: 'xiaohongshu', accountId: 'a', sourceId: '1' },
   { id: 2, platform: 'bilibili', accountId: 'a', sourceId: '3' },
  ] as never[],
  progress: { mediaQueued: 4, mediaRunning: 1 },
 } as never);
 assert.equal(text, '小红书 1 · B站 1 · 下载中 剩 5');
});

test('syncRunSummary groups the latest run, sums saved and flags limited platforms', () => {
 const row = (platform: string, startedAt: number, state: string, saved: number) => ({ platform, startedAt, state, saved }) as never;
 const syncs = [row('xiaohongshu', 1000, 'succeeded', 5), row('bilibili', 1100, 'partial', 0), row('weibo', 5000, 'succeeded', 3), row('zhihu', 5000, 'running', 0), row('twitter', 200_000, 'succeeded', 9)];
 const run = syncRunSummary(syncs as never[], 120_000);
 assert.deepEqual(run, { at: 200_000, platforms: 1, saved: 9, limited: false });
 const run2 = syncRunSummary(syncs.slice(0, 3) as never[], 120_000);
 assert.deepEqual(run2, { at: 5000, platforms: 3, saved: 8, limited: true });
 assert.equal(syncRunLine(syncs.slice(0, 3) as never[], () => '今天 12:00'), '最近同步 今天 12:00 · 3 个平台完成 · 新增 8 条 · 部分平台受限');
 assert.equal(syncRunSummary([] as never[]), null);
});

const tpState = (over: Record<string, unknown>) => ({ busy: [], progress: { mediaSaved: 0, mediaQueued: 0, mediaRunning: 0 }, downloadsPaused: false, recentSync: null, ...over }) as never;
const lane = (mode: string, queued: number, until?: number) => ({ platform: 'zhihu', mode, until, active: { details: 0, images: 0, videos: 0 }, queued: { details: 0, media: queued } });

test('topProgress: syncing beats downloading', () => {
 const h = topProgressHistory();
 const r = topProgress(tpState({ busy: ['xiaohongshu', 'bilibili'], progress: { mediaSaved: 5, mediaQueued: 10, mediaRunning: 2 } }), h, 1000);
 assert.equal(r.mode, 'syncing');
 assert.equal(r.label, '正在同步收藏列表：小红书、B站');
});

test('topProgress: downloading pct is monotonic across a shrinking total', () => {
 const h = topProgressHistory();
 const s = (mediaSaved: number, mediaQueued: number, mediaRunning = 0) => topProgress(tpState({ progress: { mediaSaved, mediaQueued, mediaRunning } }), h, mediaSaved * 1500 + 1);
 const first = s(50, 50); // 50%
 assert.equal(first.mode, 'downloading');
 assert.equal(first.pct, 50);
 const shrinking = s(52, 6); // 52/58 ≈ 90% > 50 — fine, then a smaller saved+queued denominator must not drop pct
 const regressed = topProgress(tpState({ progress: { mediaSaved: 52, mediaQueued: 200, mediaRunning: 0 } }), h, 80_000);
 assert.equal(regressed.pct, Math.max(shrinking.pct, 21));
 assert.ok(shrinking.pct >= first.pct);
});

test('topProgress: ETA only with ≥3 samples and a positive rate', () => {
 const h = topProgressHistory();
 const s = (saved: number, at: number) => topProgress(tpState({ progress: { mediaSaved: saved, mediaQueued: 100, mediaRunning: 0 } }), h, at);
 assert.ok(!s(0, 0).label.includes('约'));
 assert.ok(!s(0, 10_000).label.includes('约'));
 const third = s(10, 20_000);
 assert.match(third.label, /下载中 \d+% · 剩余 100 个文件 · 约 \d+ 分钟/);
 const stalled = topProgressHistory();
 [0, 10_000, 20_000, 30_000].forEach(at => topProgress(tpState({ progress: { mediaSaved: 5, mediaQueued: 50, mediaRunning: 0 } }), stalled, at));
 assert.ok(!topProgress(tpState({ progress: { mediaSaved: 5, mediaQueued: 50, mediaRunning: 0 } }), stalled, 40_000).label.includes('约'));
});

test('topProgress: cooldown-only uses the earliest until; paused/login shows 部分平台需要处理', () => {
 const h = topProgressHistory();
 const until = 1_800_000;
 const r = topProgress(tpState({ progress: { mediaSaved: 1, mediaQueued: 9, mediaRunning: 0 }, recentSync: { lanes: [lane('cooldown', 4, until + 60_000), { ...lane('cooldown', 5, until), platform: 'weibo' }] } }), h, 0);
 assert.equal(r.mode, 'cooldown');
 assert.equal(r.until, until);
 assert.match(r.label, /^等待平台冷却 · \d{2}:\d{2} 自动继续$/);
 const paused = topProgress(tpState({ progress: { mediaSaved: 1, mediaQueued: 9, mediaRunning: 0 }, recentSync: { lanes: [lane('paused', 9), lane('idle', 0)] } }), h, 0);
 assert.equal(paused.label, '部分平台需要处理');
 const mixed = topProgress(tpState({ progress: { mediaSaved: 1, mediaQueued: 9, mediaRunning: 0 }, recentSync: { lanes: [lane('cooldown', 4, until), { ...lane('running', 5), platform: 'weibo' }] } }), h, 0);
 assert.equal(mixed.mode, 'downloading');
});

test('topProgress: global pause, finished flash, and idle', () => {
 const h = topProgressHistory();
 assert.equal(topProgress(tpState({}), h, 0).mode, 'hidden');
 assert.equal(topProgress(tpState({ progress: { mediaSaved: 10, mediaQueued: 40, mediaRunning: 0 }, downloadsPaused: true }), h, 0).mode, 'paused');
 const downloading = topProgress(tpState({ progress: { mediaSaved: 50, mediaQueued: 50, mediaRunning: 0 } }), h, 1000);
 assert.equal(downloading.mode, 'downloading');
 const done = topProgress(tpState({ progress: { mediaSaved: 100, mediaQueued: 0, mediaRunning: 0 } }), h, 2000);
 assert.deepEqual([done.mode, done.pct, done.label], ['finished', 100, '全部下载完成']);
 assert.equal(topProgress(tpState({ progress: { mediaSaved: 100, mediaQueued: 0, mediaRunning: 0 } }), h, 4000).mode, 'finished');
 assert.equal(topProgress(tpState({ progress: { mediaSaved: 100, mediaQueued: 0, mediaRunning: 0 } }), h, 6000).mode, 'hidden');
 const fresh = topProgressHistory();
 assert.equal(topProgress(tpState({ progress: { mediaSaved: 100, mediaQueued: 0, mediaRunning: 0 } }), fresh, 0).mode, 'hidden');
});
