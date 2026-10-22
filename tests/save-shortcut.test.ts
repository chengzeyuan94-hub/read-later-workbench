import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchSaveShortcut, isActiveSourceModal, sourceWorkspaceOwnsShortcut, type SaveShortcutEvent } from '../src/renderer/save-shortcut.js';
import { AsrCorrectionSession } from '../src/renderer/asr-workspace-helpers.js';
import type { AsrDocument } from '../src/shared/asr-contracts.js';

function key(options: Partial<SaveShortcutEvent> = {}) {
  const trace = { prevented: false, stopped: false }, event: SaveShortcutEvent = { key: 's', metaKey: true, target: { closest: () => null }, preventDefault() { trace.prevented = true; }, stopPropagation() { trace.stopped = true; }, ...options }; return { event, trace };
}
function root(open: boolean): Pick<Document, 'querySelector'> { return { querySelector: () => open ? {} : null } as Pick<Document, 'querySelector'>; }
/** Native document capture runs before React's dialog bubble listener. */
function deliver(event: SaveShortcutEvent, open: boolean, options: { editorSave(): void; asrSave(): void; composing?: boolean }, trace: { stopped: boolean }) {
  dispatchSaveShortcut(event, { blocked: sourceWorkspaceOwnsShortcut(event, root(open)), save: options.editorSave });
  // The active ASR document listener also handles a temporarily detached/body focus.
  if (open && !trace.stopped) dispatchSaveShortcut(event, { composing: options.composing, save: options.asrSave });
  if (open && !trace.stopped) dispatchSaveShortcut(event, { composing: options.composing, save: options.asrSave });
}
test('仅最上层活跃来源模态处理 document 快捷键，关闭或被覆盖时不处理', () => { const host = { open: true }, other = { open: true }; assert.equal(isActiveSourceModal(host, [other, host]), true); assert.equal(isActiveSourceModal(host, [host, other]), false); assert.equal(isActiveSourceModal({ open: false }, []), false); assert.equal(isActiveSourceModal(null, []), false); });
test('Cmd/Ctrl+S 从 ASR 编辑和阅读区只到达当前来源工作区，不保存下层稿件', () => {
  for (const mode of ['reading', 'editing']) for (const platform of ['mac', 'ctrl']) {
    let editorSaves = 0, asrSaves = 0; const { event, trace } = key(platform === 'mac' ? {} : { metaKey: false, ctrlKey: true });
    deliver(event, true, { editorSave: () => editorSaves++, asrSave: () => asrSaves++ }, trace);
    assert.deepEqual({ mode, editorSaves, asrSaves, ...trace }, { mode, editorSaves: 0, asrSaves: 1, prevented: true, stopped: true });
  }
});
test('来源窗口的 target/composedPath 归属及活跃模态层都会阻止下层 document capture', () => {
  const nested = { closest: (selector: string) => selector.includes('.e2-asr-workspace') ? {} : null };
  assert.equal(sourceWorkspaceOwnsShortcut(key({ target: nested }).event, root(false)), true);
  assert.equal(sourceWorkspaceOwnsShortcut(key({ composedPath: () => [nested] as unknown as EventTarget[] }).event, root(false)), true);
  assert.equal(sourceWorkspaceOwnsShortcut(key().event, root(true)), true);
  const ocr = { closest: (selector: string) => selector.includes('.e11-ocr-workspace') ? {} : null };
  assert.equal(sourceWorkspaceOwnsShortcut(key({ target: ocr }).event, root(false)), true);
});
test('ASR composition 标记、native isComposing 和229均不触发任一保存', () => {
  for (const options of [{ composing: true }, { isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }]) {
    let editorSaves = 0, asrSaves = 0; const { event, trace } = key(options);
    deliver(event, true, { editorSave: () => editorSaves++, asrSave: () => asrSaves++, composing: options.composing }, trace);
    assert.equal(editorSaves, 0); assert.equal(asrSaves, 0); assert.equal(trace.stopped, true); assert.equal(trace.prevented, true);
  }
});
test('关闭 ASR 后下层编辑器快捷保存恢复，非保存组合不被消费', () => {
  let editorSaves = 0, asrSaves = 0; const current = key(); deliver(current.event, false, { editorSave: () => editorSaves++, asrSave: () => asrSaves++ }, current.trace);
  assert.equal(editorSaves, 1); assert.equal(asrSaves, 0);
  for (const options of [{ metaKey: false }, { key: 'x' }, { altKey: true }]) { const { event, trace } = key(options); assert.equal(dispatchSaveShortcut(event, { save: () => editorSaves++ }), 'ignored'); assert.deepEqual(trace, { prevented: false, stopped: false }); }
  assert.equal(editorSaves, 1);
});
test('ASR 保存失败后快捷重试可保存确切输入，原稿与下层稿件不被改写', async () => {
  const document = { result: { resultId: 'synthetic-shortcut-result', text: '原稿😀' }, correction: null, correctionHead: 0, correctionHistory: [] } as unknown as AsrDocument, original = structuredClone(document);
  let fail = true, apiCalls = 0, editorSaves = 0, saving = Promise.resolve(true);
  const session = new AsrCorrectionSession(7, document, { saveCorrection: async request => { apiCalls++; return fail ? { status: 'failed', contentId: request.contentId, resultId: request.resultId, sessionId: request.sessionId, requestId: request.requestId, error: 'synthetic disk failure' } : { status: 'saved', contentId: request.contentId, resultId: request.resultId, sessionId: request.sessionId, requestId: request.requestId, revision: 2 }; } });
  session.replace('我的中文校对😀'); const first = key(); deliver(first.event, true, { editorSave: () => editorSaves++, asrSave: () => { saving = session.barrier(); } }, first.trace); assert.equal(await saving, false); assert.equal(session.status, 'failed'); assert.equal(session.text, '我的中文校对😀');
  fail = false; const retry = key({ metaKey: false, ctrlKey: true }); deliver(retry.event, true, { editorSave: () => editorSaves++, asrSave: () => { saving = session.barrier(); } }, retry.trace); assert.equal(await saving, true); assert.equal(session.revision, 2); assert.equal(session.dirty, false); assert.equal(apiCalls, 2); assert.equal(editorSaves, 0); assert.deepEqual(document, original);
});
test('只读来源快捷经过保存屏障但不会新建校对版本', async () => {
  let apiCalls = 0, saving = Promise.resolve(true); const session = new AsrCorrectionSession(7, { result: { resultId: 'r', text: '原稿' }, correction: null } as AsrDocument, { saveCorrection: async () => { apiCalls++; throw Error('should not write'); } });
  const { event, trace } = key(); deliver(event, true, { editorSave: () => assert.fail('hidden editor save'), asrSave: () => { saving = session.barrier(); } }, trace); assert.equal(await saving, true); assert.equal(apiCalls, 0); assert.equal(session.revision, 0);
});
