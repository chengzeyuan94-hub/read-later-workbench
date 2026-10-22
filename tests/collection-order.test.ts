import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCollectionList, buildFavoriteTimeCtx, effectiveFavoriteTime } from '../src/renderer/collection-order.js';
import type { Platform, RecentSyncState } from '../src/shared/contracts.js';

const item = (id: number, extra: Partial<{ accountId: string; platform: Platform; collectedAt: number | null; firstDiscoveredAt: number; favoriteRank: number; discovery: string }> = {}) =>
  ({ id, sourceId: `source-${id}`, accountId: extra.accountId ?? 'current', platform: extra.platform ?? 'xiaohongshu',
    collectedAt: extra.collectedAt ?? null, firstDiscoveredAt: extra.firstDiscoveredAt ?? 1000,
    favoriteRank: extra.favoriteRank ?? null, discovery: extra.discovery ?? 'historical' });
const recent = (targetIds: string[], platform: Platform = 'xiaohongshu'): RecentSyncState => ({
  batchId: 'fixture', limit: 100, scopes: [{ platform, accountId: 'current', targetIds,
    observedIds: [...targetIds].reverse(), targetComplete: true, historyComplete: false,
    reliable: true, reason: 'fixture', startedAt: 1, updatedAt: 2 }],
});

test('single-platform library orders by favourite rank, newest first', () => {
  const contents = [item(45, { favoriteRank: 1 }), item(144, { favoriteRank: 4 }), item(47, { favoriteRank: 3 }), item(99, { favoriteRank: 2 })];
  const ordered = orderCollectionList(contents, 'library', 'xiaohongshu', recent(['source-45', 'source-47']));
  assert.deepEqual(ordered.map(content => content.id), [144, 47, 99, 45]);
});

test('oldest reverses rank order exactly; unranked items sink last both ways', () => {
  const contents = [item(45, { favoriteRank: 1 }), item(144, { favoriteRank: 4 }), item(47, { favoriteRank: 3 }), item(7)];
  const newest = orderCollectionList(contents, 'library', 'xiaohongshu', recent(['source-45']), 'newest');
  assert.deepEqual(newest.map(content => content.id), [144, 47, 45, 7]);
  const oldest = orderCollectionList(contents, 'library', 'xiaohongshu', recent(['source-45']), 'oldest');
  assert.deepEqual(oldest.map(content => content.id), [7, 45, 47, 144]);
});

const T0 = 1_700_000_000_000, DAY = 86_400_000;

test('all-sources interleaves platforms by real favourite time', () => {
  const contents = [
    item(1, { platform: 'bilibili', collectedAt: T0 - 150 * DAY, firstDiscoveredAt: T0 }),
    item(2, { platform: 'xiaohongshu', favoriteRank: 2, firstDiscoveredAt: T0 }),
    item(3, { platform: 'bilibili', collectedAt: T0 - 200 * DAY, firstDiscoveredAt: T0 }),
  ];
  const ordered = orderCollectionList(contents, 'library', 'all', undefined, 'newest');
  assert.deepEqual(ordered.map(content => content.id), [1, 2, 3], 'xhs estimate lands between the two bilibili times');
});

test('later-discovered favourites use their import time and outrank the baseline', () => {
  const contents = [
    item(1, { collectedAt: T0 - 300 * DAY, firstDiscoveredAt: T0 }),
    item(2, { favoriteRank: 9, firstDiscoveredAt: T0 }),
    item(3, { favoriteRank: 8, discovery: 'new', firstDiscoveredAt: T0 + 10 * DAY }),
  ];
  const ordered = orderCollectionList(contents, 'library', 'all', undefined, 'newest');
  // Rank 9 (baseline item ranked newest by the platform) leads, the later
  // import follows, the old real favourite time trails.
  assert.deepEqual(ordered.map(content => content.id), [2, 3, 1]);
});

