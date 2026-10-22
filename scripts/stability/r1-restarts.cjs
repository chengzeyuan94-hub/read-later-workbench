// R1: restart idempotency — 10 consecutive cold starts on one scratch copy.
// Each start: boot evidence, zero renderer console errors, state() timing.
// After each exit: quick_check ok, foreign_key_check identical (the E4.6 audit
// ledgers intentionally keep references to purged rows — the violation set must
// be stable, never growing), and row counts identical across starts.
const fs = require('node:fs'), path = require('node:path'), Database = require('better-sqlite3');
const { launch } = require('./app-lib.cjs');

const build = process.env.RLW_BATCH_BUILD, root = process.env.RLW_BATCH_DIR;
const dbFile = path.join(root, 'data', 'workbench.sqlite');
const TABLES = ['contents', 'media', 'content_favorite_order', 'content_deletions', 'recent_import_targets'];
const HEARTBEAT_KEYS = /^(scheduler|lastCheck|nextCheck|lastTick|heartbeat|batchDigestTick|generationLeaseOwner)/i;

const snapshot = () => {
  const db = new Database(dbFile, { readonly: true });
  try {
    const out = { tables: {}, settings: {}, fk: [] };
    for (const table of TABLES) out.tables[table] = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    for (const row of db.prepare('SELECT key,value FROM settings').all()) if (!HEARTBEAT_KEYS.test(row.key)) out.settings[row.key] = row.value;
    out.fk = db.prepare('PRAGMA foreign_key_check').all().map(r => `${r.table}:${r.rowid}:${r.parent}`);
    out.quick = db.pragma('quick_check', { simple: true });
    return out;
  } finally { db.close(); }
};

(async () => {
  const failures = [];
  const baseline = snapshot();
  fs.writeFileSync('/tmp/stability/round-01/baseline.json', JSON.stringify(baseline, null, 2));
  const runtimeFile = path.join(root, 'evidence', 'runtime.jsonl');
  const bootCount = () => (fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf8') : '').split('\n').filter(l => l.includes('"event":"boot"')).length;
  const stateMs = [];
  for (let i = 1; i <= 10; i++) {
    const bootsBefore = bootCount();
    const app = await launch({ build, root, round: 'round-01' });
    try {
      const ms = await app.stateMs();
      stateMs.push(ms);
      const errors = await app.consoleErrors();
      if (errors.length) failures.push(`start ${i}: console errors ${JSON.stringify(errors.slice(0, 5))}`);
      if (bootCount() !== bootsBefore + 1) failures.push(`start ${i}: boot events ${bootsBefore} -> ${bootCount()}`);
    } finally { await app.quit(); app.restore(); }
    const snap = snapshot();
    if (snap.quick !== 'ok') failures.push(`start ${i}: quick_check=${snap.quick}`);
    if (JSON.stringify(snap.fk) !== JSON.stringify(baseline.fk)) failures.push(`start ${i}: foreign_key_check set changed (${snap.fk.length} vs ${baseline.fk.length})`);
    for (const table of TABLES) if (snap.tables[table] !== baseline.tables[table]) failures.push(`start ${i}: ${table} count ${snap.tables[table]} != ${baseline.tables[table]}`);
    if (JSON.stringify(snap.settings) !== JSON.stringify(baseline.settings)) {
      const changed = [...new Set([...Object.keys(snap.settings), ...Object.keys(baseline.settings)])].filter(k => snap.settings[k] !== baseline.settings[k]);
      failures.push(`start ${i}: settings changed: ${changed.map(k => `${k}: ${baseline.settings[k]} -> ${snap.settings[k]}`).join('; ')}`);
    }
    console.log(`start ${i}/10: state()=${stateMs[stateMs.length - 1]}ms quick=${snap.quick} fk=${snap.fk.length}`);
  }
  fs.writeFileSync('/tmp/stability/round-01/state-ms.json', JSON.stringify(stateMs));
  console.log('state() ms per start:', stateMs.join(', '));
  if (failures.length) { console.error('R1 FAILURES:\n' + failures.join('\n')); process.exit(1); }
  console.log('R1 restart idempotency clean (10/10)');
})().catch(e => { console.error('R1 ERROR:', e); process.exit(1); });
