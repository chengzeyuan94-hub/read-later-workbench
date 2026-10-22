const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Runs against the actual isolated renderer and restricted IPC, never a synthetic workbench API. */
async function runUiRegression(win, { evidenceDir }) {
  const results = []; const startedAt = new Date().toISOString();
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const snapshot = () => evaluate('window.e0Probe.snapshot()');
  const probe = (name, ...args) => evaluate(`window.e0Probe[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  async function wait(predicate, message, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(35); } throw new Error(`Timeout: ${message}`); }
  async function check(name, action) { const begin = Date.now(); await action(); results.push({ name, passed: true, elapsedMs: Date.now() - begin }); }
  async function switchWorkspace(id) { await probe('switchWorkspace', id); const prefix = id.replace(/-workspace$/, ''); await wait(async () => { const state = await snapshot(); const blocks = await probe('bodyBlocks'); return state.workspaceId === id && blocks[0]?.id === `${prefix}-draft-h1`; }, `React committed editor ${id}`); }
  async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(100); }
  function text(block) { return block.runs.map(run => run.text).join(''); }
  try {
    await wait(() => evaluate('Boolean(window.e0Probe?.snapshot().state)'), 'renderer ready');
    await switchWorkspace('e0-a-workspace');
    await check('actual local images decode with HTTP(S) blocked', async () => {
      const images = await evaluate(`Promise.all([...document.querySelectorAll('img')].map(async image => { await image.decode(); return {src:image.src,width:image.naturalWidth,height:image.naturalHeight}; }))`);
      assert.ok(images.length >= 3); assert.ok(images.every(image => image.src.startsWith('e0-asset:') && image.width === 320 && image.height === 180));
      const blocked = await evaluate(`fetch('https://example.com/e0-offline-probe').then(()=>false,()=>true)`); assert.equal(blocked, true);
    });
    await check('PM body typing preserves IDs and existing mixed runs', async () => {
      const before = await probe('bodyBlocks'); await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', '前插🧪 '); const after = await probe('bodyBlocks');
      assert.deepEqual(after.map(block => block.id), before.map(block => block.id)); assert.ok(after[1].runs.some(run => run.bold && run.text === '局部粗体')); assert.ok(text(after[1]).startsWith('前插🧪 '));
    });
    await check('native Enter split preserves left block ID and gives right a fresh ID', async () => {
      const before = await probe('bodyBlocks'); await probe('bodySelect', 'e0-a-draft-p2', 3); await key('Enter'); const after = await probe('bodyBlocks');
      assert.equal(after.length, before.length + 1); const left = after.findIndex(block => block.id === 'e0-a-draft-p2'); assert.equal(text(after[left]), '第二段'); assert.notEqual(after[left + 1].id, 'e0-a-draft-p2'); assert.equal(new Set(after.map(block => block.id)).size, after.length);
    });
    await check('native Cmd+B in body affects only selection and preserves other formatting', async () => {
      await probe('bodySelect', 'e0-a-draft-p1', 0, 2); await key('b', ['meta']); const after = await probe('bodyBlocks'); const paragraph = after.find(block => block.id === 'e0-a-draft-p1');
      assert.equal(paragraph.runs[0].text, '前插'); assert.equal(paragraph.runs[0].bold, true); assert.ok(paragraph.runs.some(run => run.bold && run.text === '局部粗体'));
    });
    await check('1.5 second global poll retains selection, dirty draft and rich document', async () => {
      const before = await snapshot(); const documentBefore = await probe('bodyBlocks'); await delay(3250); const after = await snapshot();
      assert.ok(before.editorSelection && Number.isInteger(before.editorSelection.from) && Number.isInteger(before.editorSelection.to)); assert.ok(after.pollCount >= before.pollCount + 2); assert.deepEqual(after.editorSelection, before.editorSelection); assert.deepEqual(await probe('bodyBlocks'), documentBefore); assert.notEqual(after.session.edit, after.session.savedEdit);
    });
    await check('title local bold, re-edit, Enter commit have one model action and no extra node', async () => {
      await probe('startTitle', 'e0-a-n8'); await delay(80); const before = await snapshot(); await probe('titleSelect', 0, 4); await key('b', ['meta']); await key('Enter'); const after = await snapshot();
      assert.equal(Object.keys(after.state.map.nodes).length, Object.keys(before.state.map.nodes).length); assert.equal(after.titleId, null); assert.ok(after.state.map.nodes['e0-a-n8'].title.some(run => run.text === '普通文字' && run.bold)); assert.ok(after.state.map.nodes['e0-a-n8'].title.some(run => run.text === '局部粗体' && run.bold));
      await probe('startTitle', 'e0-a-n8'); await delay(60); assert.ok((await probe('titleBlocks'))[0].runs.some(run => run.text === '普通文字' && run.bold)); await key('Escape');
    });
    await check('title Escape cancels draft; Shift+Enter makes newline; Tab commits without structure', async () => {
      const before = await snapshot(); await probe('startTitle', 'e0-a-n6'); await delay(60); await probe('titleSelect', 0); await probe('insertTitle', '取消稿'); await key('Escape'); assert.deepEqual((await snapshot()).state.map.nodes['e0-a-n6'], before.state.map.nodes['e0-a-n6']);
      await probe('startTitle', 'e0-a-n6'); await delay(60); await probe('titleSelect', 0); await key('Enter', ['shift']); await key('Tab'); const after = await snapshot(); assert.ok(after.state.map.nodes['e0-a-n6'].title.map(run => run.text).join('').startsWith('\n')); assert.equal(Object.keys(after.state.map.nodes).length, Object.keys(before.state.map.nodes).length);
    });
    await check('synthetic composition Enter cannot commit or add nodes (not actual macOS IME evidence)', async () => {
      await probe('startTitle', 'e0-a-n6'); await delay(60); const before = await snapshot(); await probe('composition', 'title', 'start'); await probe('syntheticKey', 'title', 'Enter', { isComposing: true }); const during = await snapshot(); assert.equal(during.titleId, 'e0-a-n6'); assert.equal(during.state.view.inputSession.composing, true); assert.equal(Object.keys(during.state.map.nodes).length, Object.keys(before.state.map.nodes).length); await probe('composition', 'title', 'end'); await delay(100); await key('Escape');
    });
    await check('native canvas Tab adds one node; title Tab commits rather than adding again', async () => {
      await probe('command', { type: 'select', selection: { kind: 'node', nodeId: 'e0-a-n1' } }); await delay(80); const before = await snapshot(); await key('Tab'); const during = await snapshot(); assert.equal(Object.keys(during.state.map.nodes).length, Object.keys(before.state.map.nodes).length + 1); assert.ok(during.titleId); await key('Tab'); const after = await snapshot(); assert.equal(after.titleId, null); assert.equal(Object.keys(after.state.map.nodes).length, Object.keys(during.state.map.nodes).length);
    });
    await check('canvas Cmd+B changes explicit node style, while body Tab never triggers structure', async () => {
      await probe('command', { type: 'select', selection: { kind: 'node', nodeId: 'e0-a-n8' } }); await delay(80); const before = await snapshot(); await key('b', ['meta']); const after = await snapshot(); assert.deepEqual(after.state.map.nodes['e0-a-n8'].title, before.state.map.nodes['e0-a-n8'].title); assert.equal(after.state.map.nodes['e0-a-n8'].style.bold, true); await probe('bodySelect', 'e0-a-draft-p1', 0); await key('Tab'); assert.equal(Object.keys((await snapshot()).state.map.nodes).length, Object.keys(after.state.map.nodes).length);
    });
    await check('unified undo/redo restores structural node identity and selection', async () => {
      const before = await snapshot(); await probe('command', { type: 'addChild', nodeId: 'e0-a-n1', newId: 'e0-ui-undo-node', title: [{ text: '撤销节点' }] }); await probe('command', { type: 'deleteSubtree', nodeId: 'e0-ui-undo-node' }); await probe('command', { type: 'undo' }); const restored = await snapshot(); assert.equal(restored.state.map.nodes['e0-ui-undo-node'].id, 'e0-ui-undo-node'); assert.equal(restored.state.view.selection.nodeId, 'e0-ui-undo-node'); await probe('command', { type: 'redo' }); assert.equal((await snapshot()).state.map.nodes['e0-ui-undo-node'], undefined); assert.equal(Object.keys((await snapshot()).state.map.nodes).length, Object.keys(before.state.map.nodes).length);
    });
    await check('real SQLite controlled failure retains draft and retries at the same baseline', async () => {
      await evaluate(`window.e0.setFault({failNext:true})`); const before = await snapshot(); assert.equal(await probe('save'), false); const failed = await snapshot(); assert.equal(failed.session.status, 'failed'); assert.equal(failed.session.bundle.workspace.draftRevision, before.session.bundle.workspace.draftRevision); assert.equal(failed.editorText, before.editorText); assert.equal(await probe('save'), true); const confirmed = await snapshot(); assert.equal(confirmed.session.status, 'saved'); const stored = await evaluate(`window.e0.load('e0-a-workspace')`); assert.deepEqual(stored.draft.blocks, confirmed.session.bundle.draft.blocks);
    });
    await check('saving while typing keeps later edit dirty, then retry persists it', async () => {
      await evaluate(`window.e0.setFault({saveDelayMs:350})`); await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', '先保存 '); await evaluate('void window.e0Probe.save()'); await delay(50); await probe('insertBody', '后输入 '); await wait(async () => (await snapshot()).session.status === 'dirty', 'later typing remains dirty'); assert.ok((await snapshot()).editorText.includes('后输入')); assert.equal(await probe('save'), true); await evaluate(`window.e0.setFault({saveDelayMs:0})`);
    });
    await check('late save reply cannot populate switched document; cached draft survives return', async () => {
      await evaluate(`window.e0.setFault({saveDelayMs:300})`); await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', 'A独有内容 '); await evaluate('void window.e0Probe.save()'); await switchWorkspace('e0-b-workspace'); const b = await snapshot(); await delay(450); const after = await snapshot(); assert.equal(after.workspaceId, 'e0-b-workspace'); assert.equal(after.editorText, b.editorText); assert.ok(!after.editorText.includes('A独有内容')); await switchWorkspace('e0-a-workspace'); assert.ok((await snapshot()).editorText.includes('A独有内容')); await evaluate(`window.e0.setFault({saveDelayMs:0})`);
    });
    await check('selection creates node with exact confirmed Unicode-code-point draft reference', async () => {
      await probe('bodySelect', 'e0-a-draft-p1', 0, 4); const before = await snapshot(); await probe('addFromSelection'); const after = await snapshot(); assert.equal(Object.keys(after.state.map.nodes).length, Object.keys(before.state.map.nodes).length + 1); const node = after.state.map.nodes[after.state.view.selection.nodeId]; const reference = node.sourceRefs[0]; assert.equal(reference.kind, 'userDraft'); assert.equal(reference.range.unit, 'unicode-code-point'); const resolved = await probe('resolve', reference); assert.equal(resolved.selectedText, node.title.map(run => run.text).join('')); assert.equal(await probe('save'), true);
    });
    await check('old generation token cannot apply to switched workspace or newer input', async () => {
      const token = await probe('candidateToken'); await switchWorkspace('e0-b-workspace'); assert.equal(await probe('applyCandidate', token), false); await switchWorkspace('e0-a-workspace'); const token2 = await probe('candidateToken'); await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', '更新稿 '); assert.equal(await probe('applyCandidate', token2), false); assert.equal(await probe('save'), true);
    });
    await check('explicit regular title runs override node bold and survive editing, saving and re-editing', async () => {
      const current = await snapshot(); if (!current.state.map.nodes['e0-a-n8'].style?.bold) await probe('command', { type: 'toggleNodeBold', nodeId: 'e0-a-n8' });
      await probe('command', { type: 'rename', nodeId: 'e0-a-n8', title: [{ text: '继承粗体 ' }, { text: '明确常规', bold: false, italic: false, code: false }, { text: ' 末尾' }] });
      await wait(() => evaluate(`document.querySelector('[data-node-id="e0-a-n8"] .node-title')?.textContent === '继承粗体 明确常规 末尾'`), 'regular runs rendered');
      const appearance = await evaluate(`[...document.querySelectorAll('[data-node-id="e0-a-n8"] .node-title>span')].map(span=>({text:span.textContent,weight:getComputedStyle(span).fontWeight,style:getComputedStyle(span).fontStyle}))`);
      assert.equal(appearance[0].weight, '700'); assert.equal(appearance[1].weight, '400'); assert.equal(appearance[1].style, 'normal');
      await probe('startTitle', 'e0-a-n8'); await delay(70); assert.ok((await probe('titleBlocks'))[0].runs.some(run => run.text === '明确常规' && run.bold === false && run.italic === false && run.code === false)); await probe('titleSelect', 0, 2); await key('b', ['meta']);
      const edited = (await probe('titleBlocks'))[0].runs; assert.equal(edited[0].text, '继承'); assert.equal(edited[0].bold, false); assert.equal(await evaluate(`getComputedStyle(document.querySelector('.title-editor [data-e0-strong="false"]')).fontWeight`), '400'); await key('Enter'); assert.equal(await probe('save'), true);
      await probe('startTitle', 'e0-a-n8'); await delay(70); const reopened = (await probe('titleBlocks'))[0].runs; assert.equal(reopened[0].bold, false); assert.ok(reopened.some(run => run.text === '明确常规' && run.bold === false && run.italic === false && run.code === false)); await key('Escape');
      const stored = await evaluate(`window.e0.load('e0-a-workspace')`); assert.equal(stored.map.nodes['e0-a-n8'].style.bold, true); assert.deepEqual(stored.map.nodes['e0-a-n8'].title, reopened);
    });
    await check('late save acknowledgement never labels an unsubmitted title draft as fully saved', async () => {
      await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', '保存状态 '); await evaluate('window.e0.setFault({saveDelayMs:350})'); await evaluate('void window.e0Probe.save()'); await delay(45); await probe('startTitle', 'e0-a-n6'); await delay(60); await probe('titleSelect', 0); await probe('insertTitle', '尚未提交标题 ');
      await wait(async () => (await snapshot()).session.status === 'saved', 'older body save acknowledged'); const pending = await snapshot(); assert.equal(pending.titleUncommitted, true); assert.equal(pending.displaySaveStatus, '标题编辑中 · 尚未提交'); assert.equal(await evaluate(`document.querySelector('[data-testid="save-status"]').textContent`), '标题编辑中 · 尚未提交'); assert.ok(!pending.state.map.nodes['e0-a-n6'].title.map(run => run.text).join('').includes('尚未提交标题'));
      await key('Enter'); assert.equal((await snapshot()).session.status, 'dirty'); await evaluate('window.e0.setFault({saveDelayMs:0})'); assert.equal(await probe('save'), true);
    });
    await check('normal close write failure keeps dialog and draft; cancel and retry remain usable', async () => {
      await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', '关闭保稿 '); const before = await snapshot(); await evaluate('window.e0.setFault({failNext:true})'); await evaluate('window.e0.requestClose()'); await wait(() => evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), 'close dialog'); await probe('close', 'saved'); assert.equal((await snapshot()).session.status, 'failed'); assert.equal((await snapshot()).editorText, before.editorText); assert.equal(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), true); await probe('close', 'cancel'); await wait(() => evaluate(`!document.querySelector('[role="dialog"]')`), 'close canceled'); assert.equal(await probe('save'), true);
    });
    await check('close barrier rejects editing already-saved A while B acknowledgement is pending', async () => {
      await switchWorkspace('e0-b-workspace'); await probe('bodySelect', 'e0-b-draft-p1', 0); await probe('insertBody', 'B关闭检查 ');
      await switchWorkspace('e0-a-workspace'); await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', 'A关闭前 '); await switchWorkspace('e0-b-workspace');
      await evaluate('window.e0.setFault({saveDelayMs:350})'); await evaluate('window.e0.requestClose()'); await wait(() => evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), 'second close dialog'); await evaluate(`void window.e0Probe.close('saved')`);
      await wait(async () => (await snapshot()).session.status === 'saving', 'B acknowledgement pending after A confirmed');
      await switchWorkspace('e0-a-workspace'); await probe('bodySelect', 'e0-a-draft-p1', 0); await probe('insertBody', 'A在B保存中再编辑 '); await delay(450);
      assert.equal((await snapshot()).session.status, 'dirty'); assert.ok((await snapshot()).editorText.includes('A在B保存中再编辑')); assert.equal(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), true);
      await probe('close', 'cancel'); await evaluate('window.e0.setFault({saveDelayMs:0})'); assert.equal(await probe('save'), true);
    });
    await check('SQLite reload and renderer remount preserve confirmed IDs, runs, references and local image', async () => {
      const before = await evaluate(`window.e0.load('e0-a-workspace')`); await win.webContents.reload(); await wait(() => evaluate('Boolean(window.e0Probe?.snapshot().state)'), 'renderer remounted'); const after = await evaluate(`window.e0.load('e0-a-workspace')`); assert.deepEqual(after, before); assert.deepEqual((await snapshot()).session.bundle, before); assert.ok((await probe('markdown')).includes('**'));
    });
    const output = { startedAt, finishedAt: new Date().toISOString(), scope: 'synthetic E0 model, real Electron renderer, real isolated SQLite IPC', passed: results.length, failed: 0, actualMacOSIME: 'not measured by this script; synthetic composition is separate', results };
    fs.mkdirSync(evidenceDir, { recursive: true }); fs.writeFileSync(path.join(evidenceDir, 'ui-regression.json'), JSON.stringify(output, null, 2)); return output;
  } catch (error) {
    const output = { startedAt, finishedAt: new Date().toISOString(), passed: results.length, failed: 1, error: error.stack || String(error), actualMacOSIME: 'not measured by this script', results };
    fs.mkdirSync(evidenceDir, { recursive: true }); fs.writeFileSync(path.join(evidenceDir, 'ui-regression.json'), JSON.stringify(output, null, 2)); throw error;
  }
}
module.exports = { runUiRegression };
