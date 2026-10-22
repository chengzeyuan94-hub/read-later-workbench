/** Only snapshot copies are writable. This module never constructs a task repository. */
import Database from 'better-sqlite3';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveE3FixPaths } from '../src/main/e3-fix-isolation.js';
import { createE3RealPaths, resolveE3RealPaths } from '../src/main/e3-real-isolation.js';
import { sha256File } from '../src/main/editor-media.js';

type Row = Record<string, any>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mutableTables = new Set(['settings', 'digest_requests', 'digest_stages', 'ocr_jobs', 'asr_media_jobs', 'asr_chunks', 'asr_calls', 'generation_requests', 'generation_tasks', 'generation_calls', 'generation_edit_leases']);
const resourceDirectories = ['media', 'digest-inputs', 'ocr-results', 'digest-results', 'asr-results', 'asr-prepared', 'asr-inputs', 'generation-results', 'generation-responses'];

export async function cloneEditorE3Real(options: { source: string | undefined; target: string | undefined; projectRoot?: string; nativeBinding?: string }) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const fromFix = typeof options.source === 'string' && path.dirname(options.source) === path.resolve(projectRoot, '.acceptance-data/editor-e3-fix');
  const source = fromFix ? resolveE3FixPaths(options.source, { mustExist: true, projectRoot }) : resolveE3RealPaths(options.source, { mustExist: true, projectRoot });
  const sourceKind = fromFix ? 'readonly-e3-fix-to-real-snapshot' : 'readonly-e3-real-to-real-snapshot';
  const binding = options.nativeBinding ?? path.resolve(projectRoot, '.runtime/node24.node');
  const snapshot = new Database(path.join(source.dataDir, 'workbench.sqlite'), { readonly: true, fileMustExist: true, nativeBinding: binding });
  const counts: Record<string, number> = {}, protectedDigests: Record<string, string> = {};
  let target: ReturnType<typeof createE3RealPaths>;
  try {
    snapshot.pragma('query_only=ON');
    if (snapshot.pragma('user_version', { simple: true }) !== 10) throw Error('E3 real clone accepts prepared schema10 only');
    if (snapshot.pragma('quick_check', { simple: true }) !== 'ok' || (snapshot.pragma('foreign_key_check') as unknown[]).length) throw Error('Source snapshot integrity failed');
    // Whitelist from schema metadata, never from a command argument. All records,
    // including old calls/corrections/references, must survive the copy.
    for (const { name } of snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
      if (!/^[a-z_]+$/.test(name)) throw Error('Unexpected schema table');
      const rows = snapshot.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
      counts[name] = rows.length;
      if (!mutableTables.has(name)) protectedDigests[name] = hash(rows);
    }
    target = createE3RealPaths(options.target, { projectRoot });
    await snapshot.backup(path.join(target.dataDir, 'workbench.sqlite'));
  } finally { snapshot.close(); }

  const resources: { path: string; sha256: string; bytes: number }[] = [];
  function copyTree(from: string, to: string): void {
    if (realpathSync(from) !== from || lstatSync(from).isSymbolicLink()) throw Error('Source aliases refused');
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name), b = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw Error('Source links refused');
      if (entry.isDirectory()) copyTree(a, b);
      else if (entry.isFile()) {
        const sha = sha256File(a), bytes = statSync(a).size;
        copyFileSync(a, b, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        if (statSync(b).size !== bytes || sha256File(b) !== sha || sha256File(a) !== sha) throw Error('Snapshot SHA mismatch or source changed during copy');
        resources.push({ path: path.relative(target.root, b), sha256: sha, bytes });
      } else throw Error('Source non-regular resource refused');
    }
  }
  for (const name of resourceDirectories) if (existsSync(path.join(source.dataDir, name))) copyTree(path.join(source.dataDir, name), path.join(target.dataDir, name));
  copyTree(source.assetsDir, target.assetsDir);
  const relocate = (value: any): any => typeof value === 'string' && value.startsWith(source.dataDir + path.sep) ? target.dataDir + value.slice(source.dataDir.length) : Array.isArray(value) ? value.map(relocate) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
  const db = new Database(path.join(target.dataDir, 'workbench.sqlite'), { nativeBinding: binding });
  let paused: unknown[] = [];
  try {
    db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL');
    db.transaction(() => {
      paused = db.prepare("SELECT id,state,generation FROM digest_requests WHERE state NOT IN ('cancelled','complete','failed','result-unknown')").all();
      db.prepare("UPDATE digest_requests SET state='cancelled',generation=generation+1 WHERE state NOT IN ('cancelled','complete','failed','result-unknown')").run();
      db.prepare("UPDATE digest_stages SET state='cancelled',run_id=NULL WHERE request_id IN (SELECT id FROM digest_requests WHERE state='cancelled') AND state NOT IN ('succeeded','not-required','failed','result-unknown')").run();
      db.prepare("UPDATE ocr_jobs SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','no-text','failed','partial','cancelled')").run();
      db.prepare("UPDATE asr_media_jobs SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','failed','result-unknown','cancelled')").run();
      db.prepare("UPDATE asr_chunks SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','failed','result-unknown','cancelled')").run();
      db.prepare("UPDATE asr_calls SET status=CASE WHEN submitted=1 THEN 'result-unknown' ELSE 'interrupted-before-submit' END,finished_at=? WHERE status IN ('prepared','submitted')").run(Date.now());
      for (const table of ['asr_media_jobs', 'asr_chunks']) for (const row of db.prepare(`SELECT id,prepared_json FROM ${table} WHERE prepared_json IS NOT NULL`).all() as Row[]) db.prepare(`UPDATE ${table} SET prepared_json=? WHERE id=?`).run(JSON.stringify(relocate(JSON.parse(row.prepared_json))), row.id);
      db.prepare("UPDATE generation_requests SET state='cancelled' WHERE state NOT IN ('cancelled','succeeded','failed','result-unknown')").run();
      db.prepare("UPDATE generation_tasks SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','failed','result-unknown','cancelled')").run();
      db.prepare("UPDATE generation_calls SET status=CASE WHEN submitted=1 THEN 'result-unknown' ELSE 'interrupted-before-submit' END,finished_at=? WHERE status IN ('prepared','submitted')").run(Date.now());
      db.prepare('DELETE FROM generation_edit_leases').run();
      db.prepare("UPDATE settings SET value='false' WHERE key='autoSync'").run();
    })();
    if (db.pragma('user_version', { simple: true }) !== 10 || db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw Error('Snapshot integrity failed');
    for (const [table, count] of Object.entries(counts)) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      if (table !== 'generation_edit_leases' && rows.length !== count) throw Error('Snapshot lost records');
      if (protectedDigests[table] && hash(rows) !== protectedDigests[table]) throw Error('Snapshot changed protected records');
    }
  } finally { db.close(); }
  const preparedAt = new Date().toISOString();
  writeFileSync(path.join(target.root, 'e3-real-isolated.json'), JSON.stringify({ schema: 1, kind: 'read-later-workbench-editor-e3-real', databaseSchema: 10, root: target.root, preparedAt, source: { kind: sourceKind, root: source.root, counts }, networkBlockedRequired: true, processingNetworkRequiresExplicitSwitch: true, profileCopied: false, credentialsCopied: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const evidence = { source: source.root, sourceKind, target: target.root, counts, protectedDigests, resources, paused, migration: null, profileCopied: false, credentialsCopied: false, existingOutputsRetained: true, newUploads: 0, sourceReadOnly: true };
  writeFileSync(path.join(target.evidenceDir, 'e3-real-snapshot.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { prepared: true, root: target.root, counts, resources: resources.length, profileCopied: false, credentialsCopied: false, newUploads: 0 };
}
