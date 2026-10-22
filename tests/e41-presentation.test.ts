import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorState } from 'prosemirror-state';
import { clone, listItemDisplayRuns, plainText, redundantListPrefixLength, serializeDraftMarkdown, type DraftBlock, type MindMapDocument } from '../src/editor-core/model.js';
import { toPM } from '../src/editor-core/prosemirror.js';
import { layoutTree } from '../src/editor-core/canvas.js';
import { DraftReading } from '../src/renderer/draft-reading.js';
import { listPresentationPlugin, nodePresentationWidth, redundantListMarkerDecorations } from '../src/renderer/editor-presentation.js';
import { ExportMediaSummary, ExportProgress, exportBytes } from '../src/renderer/export-dialog-content.js';

const paragraph = (id: string, text: string): DraftBlock => ({ id, type: 'paragraph', runs: [{ text }] });
const item = (id: string, text: string): DraftBlock => ({ id, type: 'listItem', runs: [], children: [paragraph(id + '-p', text)] });

test('list formatting removes only redundant matching markers and preserves all original runs/marks/IDs', () => {
  const runs = [{ text: '3. ', bold: true }, { text: '中文重点', italic: true, href: 'https://example.com' }];
  const original = clone(runs), shown = listItemDisplayRuns(runs, 'orderedList', 3);
  assert.equal(plainText(shown), '中文重点');
  assert.deepEqual(shown, [{ text: '中文重点', italic: true, href: 'https://example.com' }]);
  assert.deepEqual(runs, original);
  for (const text of ['3.5 毫米', '3岁起', '30. 数量', '4. 第四项', '3.']) assert.equal(redundantListPrefixLength([{ text }], 'orderedList', 3), 0, text);
  for (const runs of [[{ text: '3. literal', code: true }], [{ text: '3. link', href: 'https://example.com' }]]) assert.equal(redundantListPrefixLength(runs, 'orderedList', 3), 0);
  assert.equal(plainText(listItemDisplayRuns([{ text: '3、中文说明' }], 'orderedList', 3)), '中文说明');
  assert.equal(plainText(listItemDisplayRuns([{ text: '- 正文', bold: true }], 'bulletList')), '正文');
  assert.equal(redundantListPrefixLength([{ text: '-2℃' }], 'bulletList'), 0);
});

test('reading and Markdown contain one same-kind marker, nested lists and continuation text remain intact', () => {
  const blocks: DraftBlock[] = [{ id: 'ordered', type: 'orderedList', start: 3, runs: [], children: [
    { ...item('a', '3. 中文重点'), children: [paragraph('a-p', '3. 中文重点'), paragraph('continuation', '3. 这是原样保留的后续段落'), { id: 'nested', type: 'bulletList', runs: [], children: [item('n', '- 附加条件')] }] },
    item('b', '4.5 毫米'), item('c', '7. 不同序号保持原文'),
  ] }, paragraph('outside', '1. 非列表不修改')];
  const before = JSON.stringify(blocks), markdown = serializeDraftMarkdown(blocks), html = renderToStaticMarkup(React.createElement(DraftReading, { blocks, assetUrl: () => '' }));
  assert.match(markdown, /^3\. 中文重点/m); assert.doesNotMatch(markdown, /^3\. 3/m);
  assert.match(markdown, /3\\\. 这是原样保留的后续段落/); assert.match(markdown, /- 附加条件/);
  assert.match(markdown, /4\. 4\\\.5 毫米/); assert.match(markdown, /5\. 7\\\. 不同序号保持原文/);
  assert.match(markdown, /1\\\. 非列表不修改/);
  assert.match(html, /<ol start="3"><li><p>中文重点<\/p>/); assert.match(html, /<p>3\. 这是原样保留的后续段落<\/p>/);
  assert.match(html, /<ul><li><p>附加条件<\/p><\/li><\/ul>/);
  assert.equal(JSON.stringify(blocks), before);
});

