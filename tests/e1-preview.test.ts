import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { clone } from '../src/editor-core/model.js';
import { savedPreview } from '../src/main/editor-preview.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG4cAAAAASUVORK5CYII=', 'base64');
function fixture() {
  const parent = path.resolve('.acceptance-data/editor-e1'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'preview-unit-'));
  const store = new Store(path.join(root, 'data'), { editorEnabled: true });
  store.db.prepare("INSERT INTO contents(id,platform,account_id,source_id,title,author,url,kind,first_discovered_at,discovery,source_body,body_complete,detail_state,manifest_complete) VALUES(1,'xiaohongshu','synthetic','one',?,'synthetic','https://www.xiaohongshu.com/explore/one','image',1,'historical','合成正文',1,'succeeded',1)").run('<script>合成安全标题 🧠</script>');
  store.db.prepare("INSERT INTO contents(id,platform,account_id,source_id,title,author,url,kind,first_discovered_at,discovery) VALUES(2,'bilibili','synthetic','two','第二份','synthetic','https://www.bilibili.com/video/two','text',1,'historical')").run();
  writeFileSync(path.join(store.mediaDir, 'one.png'), pixel);
  store.db.prepare("INSERT INTO media(id,content_id,kind,remote_url,mime,state,local_path,bytes,current,media_order) VALUES(1,1,'image','https://example.invalid/unavailable','image/png','succeeded','one.png',?,1,0)").run(pixel.length);
  const first = store.editor!.open(1, 'blank'), second = store.editor!.open(2, 'blank');
  assert.ok(first.initialized && second.initialized);
  return { store, repository: store.editor!, first: first.bundle, second: second.bundle };
}
test('preview freezes committed tree, escapes titles, scopes workspace/revision/config and excludes transient UI', () => {
  const { store, repository, first, second } = fixture();
  try {
    const pending = clone(first.map); pending.nodes[pending.rootId].title = [{ text: '未保存的标题' }];
    const preview = savedPreview(repository, first.workspace.id, 1);
    assert.equal(preview.state, 'ready');
    assert.ok(preview.svg!.includes('&lt;script&gt;'));
    assert.ok(!/<script|未保存的标题|contenteditable|data-selected|drag-preview|<button/i.test(preview.svg!));
    assert.ok(!savedPreview(repository, second.workspace.id, 1).svg!.includes('合成安全标题'));
    assert.throws(() => savedPreview(repository, first.workspace.id, 2), /版本/);
    assert.throws(() => savedPreview(repository, first.workspace.id, 1, 'unknown-config'), /配置/);
    const request = { workspaceId: first.workspace.id, documentId: pending.documentId, sessionId: 'unit', requestId: 'unit-1', expectedRevision: 1, document: pending };
    assert.equal(repository.save([request])[0].status, 'saved');
    assert.equal(repository.putPreview(preview), false, 'late old revision cannot replace current preview');
    assert.ok(savedPreview(repository, first.workspace.id, 2).svg!.includes('未保存的标题'));
  } finally { store.close(); }
});
test('cached preview reports missing fixed images without reverting saved content and retries after exact restoration', () => {
  const { store, repository, first } = fixture();
  try {
    const asset = repository.selectImage(first.workspace.id, 1), map = clone(first.map);
    map.nodes[map.rootId].image = { assetId: asset.id, version: asset.version };
    assert.equal(repository.save([{ workspaceId: first.workspace.id, documentId: map.documentId, sessionId: 'image-unit', requestId: 'image-1', expectedRevision: 1, document: map }])[0].status, 'saved');
    const preview = savedPreview(repository, first.workspace.id, 2);
    assert.equal(preview.state, 'ready'); assert.match(preview.svg!, /<image href="rlw-editor:\/\/local\//);
    assert.ok(!preview.svg!.includes('base64'), 'preview references bounded local resources, not per-node image bytes');
    const file = path.join(repository.assetsDir, asset.relativePath), bytes = readFileSync(file); unlinkSync(file);
    assert.equal(savedPreview(repository, first.workspace.id, 2).state, 'failed');
    assert.equal(repository.load(first.workspace.id).bundle.map.revision, 2);
    writeFileSync(file, bytes);
    assert.equal(savedPreview(repository, first.workspace.id, 2).state, 'ready');
  } finally { store.close(); }
});
