import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { createE11Paths } from '../src/main/e11-isolation.js';
import { sha256File } from '../src/main/editor-media.js';
import { auditE11, resourceSnapshot, tableSnapshot, treeFiles } from '../scripts/audit-editor-e11.js';
import { restoreE11Backup, upgradeE11 } from '../scripts/upgrade-editor-e11.js';
import { png, seed } from './e1-helpers.js';
const binding = path.resolve('.runtime/node24.node');
const name = () => path.resolve('.acceptance-data/editor-e11', `migration-test-${randomUUID()}`);
function database(root: string, readonly = true): Database.Database { return new Database(path.join(root, 'data/workbench.sqlite'), { readonly, fileMustExist: true, nativeBinding: binding }); }
function logical(root: string) { const db = database(root); try { return tableSnapshot(db); } finally { db.close(); } }
function fixture(version: 4 | 6) {
  const root = name(), p = createE11Paths(root);
  writeFileSync(path.join(root, 'e11-isolated.json'), JSON.stringify({ schema: 1, kind: 'read-later-workbench-editor-e11', root, networkBlockedRequired: true, synthetic: true }));
  const store = new Store(p.dataDir);
  let requestId: string | undefined;
  try {
    const id = seed(store, 'migration-synthetic', 'test-account', '人工稿🙂\n保留旧版本');
    seed(store, 'null-edited', 'test-account', null);
    store.detailSaved(id, { body: '冻结来源正文🙂', bodyComplete: true, mediaManifestComplete: true, media: [{ kind: 'image', remoteUrl: 'https://offline.invalid/synthetic-image', mime: 'image/png', role: 'gallery', resourceKey: 'synthetic-image', version: 'v1' }] });
    const media = store.content(id)!.media[0]; writeFileSync(path.join(p.dataDir, 'media', 'fixed.png'), png); store.downloadSaved(media.id, 'fixed.png', png.length, 'image/png');
    mkdirSync(path.join(p.dataDir, 'custom', 'empty-child'), { recursive: true });
    writeFileSync(path.join(p.dataDir, 'custom', 'opaque-resource.bin'), Buffer.from([0, 1, 2, 255]));
    mkdirSync(path.join(p.assetsDir, 'retained-empty'), { recursive: true });
    writeFileSync(path.join(p.assetsDir, 'unreferenced-retained.bin'), 'preserved bytes');
    if (version === 6) {
      migrateEditorSchema(store.db, p.dataDir);
      const editor = new EditorRepository(store.db, p.dataDir, p.assetsDir); editor.captureSource(id);
      const digest = new DigestRepository(store.db, p.dataDir, editor); requestId = digest.request(id).request!.id;
    }
  } finally { store.close(); }
  return { root, p, requestId, close() { rmSync(root, { recursive: true, force: true }); } };
}

