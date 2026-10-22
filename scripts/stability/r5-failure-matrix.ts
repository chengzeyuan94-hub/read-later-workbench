// R5: failure-injection matrix. Each scenario runs on a fresh temp dir with a
// scripted fault plan; asserts the E4.5/E4.9 classification outcomes:
//   media 403/404/410  -> expired-url: media requeued + detail refresh x2, then cooldown
//   429/412 (any)      -> rate-limit: platform cooldown
//   401                -> auth: hard pause
//   ACCOUNT_CHANGED    -> account-changed hard pause
//   500/503/reset/stall/empty/wrong-type/truncated -> transient: backoff, item fails after 3
//   'gone' message     -> permanent: item failed immediately
// Plus: parallel rate-limit failures escalate once; bounded calls (no tight loop);
// truncated/empty bodies never mark a file succeeded.
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeAdapter, fakeDetail, fakeFetch, fakeImage, rng, sleep, streamingResponse, until } from './fakes.js';
import { COOLDOWN_LEVEL_MINUTES, MAX_EXPIRED_REFRESHES } from '../../src/main/batch-failure.js';
import type { Platform } from '../../src/shared/contracts.js';

const failures: string[] = [];
const random = rng(23);

interface Scenario {
  name: string; platform?: Platform; count?: number;
  detailFault?: (item: { sourceId: string }, call: number) => Error | undefined;
  fetchFault?: (key: string, call: number) => 'http' | 'throw' | 'stream' | undefined;
  status?: number; stream?: Parameters<typeof streamingResponse>[0]; thrown?: Error;
  run: (s: Ctx) => Promise<void>;
}
interface Ctx {
  service: WorkbenchService; dir: string; fetchPlan: ReturnType<typeof fakeFetch>;
  detailCalls: Map<string, number>; mediaCalls: Map<string, number>;
  platform: Platform;
}

const scenario = async (spec: Scenario) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r5-'));
  const detailCalls = new Map<string, number>();
  const mediaCalls = new Map<string, number>();
  const platform: Platform = spec.platform ?? 'bilibili';
  const adapter = fakeAdapter({
    platform, ids: Array.from({ length: spec.count ?? 6 }, (_, i) => `i${i + 1}`),
    detail: async item => {
      detailCalls.set(item.sourceId, (detailCalls.get(item.sourceId) ?? 0) + 1);
      const fault = spec.detailFault?.(item, detailCalls.get(item.sourceId)!);
      if (fault) throw fault;
      return { ...fakeDetail(item.sourceId), media: [fakeImage(`${item.sourceId}-m`)] };
    },
  });
  const fetchPlan = fakeFetch(async url => {
    const key = String(url).split('/media/')[1] ?? String(url);
    mediaCalls.set(key, (mediaCalls.get(key) ?? 0) + 1);
    const fault = spec.fetchFault?.(key, mediaCalls.get(key)!);
    if (fault === 'throw') throw spec.thrown ?? new Error('ECONNRESET');
    if (fault === 'http') return new Response('fault', { status: spec.status ?? 500, headers: spec.status === 200 ? { 'content-type': 'text/html' } : {} });
    if (fault === 'stream') return streamingResponse(spec.stream ?? { bytes: 4096 });
    return streamingResponse({ bytes: 2048 });
  });
  const service = new WorkbenchService(dir, [adapter], baseOptions({ fetch: fetchPlan.perCall }));
  const ctx: Ctx = { service, dir, fetchPlan, detailCalls, mediaCalls, platform };
  try { await spec.run(ctx); } catch (e) { failures.push(`${spec.name}: threw ${e}`); }
  finally { service.close(); await rm(dir, { recursive: true, force: true }); }
};

const settled = (s: Ctx, pred: (s: Ctx) => boolean) => until(() => pred(s), 600, 25);
const cooldownRow = (s: Ctx) => s.service.store.setting(`batchCooldown:${s.platform}`, '');
const pauseRow = (s: Ctx) => s.service.store.setting(`batchPause:${s.platform}`, '');

