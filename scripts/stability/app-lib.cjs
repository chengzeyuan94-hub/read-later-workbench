// Shared app-level driver for the E4.10 stability campaign.
// Usage: const {launch} = require('./app-lib.cjs');
//   const app = await launch({ build, root, round: 'r1' }); ... await app.evalJs(...); app.shot(name); await app.quit();
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');

const CONTROL = path.join(__dirname, 'control-module.cjs');

async function launch({ build, root, round, w = 1440, h = 900, env: extra = {}, args = [] }) {
  if (!build || !root || !path.isAbsolute(build) || !path.isAbsolute(root)) throw Error('需要绝对 RLW_BATCH_BUILD / RLW_BATCH_DIR');
  const out = `/tmp/stability/${round}`;
  fs.mkdirSync(out, { recursive: true });
  const qaDir = path.join(build, 'qa'), qaFile = path.join(qaDir, 'batch-live-control.cjs'), qaBackup = qaFile + '.stab-bak';
  fs.copyFileSync(qaFile, qaBackup); fs.writeFileSync(qaFile, fs.readFileSync(CONTROL, 'utf8'));
  const live = path.join(root, 'evidence', 'live');
  fs.mkdirSync(live, { recursive: true });
  let seq = 0, child;
  // command.json is a single slot — serialize writers so concurrent callers
  // (e.g. R9's sampler + UI cycler) cannot overwrite an in-flight command.
  let chain = Promise.resolve();
  const cmd = (input, timeout = 20000) => {
    const run = () => new Promise((resolve, reject) => {
      const id = `st-${round}-${++seq}`, receipt = path.join(live, `${id}.result.json`), end = Date.now() + timeout;
      try { fs.unlinkSync(receipt); } catch {}
      fs.writeFileSync(path.join(live, 'command.json'), JSON.stringify({ id, ...input }));
      const poll = () => { if (fs.existsSync(receipt)) { const r = JSON.parse(fs.readFileSync(receipt, 'utf8')); return r.ok ? resolve(r.result) : reject(Error(r.error)); } if (Date.now() > end) return reject(Error('timeout ' + id)); if (child && child.exitCode !== null) return reject(Error('app exited')); setTimeout(poll, 100); };
      poll();
    });
    const out = chain.then(run, run);
    chain = out.catch(() => {});
    return out;
  };
  const env = { ...process.env, RLW_BATCH_DIR: root, RLW_BATCH_BUILD: build, RLW_BATCH_CONTROL: '1', RLW_BLOCK_NETWORK: '1', RLW_EVIDENCE_DIR: path.join(root, 'evidence'), ...extra };
  delete env.SILICONFLOW_API_KEY; delete env.DEEPSEEK_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
  const stderr = [];
  child = spawn(path.join(build, 'ReadLaterE42.app/Contents/MacOS/Electron'), [path.join(build, 'main/main.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => { const s = String(d); stderr.push(s.slice(0, 500)); if (!/Fontconfig|GPU|gl_surface|WARNING|ERROR:.*(bus|gpu|vulkan|dawn|Fontconfig)/i.test(s)) process.stderr.write(s); });
  const evalJs = expression => cmd({ action: 'eval', expression });
  const until = async (expression, label, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await evalJs(`!!(${expression})`)) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw Error('等待超时: ' + label); };
  await until('document.querySelectorAll(".content-card,.masonry,nav").length>0', 'app loaded', 60000);
  await cmd({ action: 'resize', w, h });
  const api = {
    child, pid: child.pid, out, live,
    evalJs, cmd, until,
    shot: async name => { await cmd({ action: 'shot', name: `st-${round}-${name}` }); fs.copyFileSync(path.join(live, `st-${round}-${name}`), path.join(out, name)); },
    nav: async label => { const r = await evalJs(`(()=>{const nav=document.querySelector('nav[aria-label=主导航]')||document;const e=[...nav.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)})&&!b.disabled);if(!e)return 'missing';e.click();return 'ok'})()`); if (r !== 'ok') throw Error('nav ' + label); await new Promise(r2 => setTimeout(r2, 800)); },
    memory: () => cmd({ action: 'memory' }),
    heapSnapshot: name => cmd({ action: 'heap-snapshot', name }, 120000),
    perfMetrics: () => cmd({ action: 'perf-metrics' }),
    consoleErrors: () => cmd({ action: 'console-errors' }),
    stateMs: () => cmd({ action: 'state-ms' }),
    quit: async () => { try { await cmd({ action: 'quit' }, 8000); } catch {} try { await new Promise(r => { const t = setTimeout(r, 5000); child.once('exit', r); if (child.exitCode !== null) { clearTimeout(t); r(); } }); } catch {} },
    kill9: () => { try { child.kill('SIGKILL'); } catch {} },
    stderr,
    restore: () => { try { fs.copyFileSync(qaBackup, qaFile); fs.unlinkSync(qaBackup); } catch {} },
  };
  return api;
}
module.exports = { launch };
