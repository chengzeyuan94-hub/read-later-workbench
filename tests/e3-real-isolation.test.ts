import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createE3FixPaths } from '../src/main/e3-fix-isolation.js';
import { createE3RealPaths, e3RealBuildMode, e3RealQaScript, isE3RealBuildName, resolveE3RealPaths } from '../src/main/e3-real-isolation.js';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { migrateAsrSchema } from '../src/main/asr-store.js';
import { migrateGenerationSchema, GenerationRepository } from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { isAsrPreparationNamespacePath } from '../src/main/asr-media.js';
import { cloneEditorE3Real } from '../scripts/editor-e3-real-clone.js';

// Every byte is new synthetic data inside this round's namespace. No provider,
// OCR helper, FFmpeg, platform adapter, credentials or real collection is read.
const project = path.resolve('.acceptance-data/editor-e3-real', `isolation-unit-${randomUUID()}`);
const binding = process.env.RLW_SQLITE_BINDING ?? path.resolve('.runtime/node24.node');
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function paths(name: string) {
  const projectRoot = path.join(project, name);
  return { projectRoot, source: path.join(projectRoot, '.acceptance-data/editor-e3-fix/source'), target: path.join(projectRoot, '.acceptance-data/editor-e3-real/target') };
}

test('real build entry fails closed on absent roots, old/formal settings and wrong build identity', () => {
  for (const name of ['editor-e3-real', 'editor-e3-real-r2']) assert.equal(isE3RealBuildName(name), true);
  for (const name of ['editor-e3', 'editor-e3-fix', 'editor-e3-really', 'editor-e3-real-', 'editor-e3-real/a']) assert.equal(isE3RealBuildName(name), false);
  assert.equal(e3RealBuildMode('/project/dist/editor-e3-real', { RLW_E3_REAL_DIR: '/selected' }), true);
  for (const environment of [{}, { RLW_E3_REAL_DIR: '/selected', RLW_E3_FIX_DIR: '/old' }, { RLW_E3_REAL_DIR: '/selected', RLW_DATA_DIR: '/formal' }, { RLW_E3_REAL_DIR: '/selected', RLW_USER_DATA_DIR: '/profile' }, { RLW_E3_REAL_DIR: '/selected', RLW_SOURCE_MODE: 'bridge' }]) assert.throws(() => e3RealBuildMode('/project/dist/editor-e3-real', environment));
  for (const build of ['editor-e3', 'editor-e3-fix', 'main']) assert.throws(() => e3RealBuildMode(`/project/dist/${build}`, { RLW_E3_REAL_DIR: '/selected' }));
  assert.equal(e3RealQaScript('generate-image'), 'scripts/editor-e3-real-generate.cjs');
  assert.equal(e3RealQaScript('reopen-offline'), 'scripts/editor-e3-real-generate.cjs');
  for (const mode of ['editor-first', 'editor-reopen']) assert.equal(e3RealQaScript(mode), 'scripts/editor-e3-real-editor.cjs');
  for (const mode of ['../unsafe.cjs', 'editor-other', 'generate-../../unsafe', 'generate-ABC', '']) assert.throws(() => e3RealQaScript(mode));
});

test('real paths reject old namespaces, reused roots, invalid marker, nesting and linked media', () => {
  const f = paths('path-boundaries'), p = createE3RealPaths(f.target, { projectRoot: f.projectRoot });
  assert.throws(() => createE3RealPaths(f.target, { projectRoot: f.projectRoot }));
  assert.throws(() => resolveE3RealPaths(f.target, { projectRoot: f.projectRoot, mustExist: true }));
  writeFileSync(path.join(p.dataDir, 'workbench.sqlite'), 'synthetic path fixture only');
  const marker = { schema: 1, databaseSchema: 10, root: f.target, kind: 'read-later-workbench-editor-e3-real', networkBlockedRequired: true, profileCopied: false, credentialsCopied: false };
  writeFileSync(path.join(p.root, 'e3-real-isolated.json'), JSON.stringify(marker));
  assert.equal(resolveE3RealPaths(f.target, { projectRoot: f.projectRoot, mustExist: true }).root, f.target);
  for (const delta of [{ databaseSchema: 4 }, { credentialsCopied: true }, { profileCopied: true }, { networkBlockedRequired: false }]) {
    writeFileSync(path.join(p.root, 'e3-real-isolated.json'), JSON.stringify({ ...marker, ...delta }));
    assert.throws(() => resolveE3RealPaths(f.target, { projectRoot: f.projectRoot, mustExist: true }));
  }
  writeFileSync(path.join(p.root, 'e3-real-isolated.json'), JSON.stringify(marker));
  const outside = path.join(f.projectRoot, 'ordinary'); mkdirSync(outside);
  symlinkSync(outside, path.join(p.dataDir, 'media'), 'dir');
  assert.throws(() => resolveE3RealPaths(f.target, { projectRoot: f.projectRoot, mustExist: true }));
  for (const candidate of [f.source, f.target + '/nested', f.target + '/../target', 'relative']) assert.throws(() => resolveE3RealPaths(candidate, { projectRoot: f.projectRoot }));
  const valid = path.join(p.dataDir, 'asr-prepared');
  assert.equal(isAsrPreparationNamespacePath(valid), true);
  for (const namespace of ['editor-e3-really', 'editor-e3-real-other', 'editor-e4']) assert.equal(isAsrPreparationNamespacePath(path.join('/workspace/.acceptance-data', namespace, 'copy/data/asr-prepared')), false);
});