// A: media 403 -> expired-url refresh path, then cooldown after the refresh budget.
await scenario({
  name: 'media-403-expired-refresh',
  fetchFault: () => 'http', status: 403,
  run: async s => {
    await s.service.sync();
    await settled(s, () => !!cooldownRow(s));
    const detailFetchTotal = [...s.detailCalls.values()].reduce((a, b) => a + b, 0);
    const mediaFetchTotal = [...s.mediaCalls.values()].reduce((a, b) => a + b, 0);
    // Each item: media 403 -> refresh detail (<=2x) -> on 3rd 403 cooldown, media requeued not failed.
    const failedMedia = s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='failed'").get() as { n: number };
    if (failedMedia.n) failures.push(`media-403: ${failedMedia.n} media failed instead of cooldown/requeue`);
    const cd = JSON.parse(cooldownRow(s));
    if (typeof cd.level !== 'number') failures.push('media-403: no cooldown level persisted');
    if (mediaFetchTotal > 6 * (MAX_EXPIRED_REFRESHES + 1) + 2) failures.push(`media-403: too many fetches ${mediaFetchTotal}`);
    if (detailFetchTotal > 6 * (MAX_EXPIRED_REFRESHES + 1) + 2) failures.push(`media-403: too many detail refreshes ${detailFetchTotal}`);
    console.log(`  media-403: detailCalls=${detailFetchTotal} mediaCalls=${mediaFetchTotal} cooldown level=${cd.level}`);
  },
});

// B: media 429 -> rate-limit cooldown; parallel same-incident failures escalate once.
await scenario({
  name: 'media-429-rate-limit-cooldown',
  fetchFault: () => 'http', status: 429,
  run: async s => {
    await s.service.sync();
    await settled(s, () => !!cooldownRow(s));
    const cd = JSON.parse(cooldownRow(s));
    if (cd.level !== 0) failures.push(`media-429: cooldown escalated during active window to level ${cd.level}`);
    const queued = s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='queued'").get() as { n: number };
    if (!queued.n) failures.push('media-429: nothing left queued for after cooldown');
    console.log(`  media-429: cooldown level=${cd.level} queued=${queued.n} calls=${s.mediaCalls.size}`);
  },
});

// C: transient media failures -> 3 attempts then failed, no succeeded file.
// One item only: 5+ consecutive failures legitimately cool the platform down.
await scenario({
  name: 'media-500-transient-3attempts',
  count: 1,
  fetchFault: () => 'http', status: 500,
  run: async s => {
    await s.service.sync();
    // Transient backoff hides items until next_at; clear it to force each retry.
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      s.service.store.db.prepare('UPDATE recent_import_item_retries SET next_at=0').run();
      s.service.pump();
      const all = s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='failed'").get() as { n: number };
      if (all.n === 1) break;
    }
    const failed = s.service.store.db.prepare("SELECT id,error FROM media WHERE state='failed'").all() as { id: number; error: string }[];
    if (failed.length !== 1) failures.push(`media-500: expected 1 failed media, got ${failed.length}`);
    if (!failed.every(m => /已自动重试 3 次/.test(m.error))) failures.push(`media-500: fail message missing retry count: ${failed[0]?.error}`);
    const succeeded = s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='succeeded'").get() as { n: number };
    if (succeeded.n) failures.push('media-500: media marked succeeded on 500 responses');
    for (const [key, calls] of s.mediaCalls) if (calls > 4) failures.push(`media-500: ${key} fetched ${calls}x (tight loop)`);
    console.log(`  media-500: calls/media=${[...s.mediaCalls.values()].join(',')}`);
  },
});

