// Stability-campaign in-app control module. Written over qa/batch-live-control.cjs
// inside a scratch build for the duration of a round, then restored. Adds eval,
// screenshot, console-error capture and memory sampling on top of a command file.
const fs = require('node:fs'), path = require('node:path');
module.exports = async function ({ app, win, service, paths }) {
  const live = path.join(paths.evidenceDir, 'live');
  fs.mkdirSync(live, { recursive: true });
  const cmd = path.join(live, 'command.json');
  const consoleErrors = [];
  const consoleLog = path.join(live, 'console-errors.jsonl');
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) { // error / critical
      const safe = String(message).replace(/https?:\/\/\S+/g, '[url]').slice(0, 500);
      consoleErrors.push(safe);
      try { fs.appendFileSync(consoleLog, JSON.stringify({ at: Date.now(), message: safe }) + '\n'); } catch {}
    }
  });
  const done = (id, result) => { try { fs.writeFileSync(path.join(live, id + '.result.json'), JSON.stringify({ at: Date.now(), ...result }), { flag: 'wx' }); } catch {} };
  const tick = async () => {
    if (!fs.existsSync(cmd)) return;
    let input;
    try { input = JSON.parse(fs.readFileSync(cmd, 'utf8')); } catch { return; }
    try { fs.unlinkSync(cmd); } catch { return; }
    try {
      if (input.action === 'eval') {
        const r = await win.webContents.executeJavaScript(input.expression, true);
        done(input.id, { ok: true, result: r === undefined ? null : r });
      } else if (input.action === 'shot') {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(live, input.name), img.toPNG());
        done(input.id, { ok: true });
      } else if (input.action === 'resize') {
        win.setSize(input.w, input.h); win.center();
        await new Promise(r => setTimeout(r, 400));
        done(input.id, { ok: true });
      } else if (input.action === 'memory') {
        const metrics = app.getAppMetrics ? app.getAppMetrics() : [];
        const proc = process.memoryUsage();
        // Force a real GC in the renderer via CDP before reading the heap —
        // performance.memory otherwise reflects uncollected garbage.
        // performance.memory.usedJSHeapSize is quantized into coarse privacy
        // buckets by Blink — a small real change crossing a bucket boundary
        // reads as a multi-MB step. Runtime.getHeapUsage returns precise bytes.
        let heap = null;
        try {
          const dbg = win.webContents.debugger;
          if (!dbg.isAttached()) dbg.attach('1.3');
          await dbg.sendCommand('HeapProfiler.enable');
          await dbg.sendCommand('HeapProfiler.collectGarbage');
          const usage = await dbg.sendCommand('Runtime.getHeapUsage');
          heap = { used: usage.usedSize, total: usage.totalSize, precise: true };
          dbg.detach();
        } catch {}
        if (!heap) heap = await win.webContents.executeJavaScript('performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize} : null').catch(() => null);
        const dom = await win.webContents.executeJavaScript('({nodes:document.querySelectorAll("*").length,view:(document.querySelector("main h1,.e1-workspace,.e3-creation-workspace")||{textContent:""}).textContent.slice(0,40),cards:document.querySelectorAll(".content-card").length})').catch(() => null);
        done(input.id, { ok: true, result: { mainRss: proc.rss, heap, dom, metrics: metrics.map(m => ({ pid: m.pid, type: m.type, memoryKB: m.memory ? m.memory.workingSetSize : undefined, cpu: m.cpu ? m.cpu.percentCPUUsage : undefined })) } });
      } else if (input.action === 'heap-snapshot') {
        // CDP heap snapshot → JSON file under live/ for offline diffing.
        const dbg = win.webContents.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        const file = path.join(live, input.name || ('heap-' + Date.now() + '.heapsnapshot'));
        const stream = fs.createWriteStream(file);
        const onChunk = (_e, method, params) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') stream.write(params.chunk); };
        try {
          dbg.on('message', onChunk);
          await dbg.sendCommand('HeapProfiler.enable');
          await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
        } finally { dbg.off('message', onChunk); stream.end(); await new Promise(r => stream.once('finish', r)); dbg.detach(); }
        done(input.id, { ok: true, result: file });
      } else if (input.action === 'perf-metrics') {
        const dbg = win.webContents.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        try {
          await dbg.sendCommand('Performance.enable');
          const { metrics } = await dbg.sendCommand('Performance.getMetrics');
          const counters = await dbg.sendCommand('Memory.getDOMCounters');
          done(input.id, { ok: true, result: { metrics, counters } });
        } finally { dbg.detach(); }
      } else if (input.action === 'console-errors') {
        done(input.id, { ok: true, result: consoleErrors.splice(0) });
      } else if (input.action === 'state-ms') {
        const t0 = Date.now(); service.state(); done(input.id, { ok: true, result: Date.now() - t0 });
      } else if (input.action === 'quit') {
        done(input.id, { ok: true }); setTimeout(() => app.quit(), 200);
      } else done(input.id, { ok: false, error: 'unknown action' });
    } catch (e) { done(input.id, { ok: false, error: String(e && e.message || e).replace(/https?:\/\/\S+/g, '[url]').slice(0, 300) }); }
  };
  const t = setInterval(() => void tick(), 120); t.unref();
};
