// R2b: app-level crash recovery — launch on a scratch copy, kill -9 after a
// random 1–5s, relaunch, require quick_check ok and a clean boot each time.
const fs = require('node:fs'), path = require('node:path'), Database = require('better-sqlite3');
const { launch } = require('./app-lib.cjs');

const build = process.env.RLW_BATCH_BUILD, root = process.env.RLW_BATCH_DIR;
const dbFile = path.join(root, 'data', 'workbench.sqlite');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const failures = [];
  for (let i = 1; i <= 5; i++) {
    const app = await launch({ build, root, round: 'round-02' });
    await sleep(1000 + Math.floor(Math.random() * 4000));
    app.kill9();
    await new Promise(r => { const t = setTimeout(r, 5000); app.child.once('exit', r); if (app.child.exitCode !== null) { clearTimeout(t); r(); } });
    app.restore();
    // Relaunch: must boot cleanly.
    const app2 = await launch({ build, root, round: 'round-02' });
    try {
      const errors = await app2.consoleErrors();
      if (errors.length) failures.push(`iter ${i}: console errors after kill ${JSON.stringify(errors.slice(0, 3))}`);
      const db = new Database(dbFile, { readonly: true });
      try {
        const quick = db.pragma('quick_check', { simple: true });
        if (quick !== 'ok') failures.push(`iter ${i}: quick_check=${quick}`);
        // (running-row assertions belong to R2a — after relaunch the scheduler
        // legitimately redispatches queued work, so 'running' is expected.)
        const parts = fs.readdirSync(path.join(root, 'data', 'media')).filter(x => x.endsWith('.part'));
        if (parts.length) failures.push(`iter ${i}: leftover .part files ${parts.join(',')}`);
      } finally { db.close(); }
      console.log(`iter ${i}/5: clean`);
    } finally { await app2.quit(); app2.restore(); }
  }
  if (failures.length) { console.error('R2b FAILURES:\n' + failures.join('\n')); process.exit(1); }
  console.log('R2b app crash recovery clean (5/5)');
})().catch(e => { console.error('R2b ERROR:', e); process.exit(1); });
