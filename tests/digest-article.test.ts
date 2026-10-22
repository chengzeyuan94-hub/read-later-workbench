import assert from 'node:assert/strict';
import test from 'node:test';
import { digestArticleVersions, digestImageAttachment, digestReferenceText, digestSafeLink, safeArtifactPath, type ReadyDigestArtifact } from '../src/renderer/digest-article-helpers.js';
import type { WorkspaceBundle } from '../src/editor-core/model.js';
const hash = 'a'.repeat(64), other = 'b'.repeat(64);
function fixture(): ReadyDigestArtifact {
  const bundle: WorkspaceBundle = {
    workspace: { id: 'w', collectionId: 'c', userTitle: '固定生成稿', draftDocumentId: 'd', mindMapDocumentId: 'm', draftRevision: 4, mapRevision: 7 },
    draft: { documentId: 'd', workspaceId: 'w', schemaVersion: 1, revision: 4, blocks: [{ id: 'body', type: 'paragraph', runs: [{ text: '新稿🧠文字' }] }] },
    map: { documentId: 'm', workspaceId: 'w', schemaVersion: 1, revision: 7, sheetId: 's', rootId: 'n', theme: { id: 'light', name: '浅色' }, nodes: { n: { id: 'n', parentId: null, children: [], title: [{ text: '主题' }], notes: '', sourceRefs: [] } } },
    sources: [{ workspaceId: 'w', sourceId: 'source', sourceRevisionId: 'old-source', sha256: other, coverage: { complete: true, description: '已固定正文' }, originalUrl: 'https://example.com/note', blocks: [{ id: 'p', type: 'paragraph', runs: [{ text: '前🧠旧引用文字后' }] }] }],
    transcripts: [{ workspaceId: 'w', transcriptId: 't', revision: 1, segmentId: 'seg', runs: [{ text: '旧字幕只定位文字' }] }],
    assets: [{ id: 'picture', version: hash, sha256: hash, mime: 'image/png', relativePath: `w/${hash}.png` }],
  };
  return { state: 'ready', bundle, requestId: 'request', synthetic: true, scopeRevisionId: 'scope', draftRevision: 4, mapRevision: 7, candidate: true, inLibrary: true, markdownText: '# 固定稿\n', attachments: [{ relativePath: `assets/${hash}.png`, sha256: hash, mime: 'image/png' }] };
}
test('digest article image lookup needs matching owned identity, exact SHA version and a safe manifest path', () => {
  const artifact = fixture(), ref = { assetId: 'picture', version: hash }; assert.equal(digestImageAttachment(ref, artifact)?.relativePath, `assets/${hash}.png`);
  assert.equal(digestImageAttachment({ ...ref, version: other }, artifact), null); assert.equal(digestImageAttachment({ ...ref, assetId: 'another-picture' }, artifact), null);
  artifact.attachments[0].sha256 = other; assert.equal(digestImageAttachment(ref, artifact), null); artifact.attachments[0].sha256 = hash; artifact.attachments[0].relativePath = '../outside.png'; assert.equal(digestImageAttachment(ref, artifact), null);
  for (const filename of ['/tmp/a.png', 'https://example.com/a.png', 'assets/../a.png', 'assets\\a.png', 'assets/%2e%2e/a.png']) assert.equal(safeArtifactPath(filename), false); assert.equal(safeArtifactPath('assets/本地图片.png'), true);
});
test('digest preview accepts supported safe links and never exposes unsafe link protocols', () => {
  assert.equal(digestSafeLink('https://example.com/a'), 'https://example.com/a'); assert.equal(digestSafeLink('mailto:a@example.com'), 'mailto:a@example.com');
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,x', 'rlw-editor://local/w/a/v', '/Users/private', ' https://example.com']) assert.equal(digestSafeLink(url), null);
});
test('fixed artifact versions cannot silently display a different current draft or map revision', () => {
  const artifact = fixture(); assert.deepEqual(digestArticleVersions(artifact), { consistent: true, label: '固定成稿版本 · 整理稿 4 · 导图 7' });
  artifact.bundle.map.revision = 8; assert.equal(digestArticleVersions(artifact).consistent, false); artifact.bundle.map.revision = 7; artifact.bundle.workspace.draftRevision = 5; assert.equal(digestArticleVersions(artifact).consistent, false);
});
test('source highlights use exact snapshot/Unicode range; old user references do not fall back to current text', () => {
  const { bundle } = fixture(), ref = { kind: 'capturedSource' as const, sourceId: 'source', sourceRevisionId: 'old-source', blockId: 'p', range: { start: 1, end: 4, unit: 'unicode-code-point' as const, excerpt: '🧠旧引' } };
  const resolved = digestReferenceText(ref, bundle); assert.equal(resolved.exactInBundle, true); assert.equal(resolved.selectedText, '🧠旧引'); assert.equal(resolved.before, '前'); assert.equal(resolved.after, '用文字后');
  const absent = digestReferenceText({ kind: 'userDraft', documentId: 'd', revision: 3, blockId: 'body', range: { start: 0, end: 2, unit: 'unicode-code-point', excerpt: '旧稿' } }, bundle); assert.equal(absent.exactInBundle, false); assert.equal(absent.text, null); assert.equal(absent.selectedText, '旧稿');
  const subtitle = digestReferenceText({ kind: 'transcript', transcriptId: 't', revision: 1, segmentId: 'seg' }, bundle); assert.equal(subtitle.unknownTime, true); assert.equal(subtitle.text, '旧字幕只定位文字');
});
