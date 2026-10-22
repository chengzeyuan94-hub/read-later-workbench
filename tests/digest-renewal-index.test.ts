import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createE3RealPaths } from '../src/main/e3-real-isolation.js';
import { Store } from '../src/main/store.js';
import { migrateEditorSchema, EditorRepository } from '../src/main/editor-store.js';
import { migrateAsrSchema } from '../src/main/asr-store.js';
import { migrateGenerationSchema } from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { DIGEST_RENEWAL_INDEX_SQL, hasTerminalDigestHistory, migrateDigestRenewalIndex } from '../src/main/digest-renewal-index.js';
const oldSql = "CREATE UNIQUE INDEX digest_effective_request ON digest_requests(content_id) WHERE state NOT IN ('cancelled','complete')";
function fixture() {
  const base = path.resolve('.acceptance-data/editor-e3-real'); mkdirSync(base, { recursive: true });
  const reservation = mkdtempSync(path.join(base, 'quality-fix-index-parent-')), root = path.join(base, 'quality-fix-index-' + path.basename(reservation));
  const paths = createE3RealPaths(root), store = new Store(paths.dataDir);
  const item = { sourceId: 'index-fixture', title: '索引机制资料', author: 'synthetic', url: 'https://example.invalid/fixture', kind: 'text' as const, folderIds: [] };
  store.saveSnapshot({ platform: 'xiaohongshu', accountId: 'synthetic', accountName: 'synthetic', folders: [], complete: true, items: [item] }, [{ item, discovery: 'historical' }], 1);
  const id = store.find('xiaohongshu', 'synthetic', item.sourceId)!; store.detailSaved(id, { body: '合成机制正文。', bodyComplete: true, mediaManifestComplete: true, media: [] });
  migrateEditorSchema(store.db, paths.dataDir, { targetVersion: 7 }); const editor = new EditorRepository(store.db, paths.dataDir, paths.assetsDir); migrateAsrSchema(store.db, paths.dataDir); migrateGenerationSchema(store.db,paths.dataDir);
  store.db.exec('DROP INDEX digest_effective_request;' + oldSql);
  writeFileSync(path.join(root, 'e3-real-isolated.json'), JSON.stringify({ schema: 1, databaseSchema: 9, root, kind: 'read-later-workbench-editor-e3-real', networkBlockedRequired: true, profileCopied: false, credentialsCopied: false }));
  const digest = new DigestRepository(store.db, paths.dataDir, editor);
  return { paths, store, id, digest };
}
const requestRows = (f: ReturnType<typeof fixture>) => f.store.db.prepare('SELECT * FROM digest_requests ORDER BY rowid').all() as any[];

test('explicit index preparation preserves failed and unknown rows, keeps one live request, and leaves table format9 intact', () => {
  const f = fixture(); try {
    const first = f.digest.request(f.id).request!; f.store.db.prepare("UPDATE digest_requests SET state='failed' WHERE id=?").run(first.id); const before = requestRows(f)[0];
    assert.equal(hasTerminalDigestHistory(f.store.db), false); const migrated = migrateDigestRenewalIndex(f.store.db, f.paths.root);
    assert.equal(migrated.migrated, true); assert.equal(hasTerminalDigestHistory(f.store.db), true); assert.equal(f.store.db.pragma('user_version', { simple: true }), 9);
    const next = f.digest.request(f.id, true).request!; assert.notEqual(next.id, first.id); assert.deepEqual(requestRows(f)[0], before);
    assert.equal(f.digest.request(f.id).request!.id, next.id, 'ordinary duplicate click uses the existing live request');
    f.store.db.prepare("UPDATE digest_requests SET state='result-unknown' WHERE id=?").run(next.id); const unknown = requestRows(f)[1];
    const third = f.digest.request(f.id, true).request!; assert.notEqual(third.id, next.id); assert.deepEqual(requestRows(f)[1], unknown);
    assert.equal(migrateDigestRenewalIndex(f.store.db, f.paths.root).migrated, false);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM digest_requests WHERE state NOT IN ('cancelled','complete','failed','result-unknown')").get() as any).n, 1);
  } finally { f.store.close(); }
});

test('index transaction fault rolls back SQL and records, and the whole pre-change backup reopens independently', () => {
  const f = fixture(); try {
    f.digest.request(f.id); const before = requestRows(f);
    assert.throws(() => migrateDigestRenewalIndex(f.store.db, f.paths.root, { failAfterDrop: true }), /injected index/);
    assert.equal(hasTerminalDigestHistory(f.store.db), false); assert.deepEqual(requestRows(f), before);
    assert.equal((f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='digest_effective_request'").get() as any).sql, oldSql);
    const backup = readdirSync(f.paths.dataDir).find(name => name.startsWith('workbench-pre-terminal-history-'))!;
    const restored = path.join(f.paths.root, 'restored-backup.sqlite'); copyFileSync(path.join(f.paths.dataDir, backup), restored);
    const db = new Database(restored, { readonly: true, fileMustExist: true, ...(process.env.RLW_SQLITE_BINDING ? { nativeBinding: process.env.RLW_SQLITE_BINDING } : {}) });
    try { db.pragma('query_only=ON'); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(hasTerminalDigestHistory(db), false); assert.deepEqual(db.prepare('SELECT * FROM digest_requests ORDER BY rowid').all(), before); assert.equal(db.pragma('user_version', { simple: true }), 9); } finally { db.close(); }
    assert.equal((f.store.db.prepare('SELECT count(*) n FROM generation_calls').get() as any).n, 0);
  } finally { f.store.close(); }
});

test('an unmigrated old index keeps old explicit renewal behavior; unknown index or connection root is rejected', () => {
  const f = fixture(), other = fixture(); try {
    const first = f.digest.request(f.id).request!; f.store.db.prepare("UPDATE digest_requests SET state='failed' WHERE id=?").run(first.id);
    assert.equal(f.digest.preservesTerminalHistory(), false); assert.notEqual(f.digest.request(f.id, true).request!.id, first.id); assert.equal(requestRows(f)[0].state, 'cancelled');
    assert.throws(() => migrateDigestRenewalIndex(f.store.db, other.paths.root), /different root/);
    f.store.db.exec('DROP INDEX digest_effective_request;CREATE INDEX digest_effective_request ON digest_requests(requested_at)');
    assert.throws(() => migrateDigestRenewalIndex(f.store.db, f.paths.root), /unknown schema/);
    assert.notEqual(DIGEST_RENEWAL_INDEX_SQL, oldSql);
  } finally { f.store.close(); other.store.close(); }
});
