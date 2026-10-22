// R7: delete/restore races.
//  a) delete while media are only queued -> allowed, files purged
//  b) delete while a media download is running -> blocked
//  c) delete racing a sync save -> consistent result, no crash
//  d) restore -> item re-downloads; next sync honours the (removed) tombstone
//  e) delete items sharing an editor asset -> shared file kept until last ref
//  f) pending_file_deletions drains; scheduler never dispatches deleted content
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../../src/main/service.js';
import { baseOptions, fakeAdapter, fakeDetail, fakeFetch, fakeImage, fakeSnapshot, sleep, streamingResponse, until } from './fakes.js';
import type { Platform } from '../../src/shared/contracts.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-stab-r7-'));
const failures: string[] = [];

// Gate for the media stream so a download can be held "running".
let release: () => void = () => {};
let gated = false;
const fetchPlan = fakeFetch(async () => {
  if (!gated) return streamingResponse({ bytes: 2048 });
  return new Response(new ReadableStream<Uint8Array>({ async start(c) { await new Promise<void>(r => { release = () => { c.enqueue(new Uint8Array(2048)); c.close(); r(); }; }); } }), { headers: { 'content-type': 'image/png', 'content-length': '2048' } });
});

const platform: Platform = 'bilibili';
const adapter = fakeAdapter({
  platform, ids: ['a', 'b', 'c', 'd'],
  detail: async item => ({ ...fakeDetail(item.sourceId), media: [fakeImage(`${item.sourceId}-m`)] }),
});
const service = new WorkbenchService(dir, [adapter], baseOptions({ fetch: fetchPlan.perCall, editorEnabled: true }));
const contents = () => service.state().contents;
const pendingRows = () => (service.store.db.prepare('SELECT count(*) n FROM pending_file_deletions').get() as { n: number }).n;

