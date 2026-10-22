import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { clone } from '../src/editor-core/model.js';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { migrateAsrSchema } from '../src/main/asr-store.js';
import { exportEditorXmind, inspectEditorXmindBytes } from '../src/main/editor-xmind.js';
import { png, seed, request } from './e1-helpers.js';

// New E3 fixture root only. These hand-built workspaces prove export mechanics, not generated product quality.
function fixture(withImage = false) {
  const base = path.resolve('.acceptance-data/editor-e3'); mkdirSync(base, { recursive: true, mode: 0o700 }); const root = mkdtempSync(path.join(base, 'xmind-unit-')), store = new Store(root);
  const id = seed(store); migrateEditorSchema(store.db, root, { targetVersion: 7 }); migrateAsrSchema(store.db, root);
  const repo = new EditorRepository(store.db, root), opened = repo.open(id, 'blank'); if (!opened.initialized) throw new Error('fixture workspace');
  const b = opened.bundle, map = clone(b.map), source = b.sources[0]; source.originalUrl = 'https://www.xiaohongshu.com/explore/test?xsec_token=PRIVATE_URL_SECRET#private'; store.db.prepare('UPDATE editor_sources SET json=? WHERE source_id=? AND revision_id=?').run(JSON.stringify(source), source.sourceId, source.sourceRevisionId);
  const ref = { kind: 'capturedSource' as const, sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, blockId: source.blocks[0].id, range: { start: 0, end: 3, unit: 'unicode-code-point' as const, excerpt: '原文🙂' } };
  map.nodes[map.rootId].title = [{ text: '真实编辑模型 🧠 中文' }]; map.nodes[map.rootId].notes = '根节点备注'; map.nodes[map.rootId].children = ['second', 'first']; map.nodes[map.rootId].style = { bold: true, italic: true, fill: '#ffaa00', textColor: '#112233' };
  map.nodes.second = { id: 'second', parentId: map.rootId, children: [], title: [{ text: '先显示🙂' }], notes: '中文备注\n第二行', sourceRefs: [ref] };
  map.nodes.first = { id: 'first', parentId: map.rootId, children: [], title: [{ text: '后显示' }], notes: '', sourceRefs: [] };
  let image: ReturnType<EditorRepository['selectImage']> | undefined;
  if (withImage) { store.detailSaved(id, { body: '当前图文正文', bodyComplete: true, mediaManifestComplete: true, media: [{ kind: 'image', remoteUrl: 'https://example.invalid/synthetic.png', mime: 'image/png', role: 'gallery' }] }); const media = store.content(id)!.media[0], name = 'fixture-original.png'; writeFileSync(path.join(root, 'media', name), png); store.downloadSaved(media.id, name, png.length, 'image/png'); image = repo.selectImage(b.workspace.id, media.id); map.nodes.second.image = { assetId: image.id, version: image.version }; }
  assert.equal(repo.save([request(map, 'map-fixture')])[0].status, 'saved'); const bundle = repo.load(b.workspace.id).bundle, expected = { draftRevision: bundle.draft.revision, mapRevision: bundle.map.revision }, exports = path.join(root, 'exports'); mkdirSync(exports);
  return { root, store, repo, bundle, expected, exports, image, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('product XMind exports the actual saved editable tree, order, emoji, notes/styles and exact readable source without signed URL credentials', async () => {
  const f = fixture(); try {
    const before = JSON.stringify(f.repo.load(f.bundle.workspace.id)); const result = await exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, path.join(f.exports, '中文🧠.xmind'));
    assert.equal(result.status, 'exported'); assert.equal(result.mapRevision, f.expected.mapRevision); assert.equal(result.draftRevision, f.expected.draftRevision);
    const bytes = readFileSync(result.path!), inspected = inspectEditorXmindBytes(bytes), files = unzipSync(bytes), sheets = JSON.parse(strFromU8(files['content.json'])), root = sheets[0].rootTopic;
    assert.equal(inspected.topics, 3); assert.equal(root.title, '真实编辑模型 🧠 中文'); assert.deepEqual(root.children.attached.map((node: any) => node.id), ['second', 'first']); assert.equal(root.style.properties['svg:fill'], '#ffaa00'); assert.equal(root.style.properties['fo:font-weight'], 'bold'); assert.equal(root.style.properties['fo:font-style'], 'italic');
    const child = root.children.attached[0]; assert.match(child.notes.plain.content, /中文备注\n第二行/); assert.match(child.notes.plain.content, /原文🙂/); assert.match(child.notes.plain.content, /unicode-code-point.*0–3/); assert.equal(child.href, 'https://www.xiaohongshu.com/explore/test');
    const allText = Object.values(files).map(bytes => strFromU8(bytes)).join('\n'); assert.doesNotMatch(allText, /PRIVATE_URL_SECRET|xsec_token|rlw-media:|file:\/\//); assert.equal(JSON.stringify(f.repo.load(f.bundle.workspace.id)), before);
    assert.ok(!readdirSync(f.exports).some(name => name.endsWith('.part')));
  } finally { f.close(); }
});

test('product XMind embeds only saved node PNG bytes under relative content-addressed resources and survives moving the file', async () => {
  const f = fixture(true); try {
    const result = await exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, path.join(f.exports, '含图.xmind')), bytes = readFileSync(result.path!), inspected = inspectEditorXmindBytes(bytes), files = unzipSync(bytes);
    assert.equal(inspected.resources.length, 1); assert.equal(inspected.resources[0].sha256, f.image!.sha256); assert.ok(Buffer.from(files[inspected.resources[0].path]).equals(png));
    const moved = path.join(f.root, 'moved.xmind'); writeFileSync(moved, bytes); assert.deepEqual(inspectEditorXmindBytes(readFileSync(moved)), inspected);
    const binding = JSON.parse(strFromU8(files['rlw-export.json'])); assert.equal(binding.mapRevision, f.expected.mapRevision); assert.equal(binding.nodeCount, 3);
  } finally { f.close(); }
});

test('product XMind saved-version barriers, reference failures and publication faults preserve existing files and clean temporary files', async () => {
  const f = fixture(); try {
    const target = path.join(f.exports, 'same.xmind'); writeFileSync(target, 'USER ORIGINAL');
    await assert.rejects(exportEditorXmind(f.repo, f.bundle.workspace.id, { ...f.expected, mapRevision: 1 }, target), /版本/);
    for (const failAt of ['after-write', 'before-publish'] as const) await assert.rejects(exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, target, { failAt }), /injected/);
    assert.equal(readFileSync(target, 'utf8'), 'USER ORIGINAL'); assert.deepEqual(readdirSync(f.exports), ['same.xmind']);
    const second = await exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, target), third = await exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, target); assert.equal(path.basename(second.path!), 'same (2).xmind'); assert.equal(path.basename(third.path!), 'same (3).xmind'); assert.equal(readFileSync(target, 'utf8'), 'USER ORIGINAL');
    f.store.db.prepare('DELETE FROM editor_sources WHERE source_id=? AND revision_id=?').run(f.bundle.sources[0].sourceId, f.bundle.sources[0].sourceRevisionId);
    await assert.rejects(exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, path.join(f.exports, 'bad-reference.xmind')), /来源版本不存在/); assert.ok(!readdirSync(f.exports).some(name => /bad-reference|\.part$/.test(name)));
  } finally { f.close(); }
});

test('product XMind rejects damaged originals and forged WebP metadata without publishing a replacement', async () => {
  const f = fixture(true); try {
    const target = path.join(f.exports, 'failure.xmind'), original = readFileSync(path.join(f.repo.assetsDir, f.image!.relativePath));
    writeFileSync(path.join(f.repo.assetsDir, f.image!.relativePath), 'changed'); await assert.rejects(exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, target), /摘要/); assert.deepEqual(readdirSync(f.exports), []);
    writeFileSync(path.join(f.repo.assetsDir, f.image!.relativePath), original); const metadata = { ...f.image!, mime: 'image/webp' }; f.store.db.prepare('UPDATE editor_assets SET json=? WHERE id=? AND version=?').run(JSON.stringify(metadata), metadata.id, metadata.version);
    await assert.rejects(exportEditorXmind(f.repo, f.bundle.workspace.id, f.expected, target), /类型/); assert.deepEqual(readdirSync(f.exports), []);
  } finally { f.close(); }
});
