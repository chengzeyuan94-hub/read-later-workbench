import assert from 'node:assert/strict';
import test from 'node:test';
import { externalTextPreview, excerptTitle, highlightPieces, revealNode, sourceRangeReference, sourceSubtitleVersions, treeOrder, visibleTree } from '../src/renderer/editor-workspace-helpers.js';
import { clone, plainText, type MindMapDocument, type SourceReference, type TranscriptSegment } from '../src/editor-core/model.js';
import { bundle, repository, request, seed, setup } from './e1-helpers.js';
const node = (id: string, parentId: string | null, children: string[]) => ({ id, parentId, children, title: [{ text: id }], notes: '', sourceRefs: [] });
const map: MindMapDocument = { documentId: 'm', workspaceId: 'w', revision: 1, schemaVersion: 1, sheetId: 's', rootId: 'a', theme: { id: 'light', name: '浅色' }, nodes: { a: node('a', null, ['b', 'd']), b: node('b', 'a', ['c']), c: node('c', 'b', []), d: node('d', 'a', []) } };
test('collapsed view retains the complete underlying tree and reveals only the required path', () => {
  const original = structuredClone(map), collapsed = new Set(['a', 'b', 'd']); const view = visibleTree(map, collapsed);
  assert.deepEqual(Object.keys(view.nodes), ['a']); assert.deepEqual(map, original);
  const revealed = revealNode(map, collapsed, 'c'); assert.deepEqual([...revealed], ['d']); assert.deepEqual(treeOrder(map, revealed).map(n => n.id), ['a', 'b', 'c', 'd']); assert.deepEqual([...collapsed], ['a', 'b', 'd']);
});
test('references and highlights retain exact Unicode code-point selection including emoji', () => {
  const text = '前🧠中👩‍💻后'; const ref = sourceRangeReference({ kind: 'capturedSource', sourceId: 's', sourceRevisionId: 'r', blockId: 'b' }, text, 1, 5);
  assert.equal(ref.range?.excerpt, '🧠中👩‍'); assert.deepEqual(highlightPieces(text, ref.range), { before: '前', selected: '🧠中👩‍', after: '💻后' }); assert.throws(() => sourceRangeReference({ kind: 'capturedSource', sourceId: 's', sourceRevisionId: 'r', blockId: 'b' }, text, 1, 99));
});
test('external canvas text has a visible bounded interpretation and never parses object identities', () => {
  assert.deepEqual(externalTextPreview('  第一行\r\n\n 第二行 '), { lines: ['第一行', '第二行'] }); assert.deepEqual(externalTextPreview('{"nodeId":"forged"}').lines, ['{"nodeId":"forged"}']); assert.ok(externalTextPreview(Array(102).fill('x').join('\n')).error); assert.ok(externalTextPreview('字'.repeat(10001)).error); assert.equal(excerptTitle('🧠'.repeat(4), 2)[0].text, '🧠🧠…');
});
test('subtitle display chooses only an exact current full-text version and never treats hash order as chronology', () => {
  const segment = (id: string, text: string, workspaceId = 'w'): TranscriptSegment => ({ workspaceId, transcriptId: id, revision: 1, segmentId: `${id}-text`, runs: [{ text }] });
  const old = segment('z-older-hash', '旧字幕'), current = segment('a-newer-hash', '新字幕'), foreign = segment('another-workspace', '新字幕', 'foreign');
  const input = [old, foreign, current], before = structuredClone(input);
  for (const list of [input, [...input].reverse()]) {
    const display = sourceSubtitleVersions(list, 'w', '新字幕');
    assert.equal(display.current?.key, 'a-newer-hash@1');
    assert.deepEqual(display.versions.map(version => version.key), ['a-newer-hash@1', 'z-older-hash@1']);
    assert.equal(display.current?.segments.length, 1);
    assert.equal(plainText(display.current!.segments[0].runs), '新字幕');
  }
  assert.deepEqual(input, before);
  assert.equal(sourceSubtitleVersions(input, 'w', '').current, null);
  assert.equal(sourceSubtitleVersions(input, 'w', '新字幕\n').current, null, 'no trimming or fuzzy replacement');
  assert.equal(sourceSubtitleVersions([current, segment('duplicate-text', '新字幕')], 'w', '新字幕').current, null, 'ambiguous identity is not silently selected');
  assert.equal(sourceSubtitleVersions([current, { ...current, segmentId: 'another-segment', runs: [{ text: '' }] }], 'w', '新字幕').current, null, 'no invented multi-segment order');
});
test('old-to-new captured subtitles default to the new version while a saved old reference remains exact and untimed', () => {
  const f = setup(); try {
    const contentId = seed(f.store), repo = repository(f.store), oldText = '前🧠旧摘录后', newText = '全新字幕，不含原来的摘录';
    f.store.db.prepare('UPDATE contents SET subtitle=? WHERE id=?').run(oldText, contentId);
    const initial = bundle(repo, contentId), old = initial.transcripts[0];
    const oldReference: SourceReference = { kind: 'transcript', transcriptId: old.transcriptId, revision: old.revision, segmentId: old.segmentId, range: { unit: 'unicode-code-point', start: 1, end: 5, excerpt: '🧠旧摘录', before: '前', after: '后' } };
    const savedMap = clone(initial.map); savedMap.nodes[savedMap.rootId].sourceRefs = [oldReference];
    assert.equal(repo.save([request(savedMap, 'save-old-subtitle-reference')])[0].status, 'saved');
    f.store.db.prepare('UPDATE contents SET subtitle=? WHERE id=?').run(newText, contentId); repo.captureSource(contentId);
    const loaded = repo.load(initial.workspace.id), display = sourceSubtitleVersions(loaded.bundle.transcripts, initial.workspace.id, newText);
    assert.notEqual(loaded.sourceRevisionId, initial.sources[0].sourceRevisionId);
    assert.equal(loaded.bundle.transcripts.length, 2);
    assert.equal(plainText(display.current!.segments[0].runs), newText);
    assert.equal(display.current!.segments.some(segment => plainText(segment.runs) === oldText), false);
    assert.ok(display.versions.some(version => version.key === `${old.transcriptId}@${old.revision}` && plainText(version.segments[0].runs) === oldText));
    assert.deepEqual(loaded.bundle.map.nodes[savedMap.rootId].sourceRefs, [oldReference]);
    assert.deepEqual(loaded.bundle.draft, initial.draft, 'subtitle refresh never fills the blank user draft');
    const resolved = repo.resolve(initial.workspace.id, loaded.bundle.map.nodes[savedMap.rootId].sourceRefs[0]);
    assert.equal(resolved.text, oldText); assert.equal(resolved.selectedText, '🧠旧摘录');
    assert.equal(resolved.transcript?.timing.state, 'unknown');
    assert.deepEqual(highlightPieces(resolved.text, oldReference.range), { before: '前', selected: '🧠旧摘录', after: '后' });
  } finally { f.close(); }
});
