// R3: network flapping — toggle setOnline randomly while sync+downloads run
// across three platforms. Require eventual completion, no duplicates, empty
// lanes at idle, no stuck running tasks, bounded fetch calls.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeAdapter, fakeDetail, fakeFetch, fakeImage, fakeSnapshot, rng, sleep, streamingResponse, until } from './fakes.js';
import type { Platform } from '../../src/shared/contracts.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r3-'));
const random = rng(7);
const PLATFORMS: Platform[] = ['xiaohongshu', 'bilibili', 'weibo'];
const fetchPlan = fakeFetch(async () => streamingResponse({ bytes: 4096, chunk: 512, delay: 15 }));

const adapters = PLATFORMS.map(platform => fakeAdapter({
  platform,
  ids: ['p1', 'p2', 'p3', 'p4'].map(id => `${platform}-${id}`),
  detail: async item => ({ ...fakeDetail(item.sourceId), media: [fakeImage(`${item.sourceId}-m1`), fakeImage(`${item.sourceId}-m2`), fakeImage(`${item.sourceId}-m3`)] }),
  detailDelay: 30,
}));

const service = new WorkbenchService(dir, adapters, baseOptions({ fetch: fetchPlan.perCall }));
const failures: string[] = [];
try {
  // Start sync, then flap online state every 100–500ms for ~60s of activity.
  void service.sync();
  const flapEnd = Date.now() + 20_000;
  while (Date.now() < flapEnd) {
    service.setOnline(random() < 0.5);
    await sleep(100 + Math.floor(random() * 400));
  }
  service.setOnline(true);
  // Completion can take a while after heavy flapping; allow generous budget.
  try {
    await until(() => service.state().contents.every(c => c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')), 3000, 50);
  } catch {
    const state = service.state();
    for (const c of state.contents) failures.push(`stuck ${c.platform}/${c.sourceId} detail=${c.detailState}:${c.detailError ?? ''} media=${c.media.map(m => `${m.state}:${m.error ?? ''}`).join('|')}`);
    failures.push(`retries ${JSON.stringify(service.store.db.prepare('SELECT * FROM recent_import_item_retries').all()).slice(0, 2000)}`);
    failures.push(`laneTasks ${(service as unknown as { laneTasks: Map<unknown, unknown> }).laneTasks.size} recentSync ${JSON.stringify(state.recentSync?.lanes)}`);
  }
  await service.waitForIdle().catch(() => failures.push('waitForIdle timed out'));

  const state = service.state();
  const mediaRows = state.contents.flatMap(c => c.media);
  const dup = service.store.db.prepare(`SELECT content_id,resource_key,count(*) n FROM media WHERE current=1 GROUP BY content_id,resource_key HAVING n>1`).all();
  if ((dup as unknown[]).length) failures.push(`duplicate media rows: ${JSON.stringify(dup)}`);
  if ((service as unknown as { laneTasks: Map<unknown, unknown> }).laneTasks.size !== 0) failures.push('laneTasks not empty at idle');
  const running = state.contents.filter(c => c.detailState === 'running' || c.media.some(m => m.state === 'running'));
  if (running.length) failures.push(`running tasks stuck after flapping stopped: ${running.map(c => c.id)}`);
  const mediaCount = mediaRows.length;
  const perMedia = fetchPlan.calls.length / Math.max(1, mediaCount);
  if (perMedia >= 5) failures.push(`fetch call count unbounded: ${fetchPlan.calls.length} calls for ${mediaCount} media`);
  const contents = service.store.db.prepare('SELECT platform,source_id,count(*) n FROM contents GROUP BY 1,2 HAVING n>1').all();
  if ((contents as unknown[]).length) failures.push(`duplicate contents: ${JSON.stringify(contents)}`);
} finally { service.close(); await rm(dir, { recursive: true, force: true }); }
if (failures.length) { console.error('R3 FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log(`R3 network flapping clean; media fetches=${fetchPlan.calls.length}`);
