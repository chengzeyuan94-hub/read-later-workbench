import test from 'node:test';
import assert from 'node:assert/strict';
import { homeSelections } from '../src/main/service.js';
import type { ContentRecord } from '../src/shared/contracts.js';
import type { DigestContentState, DigestLibraryRecord, DigestRequestState } from '../src/shared/digest-contracts.js';
const now = Date.parse('2026-10-17T17:00:00+08:00'), day = 86_400_000;
const content = (id: number, extra: Partial<ContentRecord> = {}): ContentRecord => ({ id, platform: 'xiaohongshu', accountId: 'synthetic-home', sourceId: String(id), title: '合成首页规则', author: '', url: 'https://example.invalid/', kind: 'text', folderIds: [], publishedAt: now - 20 * day, collectedAt: null, firstDiscoveredAt: now - 1000, discovery: 'new', body: '合成', bodyComplete: true, subtitle: '', detailState: 'succeeded', detailError: null, digestedAt: null, lastReviewedAt: null, offline: true, media: [], ...extra });
const library = (extra: Partial<DigestLibraryRecord> = {}): DigestLibraryRecord => ({ active: true, legacy: false, source: 'ai', enteredAt: now - day, completedAt: now - day, lastReviewedAt: null, removedAt: null, requestId: 'synthetic-request', candidate: false, synthetic: false, ...extra });
function state(id: number, requestState?: DigestRequestState, membership: DigestLibraryRecord | null = null): DigestContentState {
  return { contentId: id, request: requestState ? { id: `synthetic-${id}`, contentId: id, state: requestState, generation: 1, requestedAt: now - 1000, updatedAt: now, completedAt: null, inputScope: { revisionId: 'synthetic', sourceRevisionId: 'synthetic', sourceFingerprint: 'synthetic', platform: 'xiaohongshu', accountId: 'synthetic-home', sourceId: String(id), media: [], requiresOCR: false, requiresASR: false, mediaManifestComplete: true, bodyComplete: true, bodySha256: '0'.repeat(64), subtitleSha256: '0'.repeat(64), coverage: 'synthetic pure text' }, targetVersion: null, sourceUpdated: false, synthetic: false, candidate: false } : null, stages: [], library: membership, readiness: { ready: false, reasons: ['未就绪'] }, capabilities: { ocr: false, asr: false, organize: false, map: false, markdown: false } };
}
test('continue holds processing and user-action-required items first; cancelled items are not attention', () => {
  const records = [1, 2, 3, 4, 5].map(id => content(id));
  const states = [state(1, 'waiting-capability'), state(2, 'failed'), state(3, 'cancelled'), state(4, 'writing-markdown'), state(5)];
  const home = homeSelections(records, now, states);
  // 需处理（failed、waiting-capability）在最前（同更新时间按 id 倒序）；处理中条目随后。
  assert.deepEqual(home.continueItems.map(c => c.id), [2, 1, 4]);
  assert.deepEqual(home.recent.map(c => c.id), [5, 3], 'cancelled 不是需处理状态，回到最近同步');
  assert.ok(records.every(c => c.firstDiscoveredAt === now - 1000));
});
test('continue includes half-written saved workspaces and batch attention, dedupes, and caps at 8', () => {
  const records = Array.from({ length: 12 }, (_, n) => content(n + 1));
  const halfWritten = new Map<number, number>([[3, now - 500], [4, now - 4000], [5, now - 3000]]);
  const attention = new Set<number>([6]);
  const states = [state(2, 'queued'), state(4, 'waiting-network'), state(5, undefined, library()), state(7, 'result-unknown')];
  const home = homeSelections(records, now, states, { halfWritten, attention });
  // 需处理最前（按更新时间）：7、4（请求 updatedAt 最新）、6（批次），随后 2（queued）、3（写了一半）；5 已消化排除。
  assert.deepEqual(home.continueItems.map(c => c.id), [7, 4, 6, 2, 3]);
  const many = Array.from({ length: 10 }, (_, n) => content(n + 100, { firstDiscoveredAt: now - n * 1000 }));
  const capped = homeSelections(many, now, undefined, { halfWritten: new Map(many.map((c, i) => [c.id, now - i * 1000])) });
  assert.equal(capped.continueItems.length, 8, '继续最多 8 条，不足不补齐');
});
test('recent uses the 7-day window regardless of discovery, newest first, capped at 12, no duplication with continue', () => {
  const records = [
    ...Array.from({ length: 14 }, (_, n) => content(n + 1, { firstDiscoveredAt: now - n * 1000 })),
    content(100, { firstDiscoveredAt: now - 8 * day }),
    content(101, { firstDiscoveredAt: now + 1 }),
  ];
  const states = [state(1, 'queued')];
  const home = homeSelections(records, now, states);
  assert.deepEqual(home.continueItems.map(c => c.id), [1], '处理中条目进入继续且不重复出现在最近');
  assert.deepEqual(home.recent.map(c => c.id), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], '近7天最多12条；8天前与未来的排除');
  const all = new Set([...home.continueItems, ...home.recent, ...home.reviews].map(c => c.id));
  assert.equal(home.continueItems.length + home.recent.length + home.reviews.length, all.size, '三组互不重复');
});
test('review dates use completion membership and retained historical time; processing library items move to continue', () => {
  const records = [content(1), content(2, { digestedAt: now - 3 * day }), content(3), content(4), content(5)];
  const states = [state(1, 'complete', library({ completedAt: now - day, lastReviewedAt: now - 10_000 })), state(2, undefined, library({ legacy: true, source: 'legacy', completedAt: null, enteredAt: now - 3 * day })), state(3, 'waiting-network', library()), state(4, 'complete', library({ completedAt: now - 15 * day })), state(5, 'complete', library({ completedAt: now + 1 }))];
  const home = homeSelections(records, now, states);
  assert.deepEqual(home.reviews.map(c => c.id), [2, 1]);
  assert.deepEqual(home.continueItems.map(c => c.id), [3], '处理中的已消化条目进继续，不重复进回顾');
  assert.deepEqual(homeSelections(records, now, states).reviews, home.reviews, 'reading selections is pure and does not record review');
});
test('removal relation overrides retained old digestedAt and does not erase source or editing fields', () => {
  const record = content(1, { digestedAt: now - day });
  const before = structuredClone(record);
  const result = homeSelections([record], now, [state(1, 'cancelled', library({ active: false, legacy: true, removedAt: now }))]);
  assert.equal(result.reviews.length, 0); assert.deepEqual(result.recent.map(c => c.id), [1]); assert.deepEqual(record, before);
});
test('new completed version with no review does not inherit the preserved old content review time', () => {
  const records = [content(1, { lastReviewedAt: now - day }), content(2)];
  const states = [state(1, 'complete', library()), state(2, 'complete', library({ lastReviewedAt: now - 2 * day }))];
  assert.deepEqual(homeSelections(records, now, states).reviews.map(c => c.id), [1, 2]);
  assert.equal(records[0].lastReviewedAt, now - day, 'old review evidence remains unchanged');
});
