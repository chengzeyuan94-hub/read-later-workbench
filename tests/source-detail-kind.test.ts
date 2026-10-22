import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import type { CollectionItem, CollectionSnapshot, DetailResult } from '../src/shared/contracts.js';

test('real detail media upgrades collection kind, repeated list metadata preserves it, and missing media never downgrades video/audio', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-source-kind-')); const store = new Store(dir);
  const item: CollectionItem = { sourceId: 'kind-fixture', title: 'fixture', author: 'fixture', url: 'https://fixture.invalid/post', kind: 'text', folderIds: ['saved'] };
  const snapshot: CollectionSnapshot = { platform: 'weibo', accountId: 'fixture', accountName: 'fixture', folders: [{ id: 'saved', title: 'saved' }], items: [item], complete: true };
  const detail = (kind: 'image' | 'video' | 'audio'): DetailResult => ({ body: 'fixture body', bodyComplete: true, mediaManifestComplete: true, media: [{ kind, remoteUrl: `https://fixture.invalid/${kind}`, resourceKey: kind }] });
  const saveList = (kind: CollectionItem['kind']) => store.saveSnapshot(snapshot, [{ item: { ...item, kind }, discovery: 'historical' }], 1);
  try {
    saveList('text'); const id = store.find('weibo', 'fixture', item.sourceId)!;
    store.detailSaved(id, detail('image')); assert.equal(store.content(id)!.kind, 'image'); assert.equal(store.content(id)!.offline, false, 'queued image is not offline');
    saveList('text'); assert.equal(store.content(id)!.kind, 'image', 'list cannot demote an actual image to text');
    store.detailSaved(id, detail('audio')); assert.equal(store.content(id)!.kind, 'audio'); saveList('text'); assert.equal(store.content(id)!.kind, 'audio');
    store.detailSaved(id, detail('video')); assert.equal(store.content(id)!.kind, 'video'); saveList('image'); assert.equal(store.content(id)!.kind, 'video');
    store.detailSaved(id, { body: 'partial refresh', bodyComplete: true, mediaManifestComplete: false, media: [] }); assert.equal(store.content(id)!.kind, 'video'); assert.equal(store.content(id)!.offline, false);
    const other = { ...item, sourceId: 'list-only', kind: 'image' as const }; store.saveSnapshot({ ...snapshot, items: [other] }, [{ item: other, discovery: 'historical' }], 1);
    const otherId = store.find('weibo', 'fixture', other.sourceId)!;
    store.saveSnapshot({ ...snapshot, items: [{ ...other, kind: 'text' }] }, [{ item: { ...other, kind: 'text' }, discovery: 'historical' }], 1);
    assert.equal(store.content(otherId)!.kind, 'text', 'new list evidence may correct a card classification when no actual media was ever saved');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
