import type { ContentRecord, Platform, RecentSyncState } from '../shared/contracts.js';

export type CollectionSort = 'newest' | 'oldest';
type SortItem = Pick<ContentRecord, 'platform' | 'accountId' | 'sourceId'>
  & { collectedAt?: number | null; firstDiscoveredAt?: number | null; id?: number; favoriteRank?: number | null; discovery?: string };

interface PlatformCtx {
  /** Baseline import time — the earliest firstDiscoveredAt on this platform. */
  importTime: number;
  /** Oldest real effective time among (a)/(b) items, or importTime minus a year. */
  oldestKnown: number;
  /** Precomputed synthetic times for baseline-import items, keyed by id. */
  synthetic: Map<number, number>;
}
export interface FavoriteTimeCtx { byPlatform: Map<Platform, PlatformCtx> }

/** E4.8 ctx: per-platform baseline import time plus synthetic favourite times
 * for items the platform never timestamps. Synthetics interpolate between the
 * effective times of their rank neighbours, so within a platform the result
 * always agrees with favourite-order rank; with no anchors they spread evenly
 * between (importTime − 1y) and the baseline import time. */
export function buildFavoriteTimeCtx(items: SortItem[]): FavoriteTimeCtx {
  const byPlatform = new Map<Platform, SortItem[]>();
  for (const item of items) {
    const list = byPlatform.get(item.platform) ?? [];
    list.push(item);
    byPlatform.set(item.platform, list);
  }
  const ctx: FavoriteTimeCtx = { byPlatform: new Map() };
  for (const [platform, list] of byPlatform) {
    const importTime = Math.min(...list.map(item => item.firstDiscoveredAt ?? Number.MAX_SAFE_INTEGER));
    const ordered = [...list].sort((a, b) => (b.favoriteRank ?? Number.NEGATIVE_INFINITY) - (a.favoriteRank ?? Number.NEGATIVE_INFINITY)
      || (b.firstDiscoveredAt ?? 0) - (a.firstDiscoveredAt ?? 0) || (b.id ?? 0) - (a.id ?? 0));
    const anchors = ordered.map((item, index) => ({ index, time: rawEffective(item, importTime) }))
      .filter((entry): entry is { index: number; time: number } => entry.time !== undefined);
    const oldestKnown = anchors.length ? Math.min(...anchors.map(entry => entry.time)) : importTime - 365 * 24 * 60 * 60 * 1000;
    const synthetic = new Map<number, number>();
    const emit = (from: number, to: number, above: number | undefined, below: number | undefined) => {
      const k = to - from;
      for (let j = 0; j < k; j++) {
        const item = ordered[from + j];
        const key = item.id ?? -(from + j) - 1;
        if (above === undefined && below === undefined) synthetic.set(key, importTime - (importTime - oldestKnown) * (j + 1) / (k + 1));
        else if (above === undefined) synthetic.set(key, below! + (k - j));
        else if (below === undefined) synthetic.set(key, above - (j + 1));
        else synthetic.set(key, below + (above - below) * (k - j) / (k + 1));
      }
    };
    let runStart = 0; let previousAnchor: number | undefined;
    for (const anchor of anchors) {
      emit(runStart, anchor.index, previousAnchor, anchor.time);
      previousAnchor = anchor.time; runStart = anchor.index + 1;
    }
    emit(runStart, ordered.length, previousAnchor, undefined);
    ctx.byPlatform.set(platform, { importTime, oldestKnown, synthetic });
  }
  return ctx;
}

/** (a) real favourite time, (b) import time for favourites discovered later. */
function rawEffective(item: SortItem, importTime: number): number | undefined {
  if (item.collectedAt != null) return item.collectedAt;
  if ((item.discovery === 'new' || item.discovery === 'unknown') && (item.firstDiscoveredAt ?? 0) > importTime) return item.firstDiscoveredAt!;
  return undefined;
}

/** Effective favourite time for cross-platform ordering: real collectedAt,
 * later-discovery import time, else a rank-preserving estimate inside the
 * platform's baseline window. */
export function effectiveFavoriteTime(item: SortItem, ctx: FavoriteTimeCtx): number {
  const entry = ctx.byPlatform.get(item.platform);
  const raw = rawEffective(item, entry?.importTime ?? item.firstDiscoveredAt ?? 0);
  if (raw !== undefined) return raw;
  return entry?.synthetic.get(item.id ?? -1) ?? item.firstDiscoveredAt ?? 0;
}

/** Explicit favourite-order sorting. With a platform filter, the persisted
 * platform rank decides (unranked items sink last); across all sources an
 * effective favourite time interleaves platforms. */
export function orderCollectionList<T extends SortItem>(
  contents: T[], view: string, platform: string, recentSync?: RecentSyncState, sort: CollectionSort = 'newest',
): T[] {
  const scope = view === 'library' && platform !== 'all' ? recentSync?.scopes.find(item => item.platform === platform) : undefined;
  const scoped = scope?.targetIds.length ? (content: T) => content.platform === scope.platform && content.accountId === scope.accountId : undefined;
  const direction = sort === 'oldest' ? 1 : -1;
  const singlePlatform = platform !== 'all' && contents.some(item => item.favoriteRank != null);
  const ctx = singlePlatform ? undefined : buildFavoriteTimeCtx(contents);
  return [...contents].sort((a, b) => {
    if (singlePlatform) {
      const rankDiff = direction * ((a.favoriteRank ?? Number.NEGATIVE_INFINITY) - (b.favoriteRank ?? Number.NEGATIVE_INFINITY));
      if (rankDiff !== 0) return rankDiff;
    } else {
      const time = direction * (effectiveFavoriteTime(a, ctx!) - effectiveFavoriteTime(b, ctx!));
      if (time !== 0) return time;
    }
    if (scoped && scoped(a) !== scoped(b)) return scoped(a) ? -1 : 1;
    return direction * ((a.id ?? 0) - (b.id ?? 0));
  });
}
