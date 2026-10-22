// R8: scale — derive a 5k-content / 20k-media / 300-digest-library DB from the
// real-copy schema, then measure state() p50/p95 over 20 calls (threshold 250ms).
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeFetch } from './fakes.js';

const SOURCE = path.resolve('.acceptance-data/batch-sync/e42-20261018-e44v/data');
const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r8-'));
const dataDir = path.join(dir, 'data');
await cp(SOURCE, dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'workbench.sqlite'));
const accounts = db.prepare('SELECT platform,account_id FROM accounts').all() as { platform: string; account_id: string }[];
const now = Date.now();
const needContents = 5000 - (db.prepare('SELECT count(*) n FROM contents').get() as { n: number }).n;
const needMedia = 20000 - (db.prepare('SELECT count(*) n FROM media').get() as { n: number }).n;
const needLibrary = 300 - (db.prepare('SELECT count(*) n FROM digest_library').get() as { n: number }).n;

db.transaction(() => {
  const insContent = db.prepare(`INSERT INTO contents(platform,account_id,source_id,title,author,url,kind,published_at,collected_at,first_discovered_at,discovery,source_body,body_complete,subtitle,detail_state,manifest_complete,adapter_version,availability)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insRank = db.prepare('INSERT INTO content_favorite_order(content_id,rank) VALUES(?,?)');
  const insMedia = db.prepare(`INSERT INTO media(content_id,kind,remote_url,mime,state,local_path,bytes,resource_key,media_order,current) VALUES(?,?,?,?,?,?,?,?,?,1)`);
  const insLibrary = db.prepare(`INSERT OR IGNORE INTO digest_library(content_id,active,legacy,entered_at,completed_at,source) VALUES(?,1,0,?,?, 'ai')`);
  const contentIds: number[] = [];
  for (let i = 0; i < needContents; i++) {
    const acc = accounts[i % accounts.length];
    const id = Number(insContent.run(acc.platform, acc.account_id, `synthetic-${i}`, `合成收藏 ${i}`, '压测', `https://fixture.invalid/${acc.platform}/synthetic-${i}`, i % 3 ? 'text' : 'video',
      now - i * 60_000, now - i * 60_000, now - i * 60_000, 'historical', `正文 ${i} `.repeat(20), 1, '', 'succeeded', 1, 1, 'available').lastInsertRowid);
    insRank.run(id, 10_000 - i);
    contentIds.push(id);
    for (let m = 0; m < 4; m++) insMedia.run(id, 'image', `https://fixture.invalid/media/syn-${i}-${m}`, 'image/png', 'succeeded', `syn-${id}-${m}.png`, 1234, `syn-${i}-${m}`, m);
  }
  // Top media up to 20000 across existing contents too.
  let extra = needMedia - needContents * 4;
  if (extra > 0) {
    const existing = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 2000').all() as { id: number }[];
    let i = 0;
    while (extra > 0) {
      for (const row of existing) {
        for (let m = 4; m < 8 && extra > 0; m++, extra--) insMedia.run(row.id, 'image', `https://fixture.invalid/media/ex-${row.id}-${m}`, 'image/png', 'succeeded', `ex-${row.id}-${m}.png`, 1234, `ex-${row.id}-${m}`, m);
        i++;
        if (!extra) break;
      }
    }
  }
  for (let i = 0; i < needLibrary && i < contentIds.length; i++) insLibrary.run(contentIds[i], now - i * 1000, now - i * 1000);
})();
db.close();

console.log(`seeded: contents=${5000} media=${20000} digest_library=${300} (added ${needContents}/${needMedia}/${needLibrary})`);

const service = new WorkbenchService(dataDir, [], baseOptions({ fetch: fakeFetch(async () => new Response('x')).perCall, editorEnabled: true, ocrEnabled: true, asrEnabled: true, generationEnabled: true }));
try {
  // Equality gate: batched contents()/list() must match the per-row path exactly
  // on the real-copy data (incl. ranks, folders, tombstones, digest requests).
  {
    const list = service.store.contents();
    for (const item of list) {
      const single = service.store.content(item.id);
      if (JSON.stringify(item) !== JSON.stringify(single)) { console.error(`R8 FAIL: contents()/${item.id} differs from content()`); process.exit(1); }
    }
    const digest = service.store.digestPipeline;
    if (digest) {
      const listed = digest.list();
      for (const entry of listed) {
        const single = digest.status(entry.contentId);
        if (JSON.stringify(entry) !== JSON.stringify(single)) { console.error(`R8 FAIL: list()/${entry.contentId} differs from status()`); process.exit(1); }
      }
      console.log(`equality gate: ${list.length} contents + ${listed.length} digest states identical`);
    }
  }
  // warm-up then measure
  service.state();
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    service.state();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[10], p95 = samples[19];
  console.log(`state() p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=${samples.map(s => s.toFixed(0)).join(',')})`);
  if (p95 > 250) { console.error('R8 FAIL: state() p95 over 250ms'); process.exit(1); }
  console.log('R8 scale clean');
} finally { service.close(); await rm(dir, { recursive: true, force: true }); }
