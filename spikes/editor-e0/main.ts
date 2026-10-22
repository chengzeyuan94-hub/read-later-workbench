import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeIsolationDirectory, isolatedFile } from './isolation.js';
import { EditorStore } from './store.js';
import { createFixtureBundle } from './fixtures.js';
import { scaleFixture } from './scale-fixture.js';
import { validateSaveRequest, validateSourceReference, type SaveRequest } from './model.js';
import { exportXmind } from './xmind.js';

const project = path.resolve(__dirname, '../..');
process.chdir(project);
let root: string;
try { root = initializeIsolationDirectory(process.env.RLW_E0_DIR); }
catch (error) { console.error('E0 isolation refused:', (error as Error).message); app.exit(2); throw error; }
app.setName('收藏阅读工作台 · E0 合成验证');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'profile'));
app.commandLine.appendSwitch('log-level', '3');
protocol.registerSchemesAsPrivileged([{ scheme: 'e0-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const log = (event: string, data: Record<string, unknown> = {}) => fs.appendFileSync(path.join(root, 'evidence/runtime.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n');
let store: EditorStore | undefined, win: BrowserWindow | undefined, shuttingDown = false, allowClose = false;
let fault = { saveDelayMs: 0, loadDelayMs: 0 };
let saveRequestCount = 0;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const identifier = (id: unknown): string => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid E0 identity'); return id; };
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  void app.whenReady().then(async () => {
    // This session belongs exclusively to the explicit isolated profile above.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    const httpBlocked = await session.defaultSession.fetch('http://example.com/e0-isolation-check').then(() => false, () => true);
    const httpsBlocked = await session.defaultSession.fetch('https://example.com/e0-isolation-check').then(() => false, () => true);
    if (!httpBlocked || !httpsBlocked) throw new Error('E0 HTTP(S) block verification failed');
    log('network-check', { httpBlocked, httpsBlocked });
    store = new EditorStore(isolatedFile(root, 'editor.sqlite'), { nativeBinding: path.join(project, '.runtime/electron.node') });
    for (const name of ['a', 'b'] as const) {
      const nodeCount = process.env.E01_NODE_COUNT === undefined ? 12 : Number(process.env.E01_NODE_COUNT);
      const bundle = scaleFixture(createFixtureBundle(name), nodeCount);
      // Never reset an existing workspace or silently repair missing user files on restart.
      if (!store.listWorkspaces().some(workspace => workspace.id === bundle.workspace.id)) {
        for (const asset of bundle.assets) {
          const target = isolatedFile(root, asset.relativePath); const bytes = Buffer.from(asset.bytesBase64!, 'base64');
          if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Synthetic asset hash mismatch');
          if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
          else if (createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== asset.sha256) throw new Error('Existing isolated asset differs; refusing overwrite');
        }
        store.seed(bundle);
      }
    }
    protocol.handle('e0-asset', async request => {
      if (shuttingDown || !store) return new Response(null, { status: 503 });
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      try {
        const url = new URL(request.url); if (url.hostname !== 'local' || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)) return new Response(null, { status: 404 });
        const id = url.pathname.slice(1), version = url.searchParams.get('version');
        if (!version || version.length > 200 || [...url.searchParams.keys()].some(key => key !== 'version')) return new Response(null, { status: 400 });
        const assets = store.listWorkspaces().flatMap(workspace => store!.loadWorkspace(workspace.id).assets);
        const asset = assets.find(candidate => candidate.id === id && candidate.version === version); if (!asset) return new Response(null, { status: 404 });
        const bytes = fs.readFileSync(isolatedFile(root, asset.relativePath));
        if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) return new Response('Local asset integrity failed', { status: 409 });
        return new Response(bytes, { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response('Local synthetic asset missing', { status: 404 }); }
    });
    const ui = path.join(project, 'dist/editor-e0/renderer/index.html');
    const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(`e0:${name}`, (event, ...args) => {
      if (shuttingDown || !win || win.isDestroyed() || event.sender.isDestroyed()) throw new Error('E0 is closing');
      if (event.sender !== win.webContents || event.senderFrame?.url !== pathToFileURL(ui).href) throw new Error('Untrusted E0 frame');
      return fn(...args);
    });
    handle('list', () => store!.listWorkspaces());
    handle('load', async id => { const snapshot = store!.loadWorkspace(identifier(id)); await delay(fault.loadDelayMs); return snapshot; });
    const persist = async (requests: unknown) => {
      if (!Array.isArray(requests) || requests.length < 1 || requests.length > 2) throw new Error('E0 transaction requires one or two documents');
      requests.forEach(validateSaveRequest);
      saveRequestCount++;
      const results = store!.saveAtomic(requests as SaveRequest[]);
      log('save-result', { requests: results });
      // Deliberately delay the acknowledgement, not the synchronous durable transaction.
      await delay(fault.saveDelayMs); return results;
    };
    handle('save', async request => (await persist([request]))[0]);
    handle('saveAtomic', persist);
    handle('resolveReference', ref => { validateSourceReference(ref); return store!.resolveReference(ref); });
    handle('poll', () => ({ at: Date.now(), isolated: true, networkBlocked: true, saveRequestCount, workspaces: store!.listWorkspaces().map(w => ({ id: w.id, draftRevision: w.draftRevision, mapRevision: w.mapRevision })) }));
    handle('setFault', (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fault configuration');
      for (const [key, v] of Object.entries(value)) {
        if (key === 'failNext') { if (typeof v !== 'boolean') throw new Error('Invalid failure toggle'); if (v) store!.injectFailureOnce(); }
        else if (key === 'saveDelayMs' || key === 'loadDelayMs') { if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 5000) throw new Error('Delay outside 0..5000'); fault[key] = v as number; }
        else throw new Error('Unknown fault option');
      }
      return { ...fault };
    });
    handle('exportXmind', async id => {
      const result = await exportXmind(store!.loadWorkspace(identifier(id)), { exportsDir: path.join(root, 'exports'), assetDir: root });
      log('export', { file: path.basename(result.path), sha256: result.sha256 }); return { path: result.path, bytes: result.bytes, sha256: result.sha256 };
    });
    handle('requestClose', action => {
      if (action === undefined) { win!.webContents.send('e0:close-request'); return; }
      if (!['saved', 'discard', 'cancel'].includes(action)) throw new Error('Invalid close decision');
      log('close-decision', { action });
      if (action !== 'cancel') { allowClose = true; setImmediate(() => app.quit()); }
    });
    win = new BrowserWindow({ width: 1480, height: 980, minWidth: 1000, minHeight: 700, title: 'E0 · 合成编辑隔离验证', webPreferences: { preload: path.join(project, 'dist/editor-e0/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setZoomFactor(1);
    win.webContents.on('before-input-event', (event, input) => {
      if ((input.meta || input.control) && ['+', '=', '-', '0'].includes(input.key)) event.preventDefault();
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => { if (!allowClose && !shuttingDown) { event.preventDefault(); win!.webContents.send('e0:close-request'); } });
    await win.loadFile(ui);
    await win.webContents.setVisualZoomLevelLimits(1, 1);
    win.setTitle(`E0 · 合成验证 [${path.basename(root)}]`);
    log('boot', { root, networkBlocked: true, runtime: process.versions.electron, node: process.versions.node });
    console.log(JSON.stringify({ event: 'e0-ready', root, profile: app.getPath('userData'), networkBlocked: true, pid: process.pid }));
    if (process.env.E0_IME_QA === '1') {
      app.focus({ steal: true }); win.show(); win.focus();
      win.webContents.on('console-message', details => {
        if (details.message.startsWith('E0_INPUT_EVENT:')) {
          try { const captured = JSON.parse(details.message.slice('E0_INPUT_EVENT:'.length)); log('native-input-observation', captured); }
          catch { /* ignore non-evidence console output */ }
        }
      });
      await win.webContents.executeJavaScript(`for (const kind of ['compositionstart','compositionupdate','compositionend','keydown','input']) document.addEventListener(kind, event => {
        if (!event.target.closest?.('.ProseMirror')) return;
        console.info('E0_INPUT_EVENT:'+JSON.stringify({kind, trusted:event.isTrusted, data:event.data??null, key:event.key??null, composing:event.isComposing??null, target:event.target.getAttribute('aria-label'), text:event.target.textContent}));
      },true);`);
    }
    if (process.env.E0_PROCESS_QA) {
      const runner = await import(pathToFileURL(path.join(project, 'spikes/editor-e0/process-probe.cjs')).href);
      const result = await (runner.runProcessProbe ?? runner.default.runProcessProbe)(win, { root, mode: process.env.E0_PROCESS_QA });
      console.log(JSON.stringify({ event: 'e0-process-probe', pid: process.pid, ...result }));
      if (result.exit) { allowClose = true; app.quit(); }
    }
    if (process.env.E0_UI_QA === '1') {
      const runner = await import(pathToFileURL(path.join(project, 'spikes/editor-e0/ui-regression.cjs')).href);
      try { const result = await (runner.runUiRegression ?? runner.default.runUiRegression)(win, { evidenceDir: path.join(root, 'evidence') }); console.log(JSON.stringify(result)); allowClose = true; app.quit(); }
      catch (error) { console.error(error); log('ui-qa-failed', { error: String(error) }); allowClose = true; shuttingDown = true; win.destroy(); store.close(); app.exit(1); }
    }
    if (process.env.E01_UI_QA === '1') {
      const runner = await import(pathToFileURL(path.join(project, 'spikes/editor-e0/e01-ui-regression.cjs')).href);
      try { const result = await (runner.runCanvasRegression ?? runner.default.runCanvasRegression)(win, { root, evidenceDir: path.join(root, 'evidence') }); console.log(JSON.stringify({event:'e01-ui-result',passed:result.passed,failed:result.failed,nodeCount:result.observations?.nodeCount})); allowClose = true; app.quit(); }
      catch (error) { console.error(error); log('e01-ui-qa-failed', { error: String(error) }); allowClose = true; shuttingDown = true; win.destroy(); store.close(); app.exit(1); }
    }
  }).catch(error => { console.error('E0 startup failed', error); allowClose = true; app.exit(1); });
  app.on('before-quit', event => {
    if (!allowClose && win && !win.isDestroyed() && !shuttingDown) { event.preventDefault(); win.webContents.send('e0:close-request'); return; }
    if (!shuttingDown) { shuttingDown = true; log('shutdown'); if (win && !win.isDestroyed()) win.destroy(); store?.close(); }
  });
  app.on('window-all-closed', () => { if (allowClose) app.quit(); });
  process.on('SIGTERM', () => { allowClose = true; app.quit(); });
}