function fixture(name: string) {
  const f = paths(name), p = createE3FixPaths(f.source, { projectRoot: f.projectRoot });
  const store = new Store(p.dataDir), item = { sourceId: 'synthetic-clone-only', title: '隔离克隆机制资料', author: 'test', url: 'https://www.xiaohongshu.com/explore/mechanism', kind: 'text' as const, folderIds: [] };
  store.saveSnapshot({ platform: 'xiaohongshu', accountId: 'mechanism', accountName: 'synthetic', folders: [], complete: true, items: [item] }, [{ item, discovery: 'historical' }], 1);
  const contentId = store.find('xiaohongshu', 'mechanism', item.sourceId)!;
  store.detailSaved(contentId, { body: '这不是收藏正文，只有合成隔离克隆机制。', bodyComplete: true, mediaManifestComplete: true, media: [] });
  migrateEditorSchema(store.db, p.dataDir, { targetVersion: 7 });
  const editor = new EditorRepository(store.db, p.dataDir), open = editor.open(contentId, 'source');
  if (!open.initialized) throw Error('fixture editor');
  editor.title(open.bundle.workspace.id, '不可被克隆覆盖的人工标题');
  migrateAsrSchema(store.db, p.dataDir); const requests = new DigestRepository(store.db, p.dataDir, editor); migrateGenerationSchema(store.db,p.dataDir);migrateE44Schema(store.db,p.dataDir);
  requests.request(contentId); const generation = new GenerationRepository(store.db, p.dataDir, editor, requests); const authorized = generation.authorize(contentId);
  const requestId = authorized.requestId!;
  const frozenScope = (store.db.prepare('SELECT scope_json FROM digest_requests WHERE id=?').get(requestId) as any).scope_json;
  store.db.prepare('INSERT INTO asr_authorizations VALUES(?,?,?,?,?,?)').run(requestId, contentId, 1, 'synthetic-fixed-scope', '{}', 1);
  const original = JSON.stringify({ fixture: 'synthetic raw result, not real ASR', originalIdentity: 'retained-result' });
  mkdirSync(path.join(p.dataDir, 'asr-results')); writeFileSync(path.join(p.dataDir, 'asr-results/result.json'), original);
  store.db.prepare('INSERT INTO asr_results VALUES(?,?,?,?,?,?,?,?,?)').run('retained-result', contentId, requestId, 7, 0, original, 'result.json', digest(path.join(p.dataDir, 'asr-results/result.json')), 1);
  store.db.prepare('INSERT INTO asr_corrections VALUES(?,?,?,?,?,?)').run('retained-result', 2, '{"fixture":"synthetic correction"}', 'correction.json', 'b'.repeat(64), 2);
  writeFileSync(path.join(p.dataDir, 'asr-results/correction.json'), '{"fixture":"synthetic correction"}');
  const prepared = JSON.stringify({ localPath: path.join(p.dataDir, 'asr-prepared/fragment.wav'), sha256: 'c'.repeat(64), bytes: 8 });
  store.db.prepare('INSERT INTO asr_media_jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('pending-media', requestId, contentId, 7, 'queued', null, null, prepared, 1, 1);
  store.db.prepare('INSERT INTO asr_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('pending-chunk', 'pending-media', requestId, contentId, 7, 0, 'queued', 0, null, prepared, 'stable-cache-key', null, 0, null, 0, 1);
  store.db.prepare('INSERT INTO asr_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('unknown-inflight', requestId, 1, 'synthetic-fixed-scope', 'pending-chunk', 7, '{}', 'c'.repeat(64), 'submitted', 1, 1, null, null);
  store.db.prepare("INSERT INTO settings(key,value) VALUES('autoSync','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  store.close();
  writeFileSync(path.join(p.root, 'e3-fix-isolated.json'), JSON.stringify({ schema: 1, databaseSchema: 9, root: p.root, kind: 'read-later-workbench-editor-e3-fix', networkBlockedRequired: true }));
  writeFileSync(path.join(p.userDataDir, 'private-profile-sentinel'), 'synthetic profile must not be copied');
  writeFileSync(path.join(p.userDataDir, 'deepseek-key.encrypted'), 'synthetic encrypted sentinel, not a credential');
  writeFileSync(path.join(p.assetsDir, 'synthetic-original.bin'), 'synthetic source attachment');
  return { ...f, p, requestId, frozenScope };
}

test('read-only fix→real snapshot retains identities, manual/source history and bytes; pauses old pending work without copying private profile/config', async () => {
  const f = fixture('clone-preservation'), before = digest(path.join(f.p.dataDir, 'workbench.sqlite'));
  const result = await cloneEditorE3Real({ source: f.source, target: f.target, projectRoot: f.projectRoot, nativeBinding: binding });
  assert.equal(result.newUploads, 0); assert.equal(result.credentialsCopied, false); assert.equal(result.profileCopied, false);
  assert.equal(digest(path.join(f.p.dataDir, 'workbench.sqlite')), before, 'source database bytes unchanged');
  const p = resolveE3RealPaths(f.target, { projectRoot: f.projectRoot, mustExist: true });
  assert.deepEqual(readdirSync(p.userDataDir), []);
  assert.equal(readFileSync(path.join(p.dataDir, 'asr-results/result.json'), 'utf8'), readFileSync(path.join(f.p.dataDir, 'asr-results/result.json'), 'utf8'));
  assert.equal(digest(path.join(p.assetsDir, 'synthetic-original.bin')), digest(path.join(f.p.assetsDir, 'synthetic-original.bin')));
  const db = new Database(path.join(p.dataDir, 'workbench.sqlite'), { readonly: true, nativeBinding: binding });
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.equal((db.prepare('SELECT scope_json FROM digest_requests WHERE id=?').get(f.requestId) as any).scope_json, f.frozenScope);
    assert.equal((db.prepare('SELECT state FROM digest_requests WHERE id=?').get(f.requestId) as any).state, 'cancelled');
    assert.equal((db.prepare('SELECT state FROM generation_requests').get() as any).state, 'cancelled');
    assert.equal((db.prepare('SELECT state FROM asr_media_jobs').get() as any).state, 'cancelled');
    assert.equal((db.prepare('SELECT status FROM asr_calls').get() as any).status, 'result-unknown');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key='autoSync'").get() as any).value, 'false');
    assert.equal((db.prepare('SELECT revision FROM asr_corrections').get() as any).revision, 2);
    assert.equal((db.prepare('SELECT id FROM asr_results').get() as any).id, 'retained-result');
    const prepared = JSON.parse((db.prepare('SELECT prepared_json FROM asr_chunks').get() as any).prepared_json);
    assert.equal(prepared.localPath, path.join(p.dataDir, 'asr-prepared/fragment.wav'));
    assert.equal((db.prepare('SELECT cache_key FROM asr_chunks').get() as any).cache_key, 'stable-cache-key');
    assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0);
  } finally { db.close(); }
  await assert.rejects(cloneEditorE3Real({ source: f.source, target: f.target, projectRoot: f.projectRoot, nativeBinding: binding }), /全新/);
  assert.equal(digest(path.join(f.p.dataDir, 'workbench.sqlite')), before);
});

test('clone rejects a fake schema4 source before creating a target and rejects linked originals without publishing a launch marker', async () => {
  const bad = fixture('bad-schema');
  const db = new Database(path.join(bad.p.dataDir, 'workbench.sqlite'), { nativeBinding: binding }); db.pragma('user_version=4'); db.close();
  await assert.rejects(cloneEditorE3Real({ source: bad.source, target: bad.target, projectRoot: bad.projectRoot, nativeBinding: binding }), /schema10/);
  assert.equal(existsSync(bad.target), false);
  const linked = fixture('linked-resource');
  symlinkSync(path.join(linked.p.assetsDir, 'synthetic-original.bin'), path.join(linked.p.dataDir, 'media/linked-original.bin'));
  await assert.rejects(cloneEditorE3Real({ source: linked.source, target: linked.target, projectRoot: linked.projectRoot, nativeBinding: binding }), /links/);
  assert.equal(existsSync(path.join(linked.target, 'e3-real-isolated.json')), false, 'failed copy cannot be launched as prepared');
});

test('real→new-real clone preserves exhausted paid-stage failures and successful upstream bytes without reauthorizing or relabeling the source namespace', async () => {
  const f = fixture('real-continuation');
  await cloneEditorE3Real({ source: f.source, target: f.target, projectRoot: f.projectRoot, nativeBinding: binding });
  const source = resolveE3RealPaths(f.target, { mustExist: true, projectRoot: f.projectRoot }), dbFile = path.join(source.dataDir, 'workbench.sqlite');
  const db = new Database(dbFile, { nativeBinding: binding });
  let savedCalls: unknown[], savedTasks: unknown[];
  try {
    db.prepare("UPDATE digest_requests SET state='failed' WHERE id=?").run(f.requestId);
    db.prepare("UPDATE generation_requests SET state='failed' WHERE request_id=?").run(f.requestId);
    const raw = '{"fixture":"synthetic successful upstream, no real model"}';
    mkdirSync(path.join(source.dataDir, 'generation-results/stages'), { recursive: true });
    writeFileSync(path.join(source.dataDir, 'generation-results/stages/upstream.json'), raw);
    db.prepare("INSERT INTO generation_tasks(id,request_id,stage,chunk_id,chunk_order,state,attempts,input_sha,result_json,result_path,result_sha) VALUES(?,?,'organize','one',0,'succeeded',2,?,?,?,?)").run('success-upstream', f.requestId, 'd'.repeat(64), raw, 'stages/upstream.json', digest(path.join(source.dataDir, 'generation-results/stages/upstream.json')));
    db.prepare("INSERT INTO generation_tasks(id,request_id,stage,chunk_id,chunk_order,state,attempts,input_sha,error_json) VALUES(?,?,'map','one',0,'failed',2,?,?)").run('exhausted-map', f.requestId, 'e'.repeat(64), '{"code":"invalid-output"}');
    for (let i = 0; i < 4; i++) db.prepare("INSERT INTO generation_calls(run_id,task_id,request_id,generation,scope_revision,stage,config_json,input_sha,submitted,status,started_at,finished_at) VALUES(?,?,?,1,'fixed-scope',?,'{}',?,1,?,?,?)").run(`paid-${i}`, i < 2 ? 'success-upstream' : 'exhausted-map', f.requestId, i < 2 ? 'organize' : 'map', 'f'.repeat(64), i === 1 ? 'succeeded' : 'invalid-output', i + 1, i + 2);
    savedCalls = db.prepare('SELECT * FROM generation_calls ORDER BY rowid').all(); savedTasks = db.prepare('SELECT * FROM generation_tasks ORDER BY rowid').all();
  } finally { db.close(); }
  const before = digest(dbFile), next = path.join(f.projectRoot, '.acceptance-data/editor-e3-real/next');
  await cloneEditorE3Real({ source: source.root, target: next, projectRoot: f.projectRoot, nativeBinding: binding });
  assert.equal(digest(dbFile), before);
  const continued = resolveE3RealPaths(next, { mustExist: true, projectRoot: f.projectRoot });
  const copy = new Database(path.join(continued.dataDir, 'workbench.sqlite'), { readonly: true, nativeBinding: binding });
  try {
    assert.deepEqual(copy.prepare('SELECT * FROM generation_calls ORDER BY rowid').all(), savedCalls!);
    assert.deepEqual(copy.prepare('SELECT * FROM generation_tasks ORDER BY rowid').all(), savedTasks!);
    assert.equal((copy.prepare('SELECT state FROM generation_requests WHERE request_id=?').get(f.requestId) as any).state, 'failed');
    assert.equal((copy.prepare('SELECT state FROM digest_requests WHERE id=?').get(f.requestId) as any).state, 'failed');
    assert.equal(readFileSync(path.join(continued.dataDir, 'generation-results/stages/upstream.json'), 'utf8'), readFileSync(path.join(source.dataDir, 'generation-results/stages/upstream.json'), 'utf8'));
  } finally { copy.close(); }
  const marker = JSON.parse(readFileSync(path.join(continued.root, 'e3-real-isolated.json'), 'utf8'));
  assert.equal(marker.source.kind, 'readonly-e3-real-to-real-snapshot'); assert.equal(marker.source.root, source.root);
  writeFileSync(path.join(source.root, 'e3-real-isolated.json'), JSON.stringify({ ...marker, root: source.root, kind: 'read-later-workbench-editor-e3-fix' }));
  const refused = path.join(f.projectRoot, '.acceptance-data/editor-e3-real/refused');
  await assert.rejects(cloneEditorE3Real({ source: source.root, target: refused, projectRoot: f.projectRoot, nativeBinding: binding }), /标记/);
  assert.equal(existsSync(refused), false);
});
