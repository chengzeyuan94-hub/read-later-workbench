import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftReading, exactDraftReferenceVersion } from '../src/renderer/draft-reading.js';
import type { DraftBlock } from '../src/editor-core/model.js';

test('E3 read preview derives Chinese text, levels, lists and marks from canonical blocks', () => {
 const blocks: DraftBlock[] = [
  { id: 'heading', type: 'heading', level: 2, runs: [{ text: '保存后的中文😀' }] },
  { id: 'paragraph', type: 'paragraph', runs: [{ text: '25分钟', bold: true }, { text: '与5分钟', italic: true }] },
  { id: 'list', type: 'orderedList', start: 3, runs: [], children: [{ id: 'item', type: 'listItem', runs: [], children: [{ id: 'item-p', type: 'paragraph', runs: [{ text: '确切版本' }] }] }] },
 ];
 const html = renderToStaticMarkup(React.createElement(DraftReading, { blocks, assetUrl: () => '' }));
 assert.match(html, /<h2>保存后的中文😀<\/h2>/);
 assert.match(html, /<strong>25分钟<\/strong><em>与5分钟<\/em>/);
 assert.match(html, /<ol start="3"><li><p>确切版本<\/p><\/li><\/ol>/);
 assert.doesNotMatch(html, /contenteditable|system-pending|示例节点/);
 blocks[1].runs = [{ text: '重新保存后的新正文' }];
 const next = renderToStaticMarkup(React.createElement(DraftReading, { blocks, assetUrl: () => '' }));
 assert.match(next, /重新保存后的新正文/); assert.doesNotMatch(next, /25分钟/);
});
test('E3 preview escapes source markup and uses only the supplied exact local asset resolver', () => {
 const refs: unknown[] = [];
 const html = renderToStaticMarkup(React.createElement(DraftReading, { blocks: [
  { id: 'p', type: 'paragraph', runs: [{ text: '<script>私文</script>', href: 'https://example.com' }] },
  { id: 'image', type: 'image', runs: [], assetRefs: [{ assetId: 'asset-1', version: 'fixed-1' }] },
 ], assetUrl: ref => { refs.push(ref); return 'rlw-generation://local/1/artifact/assets/fixed.png'; } }));
 assert.match(html, /&lt;script&gt;私文&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|<a /);
 assert.deepEqual(refs, [{ assetId: 'asset-1', version: 'fixed-1' }]);
 assert.match(html, /src="rlw-generation:\/\/local\/1\/artifact\/assets\/fixed.png"/);
});


test('正文出处仅属于完整确切文档版本，相同块文字不能把恢复稿定位到后来生成来源',()=>{const saved:any={documentId:'d',workspaceId:'w',schemaVersion:1,revision:2,blocks:[{id:'same',type:'paragraph',runs:[{text:'相同事实'}]}]};assert.equal(exactDraftReferenceVersion(saved,structuredClone(saved)),true);for(const patch of [{revision:3},{documentId:'other'},{workspaceId:'other'},{blocks:[{id:'same',type:'paragraph',runs:[{text:'人工修改'}]}]}])assert.equal(exactDraftReferenceVersion({...saved,...patch},saved),false);assert.equal(exactDraftReferenceVersion(saved),false);});
