// E4.10 regression: store.contents() and DigestRepository.list() were changed
// from per-row queries to batched loads. The batched output must be identical
// to what the old per-row path produces — content(id) still uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, seed, png, repository } from './e1-helpers.js';
import { DigestRepository } from '../src/main/digest-store.js';

test('store.contents() batched load matches per-row content(id) exactly', () => {
  const f = setup();
  try {
    const ids: number[] = [];
    // Variety: folders, ranks, media in every state, a deleted row, no-media row.
    const a = seed(f.store, 'a-1'); ids.push(a);
    f.store.db.prepare("INSERT INTO content_folders VALUES(?,?),(?,?)").run(a, 'f-b', a, 'f-a');
    f.store.db.prepare('INSERT INTO content_favorite_order VALUES(?,?) ON CONFLICT(content_id) DO UPDATE SET rank=excluded.rank').run(a, 42.5);
    f.store.detailSaved(a, { body: 'b', bodyComplete: true, mediaManifestComplete: true, media: [
      { remoteUrl: 'https://x.invalid/m1', kind: 'image', mime: 'image/png', resourceKey: 'm1' },
      { remoteUrl: 'https://x.invalid/m2', kind: 'image', mime: 'image/png', resourceKey: 'm2' },
    ] });
    const m1 = f.store.content(a)!.media[0];
    writeFileSync(path.join(f.root, 'media', 'm1.png'), png);
    f.store.downloadSaved(m1.id, 'm1.png', png.length, 'image/png');

    const b = seed(f.store, 'b-1'); ids.push(b); // no folders, no media rows
    f.store.db.prepare('DELETE FROM content_favorite_order WHERE content_id=?').run(b); // unranked
    const c = seed(f.store, 'c-1'); ids.push(c);
    f.store.db.prepare('INSERT INTO content_folders VALUES(?,?)').run(c, 'only');
    f.store.detailSaved(c, { body: 'c', bodyComplete: true, mediaManifestComplete: true, media: [
      { remoteUrl: 'https://x.invalid/cm', kind: 'image', mime: 'image/png', resourceKey: 'cm' },
    ] });
    const gone = seed(f.store, 'gone-1');
    f.store.deleteContents([gone], Date.now()); // tombstoned: must not appear

    const list = f.store.contents();
    assert.equal(list.length, 3);
    const byId = new Map(list.map(item => [item.id, item]));
    for (const id of ids) assert.deepEqual(byId.get(id), f.store.content(id), `content ${id} differs`);
    assert.ok(!byId.has(gone), 'deleted content leaked into contents()');
    assert.deepEqual(byId.get(a)!.folderIds, ['f-a', 'f-b'], 'folder ordering differs');
    assert.equal(byId.get(a)!.favoriteRank, 42.5);
    assert.equal(byId.get(b)!.favoriteRank, undefined);
  } finally { f.close(); }
});

test('digest list() batched load matches per-row status() exactly', () => {
  const f = setup();
  try {
    const editor = repository(f.store);
    const pipeline = new DigestRepository(f.store.db, f.root, editor);
    const ready = seed(f.store, 'ready-1');
    f.store.db.prepare("UPDATE contents SET manifest_complete=1,detail_state='succeeded' WHERE id=?").run(ready);
    const plain = seed(f.store, 'plain-1');
    // One content with a real request, one with a bare library row, one untouched.
    pipeline.requestSynthetic(ready);
    f.store.db.prepare("INSERT INTO digest_library(content_id,active,legacy,entered_at,completed_at,source) VALUES(?,0,1,111,222,'legacy')").run(plain);
    const untouched = seed(f.store, 'untouched-1');

    const listed = pipeline.list();
    const ids = [ready, plain, untouched].sort((x, y) => x - y);
    assert.deepEqual(listed.map(s => s.contentId), ids, 'list() order/coverage differs');
    for (const id of ids) assert.deepEqual(listed.find(s => s.contentId === id), pipeline.status(id), `status ${id} differs`);
  } finally { f.close(); }
});
