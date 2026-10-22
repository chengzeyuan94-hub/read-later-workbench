import test from 'node:test';
import assert from 'node:assert/strict';
import type { MindMapDocument, MindMapNode } from '../src/editor-core/model.js';
import { buildKnowledgeCard, cardBarcode, cardDate, cardNumber, estimateLines, fitLine, nodeIndex, viewpointLayout } from '../src/renderer/knowledge-card.js';
import { validateKnowledgeCardPayload } from '../src/shared/knowledge-card.js';

const node = (id: string, parentId: string | null, children: string[], text = id): MindMapNode => ({ id, parentId, children, title: [{ text }], notes: '', sourceRefs: [] });
const map = (nodes: MindMapNode[], rootId = 'root'): MindMapDocument => ({
  documentId: 'm', workspaceId: 'w', revision: 1, schemaVersion: 1, sheetId: 's', rootId, theme: { id: 'light', name: '浅色' },
  nodes: Object.fromEntries(nodes.map(entry => [entry.id, entry])),
});
const content = { id: 317, platform: 'twitter', author: '作者甲', title: '收藏的原文标题' };
const now = Date.UTC(2026, 3, 25, 16);

test('root node carries no parent; child carries the parent label', () => {
  const doc = map([node('root', null, ['a', 'b'], '根观点'), node('a', 'root', ['a1'], '分支观点'), node('a1', 'a', [], '叶子'), node('b', 'root', [], '另一支')]);
  const rootCard = buildKnowledgeCard(doc, 'root', content, now);
  assert.equal(rootCard.parent, '');
  assert.equal(rootCard.viewpoint, '根观点');
  assert.deepEqual(rootCard.points, ['分支观点', '另一支']);
  const childCard = buildKnowledgeCard(doc, 'a', content, now);
  assert.equal(childCard.parent, '根观点');
  assert.deepEqual(childCard.points, ['叶子']);
});

test('direct children are capped at four with the honest total for 等 N 条', () => {
  const doc = map([node('root', null, [], '根'), node('a', 'root', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], '观点'), node('c1', 'a', [], '一'), node('c2', 'a', [], '二'), node('c3', 'a', [], '三'), node('c4', 'a', [], '四'), node('c5', 'a', [], '五'), node('c6', 'a', [], '六')], 'root');
  doc.nodes.root.children = ['a'];
  const card = buildKnowledgeCard(doc, 'a', content, now);
  assert.deepEqual(card.points, ['一', '二', '三', '四']);
  assert.equal(card.pointsTotal, 6);
});

test('empty child titles are skipped; a node without children omits the section', () => {
  const doc = map([node('root', null, [], '根'), node('a', 'root', ['c1', 'c2'], '观点'), node('c1', 'a', [], ''), node('c2', 'a', [], '  '), node('leaf', 'root', [], '叶子')]);
  doc.nodes.root.children = ['a', 'leaf'];
  const card = buildKnowledgeCard(doc, 'a', content, now);
  assert.deepEqual(card.points, []);
  assert.equal(card.pointsTotal, 0);
  assert.equal(buildKnowledgeCard(doc, 'leaf', content, now).points.length, 0);
});

test('card number uses content id and stable depth-first node order', () => {
  const doc = map([node('root', null, ['a', 'b'], 'r'), node('a', 'root', ['a1'], 'a'), node('a1', 'a', [], 'a1'), node('b', 'root', [], 'b')]);
  assert.equal(nodeIndex(doc, 'root'), 0);
  assert.equal(nodeIndex(doc, 'a1'), 2);
  assert.equal(nodeIndex(doc, 'b'), 3);
  assert.equal(buildKnowledgeCard(doc, 'a1', content, now).number, 'No.317-02');
  assert.equal(cardNumber(5, 0), 'No.5-00');
});