test('editable list decorations change visual markers only, track typing and keep canonical document identical', () => {
  const blocks: DraftBlock[] = [{ id: 'list', type: 'orderedList', start: 2, runs: [], children: [item('a', '2. 人工原文'), item('b', '7. 不同编号'), item('c', '4.5 单位')] }];
  const doc = toPM(blocks), before = JSON.stringify(doc.toJSON());
  let state = EditorState.create({ doc, plugins: [listPresentationPlugin()] });
  const decorations = redundantListMarkerDecorations(state.doc).find();
  assert.equal(decorations.length, 1);
  assert.equal(state.doc.nodeAt(decorations[0].from)?.attrs.id, 'a');
  assert.equal(state.doc.nodeAt(decorations[0].from)?.type.name, 'listItem');
  assert.equal(JSON.stringify(state.doc.toJSON()), before);
  state = state.apply(state.tr.insertText('自写', 3));
  assert.equal(redundantListMarkerDecorations(state.doc).find().length, 0);
  assert.match(state.doc.textContent, /自写2\. 人工原文/);
  assert.deepEqual(blocks[0].children?.map(i => i.id), ['a', 'b', 'c']);
});

test('long title layout uses measured bounded widths and keeps full text, tree identity and nonoverlap', () => {
  const title = '中文长标题😀与限定条件保留'.repeat(7), map: MindMapDocument = { documentId: 'map', workspaceId: 'workspace', schemaVersion: 1, revision: 2, sheetId: 'sheet', rootId: 'root', theme: { id: 'light', name: 'light' }, nodes: {
    root: { id: 'root', parentId: null, children: ['a', 'b'], title: [{ text: '主题' }], notes: '', sourceRefs: [] },
    a: { id: 'a', parentId: 'root', children: [], title: [{ text: title, bold: true }], notes: '', sourceRefs: [] },
    b: { id: 'b', parentId: 'root', children: [], title: [{ text: '第二分支\n保留换行' }], notes: '', sourceRefs: [] },
  } };
  const before = JSON.stringify(map), measured = new Map(Object.values(map.nodes).map(n => [n.id, { width: nodePresentationWidth(n.title), height: n.id === 'a' ? 180 : 72 }]));
  assert.equal(measured.get('a')?.width, 284); assert.equal(measured.get('b')?.width, 194);
  const layout = layoutTree(map, measured);
  assert.ok(layout.nodes.a.x > layout.nodes.root.x + layout.nodes.root.width);
  assert.ok(layout.nodes.b.y >= layout.nodes.a.y + layout.nodes.a.height);
  assert.equal(JSON.stringify(map), before); assert.equal(plainText(map.nodes.a.title), title);
});

test('media option defaults to unchecked, lists bytes and missing resources without claiming complete success', () => {
  const preview = { items: [{ mediaId: 1, kind: 'video' as const, label: '本收藏视频', bytes: 1572864, status: 'available' as const }, { mediaId: 2, kind: 'audio' as const, label: '缺失音频', bytes: 0, status: 'missing' as const, reason: '文件不可访问' }], totalBytes: 1572864, missingCount: 1 };
  const html = renderToStaticMarkup(React.createElement(ExportMediaSummary, { preview, include: false, disabled: false, onChange: () => {} }));
  assert.match(html, /包含本地音视频/); assert.doesNotMatch(html, /checked=""/); assert.match(html, /本收藏视频/); assert.match(html, /1\.5 MB/); assert.match(html, /缺失音频/); assert.match(html, /文件不可访问/);
  const checked = renderToStaticMarkup(React.createElement(ExportMediaSummary, { preview, include: true, disabled: false, onChange: () => {} }));
  assert.match(checked, /本次不能导出完整音视频包/); assert.match(checked, /相对链接/);
  const progress = renderToStaticMarkup(React.createElement(ExportProgress, { progress: { operationId: 'op', phase: 'copying', copiedBytes: 1048576, totalBytes: 2097152, currentFile: '真实文件.mp4' }, cancelling: false, onCancel: () => {} }));
  assert.match(progress, /value="1048576" max="2097152"/); assert.match(progress, /真实文件.mp4/); assert.match(progress, /取消导出/);
  assert.equal(exportBytes(0), '0 B'); assert.equal(exportBytes(1024 ** 3), '1.00 GB');
});
