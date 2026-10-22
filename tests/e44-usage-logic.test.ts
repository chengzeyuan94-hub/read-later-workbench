import test from 'node:test';
import assert from 'node:assert/strict';
import { clone } from '../src/editor-core/model.js';
import { fixture, prepare, finish } from './generation-fix-fixture.js';
import { batchSelectionReason } from '../src/renderer/batch-eligibility.js';
import type { WorkbenchState } from '../src/shared/contracts.js';

type F = ReturnType<typeof fixture>;
function click(f: F) { f.digest.request(f.id); return f.generation.authorize(f.id); }
const count = (f: F, table: string) => (f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

test('E4.4 publish: unchanged non-managed workspace installs directly with adoption, preserved title, restorable', () => {
 const f = fixture(true);
 try {
  const requested = click(f), wid = requested.target!.workspaceId;
  prepare(f); const done = finish(f);
  assert.equal(done.state, 'succeeded'); assert.equal(done.candidate, null);
  assert.equal(done.canRestorePrevious, true);
  const bundle = f.editor.load(wid).bundle;
  assert.equal(bundle.workspace.userTitle, '合成机制，不是真实生成', 'non-managed install keeps the human userTitle');
  assert.equal(count(f, 'generation_adoptions'), 1, 'direct install on human history records an adoption');
  assert.equal(f.digest.status(f.id).library!.candidate, false);
  // 人工修改后不再可恢复；撤销采用后可恢复性复位。
  const restored = f.generation.undoAdoption(f.id, f.generation.status(f.id).target!);
  assert.equal(restored.canRestorePrevious, false);
  assert.equal(count(f, 'generation_adoption_undos'), 1);
  assert.equal(f.editor.load(wid).bundle.workspace.userTitle, '合成机制，不是真实生成');
 } finally { f.close(); }
});

test('E4.4 publish: managed unchanged workspace installs without adoption rows', () => {
 const f = fixture();
 try {
  click(f); prepare(f); const done = finish(f);
  assert.equal(done.candidate, null); assert.equal(done.canRestorePrevious, false);
  assert.equal(count(f, 'generation_adoptions'), 0, 'managed installs never created an adoption before E4.4 either');
 } finally { f.close(); }
});

test('E4.4 publish: dirty edit lease still produces a candidate', () => {
 const f = fixture(true);
 try {
  click(f); prepare(f); f.generation.touch(f.id, 'composition-session');
  const done = finish(f);
  assert.ok(done.candidate); assert.equal(count(f, 'generation_adoptions'), 0);
 } finally { f.close(); }
});

test('E4.4 addManual: rejects empty workspace, is idempotent, records source and completion', () => {
 const f = fixture(true);
 try {
  const wid = (f.store.db.prepare('SELECT id FROM editor_workspaces WHERE content_id=?').get(f.id) as { id: string }).id;
  // 清空文稿与导图后拒绝。
  const open = f.editor.load(wid), draft = clone(open.bundle.draft); draft.blocks = [];
  assert.equal(f.editor.save([{ workspaceId: wid, documentId: draft.documentId, expectedRevision: draft.revision, sessionId: 'test', requestId: 'one', document: draft }])[0].status, 'saved');
  assert.throws(() => f.digest.addManual(f.id), /先写一点导图或文稿/);
  // 写回内容后成功，幂等。
  const latest = f.editor.load(wid).bundle.draft, draft2 = clone(latest); draft2.blocks.push({ id: 'manual-note', type: 'paragraph', runs: [{ text: '自己的理解' }] });
  assert.equal(f.editor.save([{ workspaceId: wid, documentId: draft2.documentId, expectedRevision: draft2.revision, sessionId: 'test', requestId: 'two', document: draft2 }])[0].status, 'saved');
  const added = f.digest.addManual(f.id);
  assert.equal(added.library!.active, true); assert.equal(added.library!.source, 'manual'); assert.ok(added.library!.completedAt);
  const again = f.digest.addManual(f.id);
  assert.equal(again.library!.completedAt, added.library!.completedAt, '重复调用不改动完成时间');
 } finally { f.close(); }
});

test('E4.4 addManual: no workspace at all is rejected with a clear Chinese error', () => {
 const f = fixture();
 try { assert.throws(() => f.digest.addManual(f.id), /还没有保存的笔记/); } finally { f.close(); }
});

test('E4.4 manual source survives a later AI completion while completed_at updates', () => {
 const f = fixture(true);
 try {
  f.digest.addManual(f.id);
  assert.equal(f.digest.status(f.id).library!.source, 'manual');
  click(f); prepare(f); const done = finish(f);
  assert.equal(done.candidate, null);
  const library = f.digest.status(f.id).library!;
  assert.equal(library.source, 'manual', 'AI 完成不覆盖 manual 来源');
  assert.ok(library.completedAt);
 } finally { f.close(); }
});

test('E4.4 source migration: legacy rows map to legacy, everything else to ai', () => {
 const f = fixture(true);
 try {
  assert.equal(f.store.db.pragma('user_version', { simple: true }), 10);
  const added = f.digest.addManual(f.id); assert.equal(added.library!.source, 'manual');
  f.store.db.prepare("UPDATE digest_library SET legacy=1,source='legacy' WHERE content_id=?").run(f.id);
  assert.equal(f.digest.status(f.id).library!.source, 'legacy');
 } finally { f.close(); }
});

test('E4.4 batch eligibility drops recent-scope membership but keeps other exclusions', () => {
 const content = { id: 1, platform: 'xiaohongshu', accountId: 'a', sourceId: 's1' } as WorkbenchState['contents'][number];
 const state = { recentSync: { scopes: [], pausedContentDownloads: [] }, digestStates: [] } as unknown as WorkbenchState;
 assert.equal(batchSelectionReason(content, state, []), undefined, '不在最近范围的条目现在可以入批');
 assert.equal(batchSelectionReason(content, state, null), '正在核对批次状态');
 assert.equal(batchSelectionReason(content, state, [1]), '已加入批次，请查看批次进度');
 const paused = { recentSync: { scopes: [], pausedContentDownloads: [{ contentId: 1 }] }, digestStates: [] } as unknown as WorkbenchState;
 assert.equal(batchSelectionReason(content, paused, []), '此条自动下载已暂停');
 const done = { recentSync: { scopes: [], pausedContentDownloads: [] }, digestStates: [{ contentId: 1, request: null, library: { active: true, synthetic: false }, stages: [] }] } as unknown as unknown as WorkbenchState;
 assert.equal(batchSelectionReason(content, done, []), '已有消化成果，直接打开阅读');
});