test('within a platform the all-sources order always agrees with rank order', () => {
  const contents = [
    item(1, { platform: 'zhihu', favoriteRank: 6, discovery: 'new', firstDiscoveredAt: T0 + 5 * DAY }),
    item(2, { platform: 'zhihu', favoriteRank: 5, collectedAt: T0 - 200 * DAY, firstDiscoveredAt: T0 }),
    item(3, { platform: 'zhihu', favoriteRank: 4, firstDiscoveredAt: T0 }),
    item(4, { platform: 'zhihu', favoriteRank: 3, collectedAt: T0 - 300 * DAY, firstDiscoveredAt: T0 }),
    item(5, { platform: 'zhihu', favoriteRank: 2, firstDiscoveredAt: T0 }),
    item(6, { platform: 'bilibili', collectedAt: T0 - 250 * DAY, firstDiscoveredAt: T0 }),
  ];
  const zhihu = contents.filter(content => content.platform === 'zhihu');
  const ctx = buildFavoriteTimeCtx(contents);
  for (const sort of ['newest', 'oldest'] as const) {
    const ordered = orderCollectionList(contents, 'library', 'all', undefined, sort).filter(content => content.platform === 'zhihu');
    const byRank = [...zhihu].sort((a, b) => (sort === 'newest' ? -1 : 1) * ((a.favoriteRank ?? 0) - (b.favoriteRank ?? 0)));
    assert.deepEqual(ordered.map(content => content.id), byRank.map(content => content.id), `rank order preserved for ${sort}`);
  }
  // Synthetic times are strictly inside (oldestKnown, importTime) and rank-ordered.
  const t3 = effectiveFavoriteTime(contents[2], ctx), t5 = effectiveFavoriteTime(contents[4], ctx);
  const entry = ctx.byPlatform.get('zhihu')!;
  assert.ok(t3 > entry.oldestKnown && t3 < entry.importTime && t3 > t5);
});

test('oldest is the exact reverse of newest for mixed sources', () => {
  const contents = [
    item(1, { platform: 'zhihu', favoriteRank: 3, collectedAt: 700, firstDiscoveredAt: 1000 }),
    item(2, { platform: 'zhihu', favoriteRank: 2, firstDiscoveredAt: 1000 }),
    item(3, { platform: 'bilibili', collectedAt: 400, firstDiscoveredAt: 1000 }),
    item(4, { platform: 'xiaohongshu', favoriteRank: 9, discovery: 'unknown', firstDiscoveredAt: 6000 }),
  ];
  const newest = orderCollectionList(contents, 'library', 'all', undefined, 'newest').map(content => content.id);
  const oldest = orderCollectionList(contents, 'library', 'all', undefined, 'oldest').map(content => content.id);
  assert.deepEqual(oldest, [...newest].reverse());
});

test('items without any ranks fall back to effective favourite time', () => {
  const contents = [
    item(1, { collectedAt: T0 - 50 * DAY, firstDiscoveredAt: T0 }),
    item(2, { collectedAt: T0 - 200 * DAY, firstDiscoveredAt: T0 }),
    item(3, { collectedAt: null, discovery: 'new', firstDiscoveredAt: T0 + 5 * DAY }),
  ];
  const newest = orderCollectionList(contents, 'library', 'xiaohongshu', undefined, 'newest');
  assert.deepEqual(newest.map(content => content.id), [3, 1, 2]);
});

test('the digested list reuses the same sort; home ordering applies too', () => {
  const contents = [item(45, { favoriteRank: 1 }), item(144, { favoriteRank: 3 }), item(47, { favoriteRank: 2 })];
  assert.deepEqual(orderCollectionList(contents, 'digested', 'all', undefined, 'oldest').map(content => content.id), [45, 47, 144]);
  assert.deepEqual(orderCollectionList(contents, 'home', 'xiaohongshu').map(content => content.id), [144, 47, 45]);
});
