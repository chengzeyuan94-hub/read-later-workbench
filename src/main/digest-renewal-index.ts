import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveE3RealPaths } from './e3-real-isolation.js';
import { sha256, sha256File } from './editor-media.js';

export const DIGEST_RENEWAL_INDEX_POLICY = 'terminal-history-v1' as const;
export const DIGEST_RENEWAL_INDEX_SQL = "CREATE UNIQUE INDEX digest_effective_request ON digest_requests(content_id) WHERE state NOT IN ('cancelled','complete','failed','result-unknown')";
export function hasTerminalDigestHistory(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='digest_effective_request'").get() as { sql: string } | undefined;
  return !!row && row.sql.replace(/\s+/g, '') === DIGEST_RENEWAL_INDEX_SQL.replace(/\s+/g, '');
}
/** Explicit preparation only. No table/column or user_version change; the index
 * policy is separately versioned, backed up and recorded in the new QA root. */
export function migrateDigestRenewalIndex(db: Database.Database, isolatedRoot: string, options: { failAfterDrop?: boolean } = {}) {
  const paths = resolveE3RealPaths(isolatedRoot, { mustExist: true });
  if (!/^quality-fix-[A-Za-z0-9_-]+$/.test(path.basename(paths.root)) || Number(db.pragma('user_version', { simple: true })) !== 9) throw Error('Index preparation only accepts an explicit new quality-fix schema9 root');
  const file = db.prepare('PRAGMA database_list').all().find((row: any) => row.name === 'main') as { file: string };
  if (file.file !== path.join(paths.dataDir, 'workbench.sqlite')) throw Error('Index preparation connection belongs to a different root');
  if (hasTerminalDigestHistory(db)) return { migrated: false, policyVersion: DIGEST_RENEWAL_INDEX_POLICY, tableFormatVersion: 9, backup: null };
  const before = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='digest_effective_request'").get() as any)?.sql;
  if (before?.replace(/\s+/g, '') !== "CREATE UNIQUE INDEX digest_effective_request ON digest_requests(content_id) WHERE state NOT IN ('cancelled','complete')".replace(/\s+/g, '')) throw Error('Unexpected old digest request index; do not replace an unknown schema');
  const records = () => sha256(JSON.stringify({ requests: db.prepare('SELECT * FROM digest_requests ORDER BY rowid').all(), stages: db.prepare('SELECT * FROM digest_stages ORDER BY rowid').all(), calls: db.prepare('SELECT * FROM generation_calls ORDER BY rowid').all() }));
  const recordsBefore = records(), backup = path.join(paths.dataDir, `workbench-pre-terminal-history-${randomUUID()}.sqlite`);
  db.prepare('VACUUM INTO ?').run(backup);
  const backupSha256 = sha256File(backup);
  db.transaction(() => {
    db.exec('DROP INDEX digest_effective_request'); if (options.failAfterDrop) throw Error('injected index transaction interruption');
    db.exec(DIGEST_RENEWAL_INDEX_SQL);
    if (!hasTerminalDigestHistory(db) || records() !== recordsBefore || db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw Error('Index preparation verification failed');
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('digestRenewalIndexPolicy', DIGEST_RENEWAL_INDEX_POLICY);
  })();
  return { migrated: true, policyVersion: DIGEST_RENEWAL_INDEX_POLICY, tableFormatVersion: 9, backup, backupSha256, oldIndexSql: before, newIndexSql: DIGEST_RENEWAL_INDEX_SQL, protectedRecordsSha256: recordsBefore, oldRequestsRewritten: false };
}