for (const from of [4, 6] as const) test(`E11 complete ${from}→7 backup/migration/restore preserves old tables, resources and authorization with no OCR`, async () => {
  const f = fixture(from), restored = name();
  try {
    const before = logical(f.root), resources = resourceSnapshot(f.p.dataDir, f.p.assetsDir), db = database(f.root);
    const contents = db.prepare('SELECT * FROM contents ORDER BY id').all();
    const scopes = from === 6 ? db.prepare('SELECT scope_json FROM digest_requests ORDER BY id').all() : [];
    db.close();
    const result = await upgradeE11(f.root);
    assert.equal(result.migrated, true); assert.equal(result.schema, 7); assert.equal(result.fromSchema, from); assert.ok(result.backup);
    const manifest = JSON.parse(readFileSync(path.join(result.backup!, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.tables, before); assert.ok(manifest.files.some((file: any) => file.path === 'data/custom/opaque-resource.bin'));
    assert.ok(manifest.files.some((file: any) => file.path === 'editor-assets/unreferenced-retained.bin'));
    assert.ok(manifest.directories.includes('data/custom/empty-child')); assert.ok(manifest.directories.includes('editor-assets/retained-empty'));
    for (const file of resources) { const found = treeFiles(f.root).find(item => item.path === file.path); assert.deepEqual(found, file); }
    const migrated = database(f.root);
    try {
      assert.deepEqual(migrated.prepare('SELECT * FROM contents ORDER BY id').all(), contents);
      assert.equal(migrated.pragma('user_version', { simple: true }), 7);
      for (const table of ['ocr_jobs', 'ocr_results', 'ocr_calls', 'ocr_probe_calls']) assert.equal((migrated.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n, 0);
      if (from === 6) assert.deepEqual(migrated.prepare('SELECT scope_json FROM digest_requests ORDER BY id').all(), scopes);
      else assert.equal((migrated.prepare('SELECT count(*) n FROM digest_requests').get() as any).n, 0);
    } finally { migrated.close(); }
    const audit = auditE11(f.root); assert.equal(audit.valid, true, JSON.stringify(audit.issues)); assert.equal(audit.calls.ocr, 0); assert.equal(audit.calls.probes, 0);
    assert.deepEqual(audit.calls.digestReal, {}); assert.deepEqual(audit.calls.digestSynthetic, {});
    const restoredResult = restoreE11Backup(result.backup!, restored);
    assert.equal(restoredResult.schema, from); assert.deepEqual(logical(restored), before);
    assert.deepEqual(resourceSnapshot(path.join(restored, 'data'), path.join(restored, 'editor-assets')), resources);
    assert.ok(existsSync(path.join(restored, 'data/custom/empty-child'))); assert.ok(existsSync(path.join(restored, 'editor-assets/retained-empty')));
    assert.equal(JSON.parse(readFileSync(path.join(restored, 'e11-isolated.json'), 'utf8')).root, restored);
    assert.equal(auditE11(restored).schema, from); assert.equal(auditE11(f.root).schema, 7);
  } finally { f.close(); rmSync(restored, { recursive: true, force: true }); }
});

for (const from of [4, 6] as const) test(`E11 ${from}→7 injected schema failure rolls back and retains a complete recoverable backup`, async () => {
  const f = fixture(from), restored = name();
  try {
    const before = logical(f.root), resources = resourceSnapshot(f.p.dataDir, f.p.assetsDir);
    await assert.rejects(upgradeE11(f.root, { failAfterSchema: true }), /injected migration failure/);
    assert.deepEqual(logical(f.root), before);
    for (const file of resources) assert.equal(sha256File(path.join(f.root, file.path)), file.sha256);
    const backups = path.join(f.root, 'upgrade-backups'), backup = path.join(backups, readdirSync(backups)[0]);
    assert.ok(existsSync(path.join(backup, 'manifest.json'))); assert.ok(!existsSync(path.join(f.root, '.e11-upgrade.lock')));
    restoreE11Backup(backup, restored); assert.deepEqual(logical(restored), before);
    assert.equal((await upgradeE11(f.root)).migrated, true);
  } finally { f.close(); rmSync(restored, { recursive: true, force: true }); }
});

test('E11 successful schema7 upgrade is idempotent without new backups, requests, calls or file changes', async () => {
  const f = fixture(6);
  try {
    await upgradeE11(f.root); const before = logical(f.root), files = treeFiles(f.root);
    const result = await upgradeE11(f.root);
    assert.equal(result.migrated, false); assert.equal(result.backup, null); assert.deepEqual(logical(f.root), before); assert.deepEqual(treeFiles(f.root), files);
  } finally { f.close(); }
});

test('E11 readonly audit keeps running business/digest rows and zero-call ledgers byte-for-byte; bad scope is diagnosed without recovery', async () => {
  const f = fixture(6);
  try {
    await upgradeE11(f.root);
    const db = database(f.root, false);
    try {
      db.prepare("UPDATE contents SET detail_state='running',repair_state='running',detail_error='retained' WHERE id=1").run();
      db.prepare("UPDATE media SET state='running',error='retained'").run();
      db.prepare("UPDATE digest_stages SET state='running',run_id='retained-run' WHERE name='ocr'").run();
      db.prepare("UPDATE digest_requests SET state='extracting'").run();
    } finally { db.close(); }
    const before = logical(f.root), files = treeFiles(f.root), a = auditE11(f.root), b = auditE11(f.root);
    assert.equal(a.readOnly, true); assert.equal(a.queryOnly, true); assert.equal(a.valid, true, JSON.stringify(a.issues));
    assert.equal(a.calls.ocr, 0); assert.equal(a.calls.probes, 0); assert.deepEqual(a.tables, b.tables);
    assert.deepEqual(logical(f.root), before); assert.deepEqual(treeFiles(f.root), files);
    const corrupt = database(f.root, false); corrupt.prepare("UPDATE digest_requests SET scope_json='{}'").run(); corrupt.close();
    const invalidBefore = logical(f.root), invalid = auditE11(f.root);
    assert.equal(invalid.valid, false); assert.ok(invalid.issues.some(issue => issue.code === 'scope-or-fixed-resource')); assert.deepEqual(logical(f.root), invalidBefore);
  } finally { f.close(); }
});

test('E11 higher schema and out-of-scope E1/formal/alias paths are refused before any write', async () => {
  const f = fixture(4), alias = name();
  try {
    const db = database(f.root, false); db.pragma('user_version=99'); db.close();
    const before = treeFiles(f.root);
    assert.throws(() => auditE11(f.root), /未知版本/); await assert.rejects(upgradeE11(f.root), /未知高版本/);
    // SQLite readonly connections may create empty WAL/SHM coordination files;
    // neither the main DB, resource bytes nor any table may change.
    assert.deepEqual(treeFiles(f.root).filter(file => !/workbench\.sqlite-(wal|shm)$/.test(file.path)), before.filter(file => !/workbench\.sqlite-(wal|shm)$/.test(file.path))); assert.ok(!existsSync(path.join(f.root, 'upgrade-backups')));
    for (const root of [path.resolve('.acceptance-data/editor-e1/old-e1'), path.resolve('data'), f.root + '/..']) {
      assert.throws(() => auditE11(root), /RLW_E11_DIR/); await assert.rejects(upgradeE11(root), /RLW_E11_DIR/);
    }
    symlinkSync(f.root, alias, 'dir'); assert.throws(() => auditE11(alias), /符号链接/); await assert.rejects(upgradeE11(alias), /符号链接/);
  } finally { f.close(); rmSync(alias, { force: true }); }
});

test('E11 backup-only interruption, exclusive upgrade lock and tampered full restore all fail safely', async () => {
  const f = fixture(4), target = name();
  try {
    const before = logical(f.root); await assert.rejects(upgradeE11(f.root, { failAfterBackup: true }), /after complete backup/); assert.deepEqual(logical(f.root), before);
    writeFileSync(path.join(f.root, '.e11-upgrade.lock'), 'other isolated rehearsal');
    await assert.rejects(upgradeE11(f.root), /EEXIST/); assert.deepEqual(logical(f.root), before); rmSync(path.join(f.root, '.e11-upgrade.lock'));
    const backups = path.join(f.root, 'upgrade-backups'), backup = path.join(backups, readdirSync(backups)[0]);
    writeFileSync(path.join(backup, 'data/custom/opaque-resource.bin'), 'tampered');
    assert.throws(() => restoreE11Backup(backup, target), /SHA清单不符/); assert.ok(!existsSync(target)); assert.deepEqual(logical(f.root), before);
  } finally { f.close(); rmSync(target, { recursive: true, force: true }); }
});

test('E11 full backup materializes committed WAL bytes into a self-contained restorable database', async () => {
  const f = fixture(4), target = name(), writer = database(f.root, false);
  try {
    writer.pragma('journal_mode=WAL'); writer.pragma('wal_autocheckpoint=0');
    writer.prepare('UPDATE contents SET edited_body=? WHERE id=1').run('已提交WAL中的人工稿🙂');
    assert.ok(existsSync(path.join(f.p.dataDir, 'workbench.sqlite-wal')));
    const expected = tableSnapshot(writer), result = await upgradeE11(f.root);
    const restored = restoreE11Backup(result.backup!, target), db = database(target);
    try {
      assert.equal(restored.schema, 4); assert.deepEqual(tableSnapshot(db), expected);
      assert.equal((db.prepare('SELECT edited_body FROM contents WHERE id=1').get() as any).edited_body, '已提交WAL中的人工稿🙂');
      assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    } finally { db.close(); }
    assert.ok(!existsSync(path.join(target, 'data/workbench.sqlite-wal'))); assert.ok(!existsSync(path.join(target, 'data/workbench.sqlite-shm')));
  } finally { writer.close(); f.close(); rmSync(target, { recursive: true, force: true }); }
});