try {
  await service.sync();
  await until(() => contents().every(c => c.detailState === 'succeeded' && c.media.every(m => m.state === 'succeeded')), 800);
  const [a, b, c, d] = contents().map(x => x.id);

  // (a) queued-only delete: pause dispatch, put a's media back in the queue with
  // its file still on disk, then delete — a queued item may be deleted.
  service.pauseDownloads();
  const mA = contents().find(x => x.id === a)!.media[0];
  const fileA = path.join(service.store.mediaDir, mA.localPath!);
  if (!existsSync(fileA)) failures.push('(a) setup: media file missing before delete');
  service.store.db.prepare("UPDATE media SET state='queued',error=NULL WHERE id=?").run(mA.id);
  const resA = service.deleteContents([a]);
  if (!resA.deleted.includes(a)) failures.push('(a) queued-media delete was blocked');
  if (existsSync(fileA)) failures.push('(a) media file left behind after delete');
  if (pendingRows()) failures.push(`(a) pending_file_deletions not drained: ${pendingRows()}`);
  const tombA = service.store.db.prepare('SELECT 1 FROM content_deletions WHERE content_id=?').get(a);
  if (!tombA) failures.push('(a) no tombstone written');
  service.resumeDownloads();

  // (b) running-media delete: ungate one download for b? b is already complete;
  // instead restore b-free approach: use item d — set its media back to queued,
  // start download with gate on, then try to delete while running.
  gated = true;
  const mD = contents().find(x => x.id === d)!.media[0];
  service.store.db.prepare("UPDATE media SET state='queued',local_path=NULL WHERE id=?").run(mD.id);
  service.pump();
  const mediaState = () => (service.store.db.prepare('SELECT state FROM media WHERE id=?').get(mD.id) as { state: string }).state;
  await until(() => mediaState() === 'running', 400);
  const resB = service.deleteContents([d]);
  if (resB.deleted.includes(d) || !resB.blocked.length) failures.push('(b) running-media delete was not blocked');
  release(); gated = false;
  await until(() => mediaState() === 'succeeded', 400);

  // (c) delete racing a sync save.
  const syncPromise = service.sync();
  const resC = service.deleteContents([c]);
  await syncPromise;
  if (!resC.deleted.includes(c)) failures.push(`(c) sync-time delete blocked: ${JSON.stringify(resC.blocked)}`);
  if (service.store.db.prepare('SELECT 1 FROM contents WHERE id=? AND detail_state=\'running\'').get(c)) failures.push('(c) deleted item left running');
  if (pendingRows()) failures.push(`(c) pending_file_deletions not drained: ${pendingRows()}`);

  // (e) shared editor asset: two workspaces pin the same editor-assets file.
  const assetsDir = service.store.editor!.assetsDir;
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, 'shared.png'), 'shared-bytes');
  const owner = (id: number) => contents().find(x => x.id === id)!;
  const ws = service.store.db.prepare('INSERT INTO editor_workspaces VALUES(?,?,?,?,?,?,?,?,NULL)');
  const now = Date.now();
  const wa = `ws-${b}`, wb = `ws-${d}`;
  ws.run(wa, b, owner(b).platform, owner(b).accountId, owner(b).sourceId, '{}', now, now);
  ws.run(wb, d, owner(d).platform, owner(d).accountId, owner(d).sourceId, '{}', now, now);
  const ea = service.store.db.prepare('INSERT INTO editor_assets VALUES(?,?,?,?,?)');
  ea.run('shared-asset-a', 'v1', wa, owner(b).media[0].id, JSON.stringify({ id: 'shared-asset-a', version: 'v1', relativePath: 'shared.png', mime: 'image/png', sha256: 'x' }));
  ea.run('shared-asset-b', 'v2', wb, owner(d).media[0].id, JSON.stringify({ id: 'shared-asset-b', version: 'v2', relativePath: 'shared.png', mime: 'image/png', sha256: 'x' }));
  const resE1 = service.deleteContents([b]);
  if (!resE1.deleted.includes(b)) failures.push(`(e) delete of shared-asset owner blocked: ${JSON.stringify(resE1.blocked)}`);
  if (!existsSync(path.join(assetsDir, 'shared.png'))) failures.push('(e) shared editor asset unlinked while still referenced');
  const resE2 = service.deleteContents([d]);
  if (!resE2.deleted.includes(d)) failures.push(`(e) second owner delete blocked: ${JSON.stringify(resE2.blocked)}`);
  if (existsSync(path.join(assetsDir, 'shared.png'))) failures.push('(e) shared editor asset kept after last reference removed');

  // (d) restore + sync: tombstone gone, item re-downloads, later sync keeps it.
  service.restoreDeleted(c);
  await until(() => contents().find(x => x.id === c)!.detailState === 'succeeded' && contents().find(x => x.id === c)!.media.every(m => m.state === 'succeeded'), 800);
  await service.sync();
  const tombGone = !service.store.db.prepare('SELECT 1 FROM content_deletions WHERE content_id=?').get(c);
  if (!tombGone) failures.push('(d) tombstone survived restore');
  // (a)+(c)+(e) tombstoned items must never resurface on sync.
  const stateAfter = contents();
  if (stateAfter.some(x => [a, b, d].includes(x.id))) failures.push('(d) tombstoned items resurfaced in state()');
  const stillDeleted = service.store.db.prepare('SELECT content_id FROM content_deletions ORDER BY content_id').all() as { content_id: number }[];
  if (JSON.stringify(stillDeleted.map(r => r.content_id)) !== JSON.stringify([a, b, d].sort())) failures.push(`(d) tombstone set wrong: ${JSON.stringify(stillDeleted)}`);
  if (pendingRows()) failures.push(`final: pending_file_deletions not drained: ${pendingRows()}`);

  // Scheduler never dispatches deleted content.
  const laneIds = new Set<number>();
  for (const task of (service as unknown as { laneTasks: Map<string, { type: string; id: number }> }).laneTasks.values()) laneIds.add(task.id);
  if ([a, b, d].some(id => laneIds.has(id))) failures.push('deleted content still dispatched');
  const deletedMedia = service.store.db.prepare("SELECT count(*) n FROM media WHERE content_id IN (SELECT content_id FROM content_deletions) AND state IN ('queued','running')").get() as { n: number };
  if (deletedMedia.n) failures.push(`${deletedMedia.n} media rows of deleted contents still queued/running`);
} finally { service.close(); await rm(dir, { recursive: true, force: true }); }

if (failures.length) { console.error('R7 FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log('R7 delete/restore races clean');