// D: truncated body -> never succeeded; transient path.
await scenario({
  name: 'media-truncated',
  fetchFault: () => 'stream', stream: { bytes: 4096, truncate: 2048 },
  run: async s => {
    await s.service.sync();
    for (let i = 0; i < 8; i++) {
      await sleep(200);
      s.service.store.db.prepare('UPDATE recent_import_item_retries SET next_at=0').run();
      s.service.pump();
      const n = (s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='failed'").get() as { n: number }).n;
      if (n === 6) break;
    }
    const bad = s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='succeeded'").get() as { n: number };
    if (bad.n) failures.push('media-truncated: truncated body marked succeeded');
    const part = s.service.store.db.prepare("SELECT count(*) n FROM media").get() as { n: number };
    if (part.n !== 6) failures.push(`media-truncated: expected 6 media rows, got ${part.n}`);
    console.log('  media-truncated: all failed honestly, none succeeded');
  },
});

// E: zero-length body -> never succeeded.
await scenario({
  name: 'media-empty-body',
  fetchFault: () => 'stream', stream: { bytes: 0 },
  run: async s => {
    await s.service.sync();
    for (let i = 0; i < 8; i++) {
      await sleep(200);
      s.service.store.db.prepare('UPDATE recent_import_item_retries SET next_at=0').run();
      s.service.pump();
      if ((s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='failed'").get() as { n: number }).n === 6) break;
    }
    if ((s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='succeeded'").get() as { n: number }).n) failures.push('media-empty: empty body marked succeeded');
    console.log('  media-empty: none succeeded');
  },
});

// F: wrong content-type (html instead of image) -> transient fail, no succeeded file.
await scenario({
  name: 'media-wrong-type',
  fetchFault: () => 'http', status: 200,
  run: async s => {
    await s.service.sync();
    for (let i = 0; i < 8; i++) {
      await sleep(200);
      s.service.store.db.prepare('UPDATE recent_import_item_retries SET next_at=0').run();
      s.service.pump();
      if ((s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='failed'").get() as { n: number }).n === 6) break;
    }
    if ((s.service.store.db.prepare("SELECT count(*) n FROM media WHERE state='succeeded'").get() as { n: number }).n) failures.push('media-wrong-type: html body marked succeeded');
    console.log('  media-wrong-type: none succeeded');
  },
});

// G: detail 401 -> auth hard pause; detail requeued.
await scenario({
  name: 'detail-401-auth-pause',
  detailFault: () => new Error('HTTP 401'),
  run: async s => {
    await s.service.sync();
    await settled(s, () => !!pauseRow(s));
    const pause = JSON.parse(pauseRow(s));
    if (pause.kind !== 'auth') failures.push(`detail-401: pause kind ${pause.kind}`);
    const running = s.service.store.db.prepare("SELECT count(*) n FROM contents WHERE detail_state='running'").get() as { n: number };
    if (running.n) failures.push('detail-401: detail left running under auth pause');
    console.log('  detail-401: auth hard pause');
  },
});

// H: detail ACCOUNT_CHANGED -> account-changed hard pause.
await scenario({
  name: 'detail-account-changed',
  detailFault: () => new Error('ACCOUNT_CHANGED: logged in as other'),
  run: async s => {
    await s.service.sync();
    await settled(s, () => !!pauseRow(s));
    const pause = JSON.parse(pauseRow(s));
    if (pause.kind !== 'account-changed') failures.push(`detail-account-changed: pause kind ${pause.kind}`);
    console.log('  detail-account-changed: hard pause');
  },
});

// I: detail permanent message -> item failed without retries.
await scenario({
  name: 'detail-permanent',
  detailFault: item => new Error('HTTP 404 not found: 内容不存在'),
  run: async s => {
    await s.service.sync();
    await settled(s, () => s.service.state().contents.every(c => c.detailState === 'failed'));
    const failed = s.service.state().contents.filter(c => c.detailState === 'failed');
    if (failed.length !== 6) failures.push(`detail-permanent: ${failed.length} failed`);
    const retries = s.service.store.db.prepare('SELECT count(*) n FROM recent_import_item_retries').get() as { n: number };
    if (retries.n) failures.push('detail-permanent: permanent failure scheduled retries');
    console.log('  detail-permanent: 6 failed immediately, no retries');
  },
});

// J: parallel rate-limit failures during an active cooldown do NOT escalate (E4.9).
await scenario({
  name: 'parallel-429-single-escalation',
  fetchFault: () => 'http', status: 429,
  run: async s => {
    await s.service.sync();
    await settled(s, () => !!cooldownRow(s));
    await sleep(300);
    const cd = JSON.parse(cooldownRow(s));
    if (cd.level > 0) failures.push(`parallel-429: level jumped to ${cd.level} within the same incident`);
    console.log(`  parallel-429: one escalation (level ${cd.level})`);
  },
});

// K: transient streak escalates to cooldown after 5 consecutive failures.
await scenario({
  name: 'transient-streak-cooldown',
  fetchFault: () => 'throw', thrown: new Error('ECONNRESET'),
  run: async s => {
    await s.service.sync();
    for (let i = 0; i < 10 && !cooldownRow(s); i++) {
      await sleep(250);
      s.service.store.db.prepare('UPDATE recent_import_item_retries SET next_at=0').run();
      s.service.pump();
    }
    const cd = cooldownRow(s);
    if (!cd) failures.push('transient-streak: never reached cooldown');
    else {
      const parsed = JSON.parse(cd);
      if (!/连续网络失败|ECONNRESET|超时/.test(parsed.reason)) failures.push(`transient-streak: odd reason ${parsed.reason}`);
      console.log(`  transient-streak: cooldown reached at level ${parsed.level}`);
    }
  },
});

if (failures.length) { console.error('\nR5 FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log('\nR5 failure matrix clean');
