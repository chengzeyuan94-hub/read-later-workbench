import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clone, plainText, type SourceReference } from '../src/editor-core/model.js';
import { exportMarkdown } from '../src/main/editor-export.js';
import { sha256 } from '../src/main/editor-media.js';
import { fixture } from './generation-fix-fixture.js';
import { png, request } from './e1-helpers.js';

function prepared(bodyImage: boolean) {
 const f = fixture();
 f.store.detailSaved(f.id, { body: '原始逐字资料甲：保留25mg限定。\n原始逐字资料乙：仅在30天内成立。', bodyComplete: true, mediaManifestComplete: true, media: [
  { kind: 'image', remoteUrl: 'https://example.invalid/image-a', mime: 'image/png' },
  { kind: 'image', remoteUrl: 'https://example.invalid/image-b', mime: 'image/png' },
 ] });
 for (const media of f.store.content(f.id)!.media) {
  const file = `readability-${media.id}.png`; writeFileSync(path.join(f.root, 'media', file), png);
  f.store.downloadSaved(media.id, file, png.length, 'image/png');
 }
 const opened = f.editor.open(f.id, 'source'); assert.equal(opened.initialized, true);
 if (!opened.initialized) throw Error('synthetic workspace missing');
 const workspaceId = opened.bundle.workspace.id;
 const images = f.store.content(f.id)!.media.map(media => f.editor.selectImage(workspaceId, media.id));
 assert.notEqual(images[0].id, images[1].id); assert.equal(images[0].sha256, images[1].sha256);
 const bundle = f.editor.load(workspaceId).bundle, draft = clone(bundle.draft), source = bundle.sources[0];
 draft.blocks = [
  { id: 'internal-body-alpha', type: 'paragraph', runs: [{ text: '清洗正文第一段，保留有效条件。' }] },
  { id: 'internal-body-beta', type: 'paragraph', runs: [{ text: '清洗正文第二段，来源可展开核对。' }] },
  ...(bodyImage ? [{ id: 'body-image', type: 'image' as const, runs: [], assetRefs: [{ assetId: images[0].id, version: images[0].version }] }] : []),
 ];
 assert.equal(f.editor.save([request(draft)])[0].status, 'saved');
 const saved = f.editor.load(workspaceId).bundle;
 const refs: Record<string, SourceReference[]> = Object.fromEntries(['internal-body-alpha', 'internal-body-beta'].map((blockId, index) => {
  const block = source.blocks[index], text = plainText(block.runs);
  return [blockId, [{ kind: 'capturedSource', sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, blockId: block.id, range: { start: 0, end: Array.from(text).length, unit: 'unicode-code-point', excerpt: text }, assets: [{ assetId: images[index].id, version: images[index].version }] }]];
 }));
 const rawRefs = JSON.stringify(refs);
 f.store.db.prepare('INSERT INTO generation_body_refs VALUES(?,?,?,?)').run(workspaceId, saved.draft.revision, sha256(JSON.stringify(saved.draft)), rawRefs);
 return { ...f, workspaceId, saved, source, images, rawRefs };
}

for (const bodyImage of [false, true]) test(`draft Markdown folds exact provenance and renders a shared source image once (${bodyImage ? 'already in body' : 'citation only'})`, () => {
 const f = prepared(bodyImage);
 try {
  const expected = { draftRevision: f.saved.draft.revision, mapRevision: f.saved.map.revision }, before = JSON.stringify(f.editor.load(f.workspaceId).bundle), out = path.join(f.root, 'readability-export'); mkdirSync(out);
  const result = exportMarkdown(f.editor, f.workspaceId, 'draft', expected, path.join(out, 'article.md'));
  assert.equal(result.status, 'exported'); assert.equal(result.files, 2);
  const markdown = readFileSync(path.join(result.path!, 'article.md'), 'utf8');
  const detail = /<details>\n<summary>正文出处（精确版本、区域与摘录）<\/summary>\n\n([\s\S]*?)\n<\/details>/.exec(markdown);
  assert.ok(detail, 'provenance must be a normally closed details block, separated for Markdown rendering');
  assert.doesNotMatch(markdown, /<details\s+open/);
  const visible = markdown.replace(/<details>[\s\S]*?<\/details>/g, '');
  assert.match(visible, /清洗正文第一段/); assert.match(visible, /清洗正文第二段/); assert.match(visible, /\[原收藏\]\(https:\/\/www\.xiaohongshu\.com\/explore\/fixture\)/);
  assert.doesNotMatch(visible, /internal-body-alpha|internal-body-beta|原始逐字资料甲|原始逐字资料乙|选区\(unicode-code-point\)/);
  for (const identity of ['internal-body-alpha', 'internal-body-beta', f.source.sourceId, f.source.sourceRevisionId, f.source.blocks[0].id, f.source.blocks[1].id]) assert.ok(detail[1].includes(identity));
  assert.ok(detail[1].includes(`正文版本 ${f.saved.draft.revision}`)); assert.match(detail[1], /选区\(unicode-code-point\)/); assert.match(detail[1], /原始逐字资料甲/); assert.match(detail[1], /原始逐字资料乙/);
  assert.doesNotMatch(markdown, /导图大纲|rlw-editor:|rlw-media:|file:\/\//);
  assert.equal([...markdown.matchAll(/!\[[^\]]*\]\(assets\//g)].length, 1, 'one visual image for identical bytes across distinct source assets');
  assert.match(markdown, bodyImage ? /来源图片已在正文展示/ : /同一来源图片，见前一出处/);
  assert.equal(readdirSync(path.join(result.path!, 'assets')).length, 1);
  const moved = path.join(f.root, 'moved-article'); renameSync(result.path!, moved);
  for (const match of markdown.matchAll(/\]\((assets\/[^)]+)\)/g)) assert.equal(sha256(readFileSync(path.join(moved, match[1]))), f.images[0].sha256);
  assert.equal(JSON.stringify(f.editor.load(f.workspaceId).bundle), before, 'export must not mutate saved model or references');
  assert.equal((f.store.db.prepare('SELECT json FROM generation_body_refs WHERE workspace_id=?').get(f.workspaceId) as { json: string }).json, f.rawRefs);
  writeFileSync(path.join(f.editor.assetsDir, f.images[0].relativePath), 'synthetic corrupted fixed image');
  assert.throws(() => exportMarkdown(f.editor, f.workspaceId, 'draft', expected, path.join(out, 'bad.md')), /摘要/);
  assert.equal(existsSync(path.join(out, 'bad.md')), false, 'folded provenance must not bypass source-image validation');
 } finally { f.close(); }
});
