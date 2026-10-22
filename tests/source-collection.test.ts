import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleXhsCollection, biliRecentScope, xhsCollectionRequest, xhsProfileTabScript, type XhsCollectionCapture } from '../src/main/source-collection.js';
const account = '0123456789abcdef01234567';
const id = (n: number) => n.toString(16).padStart(24, '0');
function page(cursor: string, ids: number[], next: string | null, order = 0): XhsCollectionCapture {
  return { requestId: String(order), requestOrder: order, accountId: account, cursor, status: 200, payload: { success: true, data: { notes: ids.map(n => ({ id: id(n), xsec_token: 'fixture', title: `夹具${n}` })), cursor: next, has_more: next !== null } } };
}
test('关联请求仅识别平台collect端点，显式初始cursor，解析账号且不携带签名URL', () => {
  const capture = xhsCollectionRequest('request1', 1, { url: `https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?user_id=${account}&cursor=&xsec_token=fixture` })!;
  assert.deepEqual(capture, { requestId: 'request1', requestOrder: 1, accountId: account, cursor: '' });
  assert.equal(xhsCollectionRequest('bad', 0, { url: `https://attacker.invalid/note/collect/page?user_id=${account}&cursor=` }), null);
  assert.equal(xhsCollectionRequest('unknown', 0, { url: `https://edith.xiaohongshu.com/note/collect/page?user_id=${account}` })?.cursor, null);
});
test('小红书乱序完成响应按显式cursor链和页内顺序组装，不按响应完成序', () => {
  const result = assembleXhsCollection(account, [page('second', [3, 4], null, 2), page('', [1, 2], 'second', 1)]);
  assert.equal(result.complete, true); assert.equal(result.evidence.reliable, true);
  assert.deepEqual(result.items.map(item => item.sourceId), [1, 2, 3, 4].map(id));
  assert.deepEqual(result.evidence.pages.map(value => [value.cursor, value.nextCursor]), [['', 'second'], ['second', null]]);
});
test('小红书尾部请求失败保留可靠头部；不输出断页后的游离响应', () => {
  const tail = page('second', [3], 'third', 2); tail.failed = true;
  const result = assembleXhsCollection(account, [page('', [1, 2], 'second', 1), tail, page('third', [5], null, 3)]);
  assert.equal(result.complete, false); assert.equal(result.evidence.reliable, true);
  assert.deepEqual(result.evidence.orderedIds, [id(1), id(2)]);
  assert.equal(result.evidence.pages.length, 1);
  assert.match(result.warning!, /连续头部|分页/);
});
test('小红书首屏失败或缺少初始cursor时不能用完整尾部反推可信首屏', () => {
  const head = page('', [1], 'second'); head.failed = true;
  for (const captures of [[head, page('second', [2], null, 1)], [page('second', [2], null)]]) {
    const result = assembleXhsCollection(account, captures);
    assert.equal(result.complete, false); assert.equal(result.evidence.reliable, false);
    assert.deepEqual(result.evidence.orderedIds, []); assert.deepEqual(result.evidence.pages, []);
  }
});
test('小红书断页仅保留连续prefix，拒绝同游标不同结果和畸形页', () => {
  const gap = assembleXhsCollection(account, [page('', [1], 'second'), page('third', [3], null, 2)]);
  assert.deepEqual(gap.evidence.orderedIds, [id(1)]); assert.equal(gap.complete, false);
  const duplicate = assembleXhsCollection(account, [page('', [1], null, 1), page('', [2], null, 2)]);
  assert.equal(duplicate.evidence.reliable, false);
  const broken = page('', [1], null); broken.payload!.data.notes.push({ id: id(2) });
  assert.equal(assembleXhsCollection(account, [broken]).evidence.reliable, false);
});
test('小红书账号范围隔离；迟到的其他账号首屏不进入本账号内容或检查点', () => {
  const unrelated = page('', [99], null, 0); unrelated.accountId = 'abcdef0123456789abcdef01';
  const result = assembleXhsCollection(account, [unrelated, page('', [1], null, 1)]);
  assert.equal(result.complete, true); assert.deepEqual(result.evidence.orderedIds, [id(1)]);
  assert.equal(assembleXhsCollection(unrelated.accountId, [page('', [1], null, 1)]).evidence.reliable, false);
});
test('小红书列表边界重复与游标循环不能声称完整历史', () => {
  const result = assembleXhsCollection(account, [page('', [1], 'second'), page('second', [1, 2], null, 1)]);
  assert.equal(result.complete, false); assert.deepEqual(result.evidence.orderedIds, [id(1)]);
  const loop = assembleXhsCollection(account, [page('', [1], 'second'), page('second', [2], '', 1)]);
  assert.equal(loop.complete, false);
});
test('B站逐夹mtime页证据只保留已成功连续prefix，P1坏时不会采用P2', () => {
  const pages = [{ cursor: '1', nextCursor: '2', ids: ['av1'], parsed: true }, { cursor: '2', nextCursor: '3', ids: ['av2'], parsed: false }, { cursor: '3', nextCursor: null, ids: ['av3'], parsed: true }];
  assert.deepEqual(biliRecentScope('folder', pages).orderedIds, ['av1']);
  assert.equal(biliRecentScope('folder', [{ ...pages[0]!, parsed: false }, ...pages.slice(1)]).reliable, false);
});


test('XHS OPTIONS预检不成为内容请求或污染同游标GET', () => {
  const url = `https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?user_id=${account}&cursor=`;
  assert.equal(xhsCollectionRequest('preflight', 0, { method: 'OPTIONS', url }), null);
  assert.equal(xhsCollectionRequest('mutation', 0, { method: 'DELETE', url }), null);
  const get = xhsCollectionRequest('get', 1, { method: 'GET', url })!;
  Object.assign(get, { status: 200, payload: page('', [1], null).payload });
  const result = assembleXhsCollection(account, [get]);
  assert.equal(result.complete, true); assert.equal(result.evidence.reliable, true);
  assert.deepEqual(result.evidence.orderedIds, [id(1)]);
});


test('XHS标签脚本只点击唯一可见且名称精确匹配的收藏tab', async () => {
  const { runInNewContext } = await import('node:vm');
  let clicks = 0;
  const element = (text: string, active = false, visible = true) => ({ textContent: text, hidden: false, className: active ? 'reds-tab-item active' : 'reds-tab-item', getClientRects: () => visible ? [1] : [], getAttribute: () => null, click: () => { clicks++; } });
  const context = (elements: unknown[]) => ({ document: { querySelectorAll: () => elements }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const selected = runInNewContext(xhsProfileTabScript('收藏', true), context([element('收藏'), element('收藏123'), element('收藏', false, false)]));
  assert.equal(selected.found, true); assert.equal(selected.clicked, true); assert.equal(clicks, 1);
  const ambiguous = runInNewContext(xhsProfileTabScript('收藏', true), context([element('收藏'), element('收藏')]));
  assert.equal(ambiguous.found, false); assert.equal(clicks, 1);
  const active = runInNewContext(xhsProfileTabScript('收藏', true), context([element('收藏', true)]));
  assert.equal(active.active, true); assert.equal(active.clicked, false); assert.equal(clicks, 1);
});
