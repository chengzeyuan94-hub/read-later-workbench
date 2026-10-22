// R2a: crash recovery — abandon the service mid-download without close(), reopen,
// and require the queue to recover honestly (no running rows, no .part files,
// every succeeded file present with matching bytes, queue completes, no dup media).
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeAdapter, fakeDetail, fakeFetch, fakeImage, fakeSnapshot, rng, sleep, streamingResponse, until } from './fakes.js';
import type { Platform } from '../../src/shared/contracts.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r2-'));
const random = rng(42);
const PLATFORMS: Platform[] = ['xiaohongshu', 'bilibili'];
const failures: string[] = [];

const adapters = () => PLATFORMS.map((platform, i) => fakeAdapter({
  platform,
  ids: ['a', 'b', 'c'].map(id => `${platform}-${id}`),
  detail: async item => ({ ...fakeDetail(item.sourceId), media: [fakeImage(`${item.sourceId}-1`), fakeImage(`${item.sourceId}-2`)] }),
}));

for (let round = 0; round < 20; round++) {
  // Slow streaming so downloads are genuinely in flight when we "crash".
  const fetchPlan = fakeFetch(async () => streamingResponse({ bytes: 8192, chunk: 512, delay: 8 }));
  const service = new WorkbenchService(dir, adapters(), baseOptions({ fetch: fetchPlan.perCall }));
  await service.sync();
  // Let detail+media dispatch get underway, then "kill" at a random point.
  await sleep(Math.floor(random() * 120));
  // Simulate process death: halt timers/pumps without graceful cleanup.
  const raw = service as unknown as { timer: NodeJS.Timeout; laneTasks: Map<unknown, { abort: AbortController }>; closed: boolean };
  clearInterval(raw.timer); raw.closed = true;
  for (const task of raw.laneTasks.values()) task.abort.abort();
  await sleep(30);

  const reopened = new WorkbenchService(dir, adapters(), baseOptions({ fetch: async () => new Response('ok-image', { headers: { 'content-type': 'image/png' } }) }));
  try {
    const rows = reopened.store.db.prepare("SELECT count(*) n FROM contents WHERE detail_state='running'").get() as { n: number };
    const mediaRunning = reopened.store.db.prepare("SELECT count(*) n FROM media WHERE state='running'").get() as { n: number };
    if (rows.n || mediaRunning.n) failures.push(`round ${round}: running rows after reopen details=${rows.n} media=${mediaRunning.n}`);
    const parts = (await readdir(reopened.store.mediaDir)).filter(file => file.endsWith('.part'));
    if (parts.length) failures.push(`round ${round}: leftover .part ${parts.join(',')}`);
    await until(() => reopened.state().contents.every(c => c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')), 900);
    const dup = reopened.store.db.prepare(`SELECT content_id,resource_key,count(*) n FROM media WHERE current=1 GROUP BY content_id,resource_key HAVING n>1`).all() as { n: number }[];
    if (dup.length) failures.push(`round ${round}: duplicate current media rows ${JSON.stringify(dup)}`);
    for (const content of reopened.state().contents) {
      for (const media of content.media) {
        const file = media.localPath ? path.join(reopened.store.mediaDir, media.localPath) : null;
        if (!file || !existsSync(file)) { failures.push(`round ${round}: media ${media.id} succeeded without file`); continue; }
        if (statSync(file).size !== media.bytes) failures.push(`round ${round}: media ${media.id} bytes mismatch ${statSync(file).size}!=${media.bytes}`);
      }
    }
  } finally { reopened.close(); }
}
await rm(dir, { recursive: true, force: true });
if (failures.length) { console.error('R2a FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log('R2a service crash recovery: 20/20 clean');
