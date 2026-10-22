// R6: sync concurrency — overlap manual sync, timer sync, per-platform sync and
// range changes mid-sync, plus an ACCOUNT_CHANGED snapshot. Require at most one
// collect in flight per platform, union targets without duplicates, E4.7
// discovery labels, account-mismatch saves nothing, honest sync rows.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeDetail, fakeFetch, fakeImage, fakeSnapshot, sleep, streamingResponse, until } from './fakes.js';
import type { CollectionItem, CollectionOptions, CollectionSnapshot, DetailResult, Platform, SourceAdapter } from '../../src/shared/contracts.js';

const failures: string[] = [];
const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r6-'));

// Controllable collect: counts in-flight collects per platform, waits on a gate.
const inFlight = new Map<Platform, number>();
const maxInFlight = new Map<Platform, number>();
let gates: { platform: Platform; resolve: () => void }[] = [];
const gateAll = () => { const pending = gates; gates = []; for (const g of pending) g.resolve(); };
const collectCalls: { platform: Platform; options?: CollectionOptions }[] = [];

const slowAdapter = (platform: Platform, ids: string[], mutate?: (snap: CollectionSnapshot, call: number) => CollectionSnapshot | Error): SourceAdapter => ({
  platform,
  collect: async options => {
    const call = collectCalls.filter(c => c.platform === platform).length;
    collectCalls.push({ platform, options });
    inFlight.set(platform, (inFlight.get(platform) ?? 0) + 1);
    maxInFlight.set(platform, Math.max(maxInFlight.get(platform) ?? 0, inFlight.get(platform)!));
    try {
      await new Promise<void>(resolve => gates.push({ platform, resolve }));
      const snap = fakeSnapshot(platform, ids);
      // A real adapter echoes the requested window back in target.limit.
      if (options?.recentLimit) snap.target = { ...snap.target!, limit: options.recentLimit };
      const out = mutate?.(snap, call);
      if (out instanceof Error) throw out;
      return out ?? snap;
    } finally { inFlight.set(platform, inFlight.get(platform)! - 1); }
  },
  detail: async (item: CollectionItem): Promise<DetailResult> => ({ ...fakeDetail(item.sourceId), media: [fakeImage(`${item.sourceId}-m`)] }),
  verifyAccount: async () => {},
});

const fetchPlan = fakeFetch(async () => streamingResponse({ bytes: 1024 }));
const service = new WorkbenchService(dir, [
  slowAdapter('bilibili', ['b1', 'b2']),
  // Wave-2 collects surface a brand-new favourite at the head of the list.
  slowAdapter('weibo', ['w1', 'w2'], (snap, call) => call === 0 ? snap : {
    ...snap,
    items: [{ sourceId: 'w0', title: 'weibo-w0', author: 'fixture', url: 'https://fixture.invalid/weibo/w0', kind: 'text', folderIds: ['saved'], collectedAt: Date.now() }, ...snap.items],
  }),
], baseOptions({ fetch: fetchPlan.perCall }));

