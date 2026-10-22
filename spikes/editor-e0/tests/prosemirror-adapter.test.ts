import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { toPM, fromPM, toggleInlineMark, type Block } from '../renderer/prosemirror.js';
test('ProseMirror structured roundtrip preserves block IDs, heading, marks, multiline, Chinese and emoji', () => {
  const blocks: Block[] = [{ id: 'stable-heading', type: 'heading', level: 2, runs: [{ text: '中文与 emoji 🧠' }] }, { id: 'stable-paragraph', type: 'paragraph', assetRefs: [{ assetId: 'local-image', version: '1' }], runs: [{ text: '普通 ' }, { text: '局部\n粗体📚', bold: true }, { text: ' code', code: true, italic: true }] }];
  assert.deepEqual(fromPM(toPM(blocks)), blocks);
});
test('empty structured draft obtains one editable empty paragraph, never source fallback', () => {
  const blocks = fromPM(toPM([])); assert.equal(blocks.length, 1); assert.ok(blocks[0].id.startsWith('block-')); assert.equal(blocks[0].type, 'paragraph'); assert.deepEqual(blocks[0].runs, []);
});
test('explicit false marks remain distinct from inheritance through PM serialization', () => {
  const blocks: Block[] = [{ id: 'tri-state', type: 'paragraph', runs: [{ text: '继承' }, { text: '明确常规', bold: false, italic: false, code: false }, { text: '粗体', bold: true }, { text: '再继承' }, { text: '常规', bold: false }] }];
  assert.deepEqual(fromPM(toPM(blocks)), blocks);
});
test('local bold toggle under inherited node bold creates explicit false and roundtrips', () => {
  let state = EditorState.create({ doc: toPM([{ id: 'title', type: 'paragraph', runs: [{ text: '继承粗体 ' }, { text: '常规', bold: false }] }]) });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)));
  assert.equal(toggleInlineMark('strong', true)(state, transaction => { state = state.apply(transaction); }), true);
  const blocks = fromPM(state.doc); assert.deepEqual(blocks[0].runs, [{ text: '继承', bold: false }, { text: '粗体 ' }, { text: '常规', bold: false }]); assert.deepEqual(fromPM(toPM(blocks)), blocks);
});