test('source rows only contain real fields; missing author or title stay empty', () => {
  const doc = map([node('root', null, [], '根观点')]);
  const card = buildKnowledgeCard(doc, 'root', { id: 9, platform: 'weibo', author: '', title: '' }, now);
  assert.equal(card.source.platform, '微博');
  assert.equal(card.source.author, '');
  assert.equal(card.source.title, '');
  const missing = buildKnowledgeCard(doc, 'root', { id: 9, platform: 'zhihu' }, now);
  assert.equal(missing.source.author, '');
  assert.equal(missing.source.title, '');
});

test('content title is flattened to a single bounded line', () => {
  const doc = map([node('root', null, [], '根')]);
  const card = buildKnowledgeCard(doc, 'root', { id: 1, platform: 'bilibili', title: `很长${'的'.repeat(80)}\n第二行标题` }, now);
  assert.ok(!card.source.title.includes('\n'));
  assert.ok(card.source.title.endsWith('…'));
  assert.ok(Array.from(card.source.title).length <= 42);
  assert.equal(fitLine('  短标题  ', 42), '短标题');
});

test('date and number formatting are deterministic', () => {
  assert.match(cardDate(now), /^\d{4}\.\d{2}\.\d{2}$/);
  const doc = map([node('root', null, [], '根')]);
  assert.equal(buildKnowledgeCard(doc, 'root', content, now).date, buildKnowledgeCard(doc, 'root', content, now).date);
});

test('viewpoint layout picks pixel font for short text and sans for long text', () => {
  assert.equal(viewpointLayout('收藏是起点，成果留给自己').family, 'pixel');
  assert.equal(viewpointLayout('短').family, 'pixel');
  assert.equal(viewpointLayout('字'.repeat(24)).family, 'pixel');
  assert.equal(viewpointLayout('字'.repeat(25)).family, 'sans');
});

test('viewpoint layout auto-fits between 56 and 34 and flags truncation beyond six lines', () => {
  assert.equal(viewpointLayout('短观点').size, 56);
  const fitting = viewpointLayout('字'.repeat(91));
  assert.ok(fitting.size < 56 && fitting.size >= 34);
  assert.equal(fitting.truncated, false);
  const huge = viewpointLayout('字'.repeat(400));
  assert.equal(huge.truncated, true);
  assert.equal(huge.size, 34);
  assert.ok(huge.display.endsWith('…'));
  assert.ok(Array.from(huge.display).length < 400);
  assert.equal(estimateLines('字'.repeat(400), 34), 6 + 10);
});

test('barcode strip is deterministic, varied and bounded', () => {
  const a = cardBarcode('No.317-02'), b = cardBarcode('No.317-03');
  assert.equal(a.length, 26);
  assert.deepEqual(a, cardBarcode('No.317-02'));
  assert.notDeepEqual(a, b);
  assert.ok(a.every(width => width >= 1 && width <= 3));
});

test('IPC validation accepts a well-formed card payload', () => {
  const doc = map([node('root', null, ['a'], '观点'), node('a', 'root', [], '要点')]);
  const card = buildKnowledgeCard(doc, 'root', content, now);
  assert.deepEqual(validateKnowledgeCardPayload(structuredClone(card)), card);
});

test('IPC validation rejects oversized and malformed payloads', () => {
  const doc = map([node('root', null, [], '观点')]);
  const base = buildKnowledgeCard(doc, 'root', content, now);
  assert.throws(() => validateKnowledgeCardPayload({ ...base, viewpoint: 'x'.repeat(21 * 1024) }), /知识卡片内容无效/);
  assert.throws(() => validateKnowledgeCardPayload({ ...base, viewpoint: 42 }), /知识卡片内容无效/);
  assert.throws(() => validateKnowledgeCardPayload({ ...base, points: [1, 2] }), /知识卡片内容无效/);
  assert.throws(() => validateKnowledgeCardPayload({ ...base, pointsTotal: 'six' }), /知识卡片内容无效/);
  assert.throws(() => validateKnowledgeCardPayload({ ...base, source: { ...base.source, author: 7 } }), /知识卡片内容无效/);
  assert.throws(() => validateKnowledgeCardPayload({ ...base, extra: 'field' }), /知识卡片内容无效/);
  assert.throws(() => validateKnowledgeCardPayload('not an object'), /知识卡片内容无效/);
});