try {
  // Overlap: all-platform manual, per-platform manual, timer sync, range change mid-flight.
  const s1 = service.sync();
  await until(() => gates.length >= 2, 200);
  const s2 = service.sync('bilibili');
  const s3 = service.sync('bilibili', 'timer');
  service.setSyncRange('10');
  const s4 = service.sync('weibo', 'timer');
  service.setSyncRange('all');
  const s5 = service.sync();
  gateAll(); await sleep(50); gateAll();
  await Promise.all([s1, s2, s3, s4, s5]);
  for (const [platform, max] of maxInFlight) if (max > 1) failures.push(`${platform}: ${max} collects in flight`);

  // Wave 2: a range change must reach the adapter, and a genuinely new favourite
  // discovered after a prior successful sync gets discovery 'new'.
  service.setSyncRange('all');
  const s6 = service.sync('weibo');
  await until(() => gates.length >= 1, 200);
  gateAll();
  await s6;
  const wAll = collectCalls.filter(c => c.platform === 'weibo' && c.options?.fullHistory === true);
  if (!wAll.length) failures.push('fullHistory option never reached the weibo adapter');
  service.setSyncRange('10');
  const s7 = service.sync('weibo');
  await until(() => gates.length >= 1, 200);
  gateAll();
  await s7;
  const wTen = collectCalls.filter(c => c.platform === 'weibo' && c.options?.recentLimit === 10);
  if (!wTen.length) failures.push('recentLimit=10 option never reached the weibo adapter');

  await until(() => service.state().contents.every(c => c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')), 1200, 50);
  const dup = service.store.db.prepare('SELECT platform,account_id,source_id,count(*) n FROM contents GROUP BY 1,2,3 HAVING n>1').all();
  if ((dup as unknown[]).length) failures.push(`duplicate contents ${JSON.stringify(dup)}`);
  const dupTargets = service.store.db.prepare('SELECT platform,source_id,count(*) n FROM recent_import_targets GROUP BY 1,2 HAVING n>1').all();
  if ((dupTargets as unknown[]).length) failures.push(`duplicate targets ${JSON.stringify(dupTargets)}`);
  const targets = service.store.db.prepare('SELECT source_id FROM recent_import_targets').all() as { source_id: string }[];
  if (targets.length !== 5) failures.push(`expected union of 5 targets, got ${targets.length}: ${targets.map(t => t.source_id)}`);
  // First-synced items are baseline (historical); w0 added in wave-2 is 'new'.
  const discoveries = service.state().contents.map(c => `${c.sourceId}:${c.discovery}`);
  if (discoveries.some(d => /^(b1|b2|w1|w2):new/.test(d))) failures.push(`baseline items labelled new: ${JSON.stringify(discoveries)}`);
  if (!discoveries.includes('w0:new')) failures.push(`w0 not labelled new: ${JSON.stringify(discoveries)}`);
  const rows = service.state().syncs;
  if (rows.some(r => !['succeeded', 'partial', 'failed'].includes(r.state))) failures.push('sync row in odd state');
  if (!rows.length) failures.push('no sync rows recorded');
  const syncsByPlatform = service.store.db.prepare("SELECT platform,state,count(*) n FROM syncs GROUP BY 1,2").all();
  console.log('  sync rows:', JSON.stringify(syncsByPlatform));
  console.log(`  collect calls=${collectCalls.length} options=${JSON.stringify(collectCalls.map(c => c.options?.recentLimit ?? (c.options?.fullHistory ? 'all' : 'def')))}`);
} finally { service.close(); }

// ACCOUNT_CHANGED snapshot: collect throws; nothing is saved, pause recorded.
{
  const mismatched = new WorkbenchService(dir, [
    { platform: 'bilibili', collect: async () => { throw new Error('ACCOUNT_CHANGED: fixture'); }, detail: async item => fakeDetail(item.sourceId), verifyAccount: async () => {} } as SourceAdapter,
    slowAdapter('weibo', ['w1', 'w2']),
  ], baseOptions({ fetch: fetchPlan.perCall }));
  try {
    const before = (mismatched.store.db.prepare('SELECT count(*) n FROM contents').get() as { n: number }).n;
    await mismatched.sync('bilibili');
    const after = mismatched.store.db.prepare('SELECT count(*) n FROM contents').get() as { n: number };
    if (after.n !== before) failures.push(`account-changed sync saved contents (${before} -> ${after.n})`);
    const pause = mismatched.store.setting('batchPause:bilibili', '');
    if (!pause || JSON.parse(pause).kind !== 'account-changed') failures.push('account-changed did not hard-pause the platform');
    const last = mismatched.store.db.prepare("SELECT * FROM syncs WHERE platform='bilibili' ORDER BY id DESC LIMIT 1").get() as { state: string } | undefined;
    if (last?.state !== 'failed') failures.push(`account-changed sync row state=${last?.state}`);
    const bilibiliRows = mismatched.store.db.prepare("SELECT count(*) n FROM recent_import_targets WHERE platform='bilibili'").get() as { n: number };
    if (bilibiliRows.n !== 2) failures.push(`account-changed mutated targets (${bilibiliRows.n})`);
  } finally { mismatched.close(); }
}
await rm(dir, { recursive: true, force: true });

if (failures.length) { console.error('R6 FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log('R6 sync concurrency clean');
