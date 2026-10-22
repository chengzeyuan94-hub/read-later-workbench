// R4: pause/resume storm — randomly interleave pauseDownloads, resumeDownloads,
// resumePlatform, pauseContentDownload and retry during activity. Require:
// - no NEW task is dispatched for content while it is download-paused;
// - no NEW fetch starts while downloads are globally paused;
// - in-flight tasks requeue rather than vanish;
// - non-paused items all complete; persisted pause state survives reopen.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeAdapter, fakeDetail, fakeFetch, fakeImage, rng, sleep, streamingResponse, until } from './fakes.js';
import type { CollectionItem, DetailResult, Platform } from '../../src/shared/contracts.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r4-'));
const random = rng(11);
const PLATFORMS: Platform[] = ['xiaohongshu', 'bilibili', 'weibo'];
const failures: string[] = [];

const sourceToContent = new Map<string, number>();
const detailDispatch: { id: string; at: number }[] = [];
const mediaDispatch: { key: string; at: number }[] = [];

const adapters = PLATFORMS.map(platform => fakeAdapter({
  platform,
  ids: ['p1', 'p2', 'p3'].map(id => `${platform}-${id}`),
  detail: async (item: CollectionItem): Promise<DetailResult> => {
    detailDispatch.push({ id: item.sourceId, at: Date.now() });
    await sleep(25);
    return { ...fakeDetail(item.sourceId), media: [fakeImage(`${item.sourceId}-m1`), fakeImage(`${item.sourceId}-m2`)] };
  },
}));

const fetchPlan = fakeFetch(async url => {
  mediaDispatch.push({ key: String(url).split('/media/')[1] ?? String(url), at: Date.now() });
  return streamingResponse({ bytes: 8192, chunk: 512, delay: 12 });
});

let dispatchWhileGloballyPaused = 0;
const service = new WorkbenchService(dir, adapters, baseOptions({
  fetch: async (url, init, platform) => {
    if ((service as unknown as { downloadsPaused: boolean }).downloadsPaused) dispatchWhileGloballyPaused++;
    return fetchPlan.perCall(url, init, platform);
  },
}));

void service.sync();
await until(() => service.state().contents.length === PLATFORMS.length * 3, 500);
for (const c of service.state().contents) sourceToContent.set(c.sourceId, c.id);

const pausedByStorm = new Map<number, number>();
let endedPaused = false;
for (let i = 0; i < 80; i++) {
  const action = random();
  if (action < 0.3) { service.pauseDownloads(); endedPaused = true; }
  else if (action < 0.55) { service.resumeDownloads(); endedPaused = false; }
  else if (action < 0.7) service.resumePlatform(PLATFORMS[Math.floor(random() * PLATFORMS.length)]);
  else if (action < 0.85) {
    const ids = service.state().contents.map(c => c.id);
    if (ids.length) { const id = ids[Math.floor(random() * ids.length)]; service.pauseContentDownload(id); if (!pausedByStorm.has(id)) pausedByStorm.set(id, Date.now()); }
  } else {
    const ids = service.state().contents.map(c => c.id);
    if (ids.length) service.retry(ids[Math.floor(random() * ids.length)]);
  }
  await sleep(30 + Math.floor(random() * 80));
}
if (endedPaused) service.resumeDownloads();
service.pump();

// No new dispatch for a paused item after the pause timestamp. Media keys are
// `${sourceId}-mN`; detail dispatch keys are sourceIds.
for (const [id, at] of pausedByStorm) {
  const content = service.state().contents.find(c => c.id === id)!;
  if (detailDispatch.some(d => d.id === content.sourceId && d.at > at)) failures.push(`detail dispatched for paused content ${id}`);
  if (mediaDispatch.some(d => d.key.startsWith(`${content.sourceId}-m`) && d.at > at)) failures.push(`media dispatched for paused content ${id}`);
}
if (dispatchWhileGloballyPaused) failures.push(`fetch dispatched ${dispatchWhileGloballyPaused}× while globally paused`);

const doneOrPaused = () => service.state().contents.every(c =>
  (c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')) || pausedByStorm.has(c.id));
try {
  await until(doneOrPaused, 2000, 50);
} catch {
  for (const c of service.state().contents) if (!(c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')) && !pausedByStorm.has(c.id)) failures.push(`unfinished ${c.platform}/${c.sourceId} detail=${c.detailState} media=${c.media.map(m => m.state).join('|')}`);
}
// In-flight tasks must have requeued rather than vanish: no phantom running rows.
const raw = service as unknown as { laneTasks: Map<string, { type: string; id: number }> };
for (const c of service.state().contents) {
  if (c.detailState === 'running' && !raw.laneTasks.has(`d:${c.id}`)) failures.push(`phantom running detail ${c.id}`);
  for (const m of c.media) if (m.state === 'running' && !raw.laneTasks.has(`m:${m.id}`)) failures.push(`phantom running media ${m.id}`);
}
const pausedSetting = service.store.setting('batchDownloadsPaused', '');
service.close();

const reopened = new WorkbenchService(dir, adapters, baseOptions({ fetch: fetchPlan.perCall }));
try {
  const inMemory = (reopened as unknown as { downloadsPaused: boolean }).downloadsPaused;
  const persisted = reopened.store.setting('batchDownloadsPaused', 'false');
  if (String(inMemory) !== persisted) failures.push(`persisted batchDownloadsPaused=${persisted} but in-memory=${inMemory}`);
  if (persisted !== pausedSetting) failures.push('setting changed across reopen');
  const pausedIds = reopened.recentImport!.pausedContentDownloads().map(row => row.contentId).sort();
  if (JSON.stringify(pausedIds) !== JSON.stringify([...pausedByStorm.keys()].sort())) failures.push(`per-item pauses not persisted: ${JSON.stringify(pausedIds)}`);
  if (persisted === 'true') reopened.resumeDownloads();
  await until(() => reopened.state().contents.every(c => (c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')) || pausedByStorm.has(c.id)), 1200);
  const dup = reopened.store.db.prepare(`SELECT content_id,resource_key,count(*) n FROM media WHERE current=1 GROUP BY content_id,resource_key HAVING n>1`).all();
  if ((dup as unknown[]).length) failures.push(`duplicate media rows ${JSON.stringify(dup)}`);
} finally { reopened.close(); }
await rm(dir, { recursive: true, force: true });
if (failures.length) { console.error('R4 FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log(`R4 pause/resume storm clean (${pausedByStorm.size} items paused by storm, all honoured)`);
