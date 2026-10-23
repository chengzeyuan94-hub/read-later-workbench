/** Isolated-copy upgrade/restore rehearsal only. This is deliberately not a
 * production upgrade entrypoint. Close the target E11 app before invoking it. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createE11Paths, resolveE11Paths } from '../src/main/e11-isolation.js';
import { fsyncDirectorySync, fsyncFileSync, isCanonicalPath } from '../src/main/fs-paths.js';
import { migrateEditorSchema } from '../src/main/editor-store.js';
import { boundedFile, sha256, sha256File } from '../src/main/editor-media.js';
import { resourceSnapshot, tableSnapshot, treeFiles, type E11File, type E11Table } from './audit-editor-e11.js';
type Row = Record<string, any>;
const binding = () => process.env.RLW_SQLITE_BINDING || path.resolve('.runtime/node24.node');
interface BackupManifest {
  kind: 'editor-e11-complete-backup'; version: 1; sourceRoot: string; inputSchema: 4 | 6; targetSchema: 7;
  createdAt: string; tables: Record<string, E11Table>; files: E11File[]; directories: string[];
  resourcesSha256: string; databaseConsistentSnapshot: true; noProfileCopied: true;
}
export interface E11UpgradeResult {
  kind: 'editor-e11-isolated-upgrade'; migrated: boolean; fromSchema: number; schema: 7;
  backup: string | null; backupManifestSha256: string | null; integrity: true;
  existingTablesPreserved: true; originalResourcesPreserved: true; requestAndCallRowsPreserved: true;
  productionUpgrade: false;
}
function syncFile(file: string): void { fsyncFileSync(file); }
function syncDirectory(file: string): void { fsyncDirectorySync(file); }
function writeJson(file: string, value: unknown): void { writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); syncFile(file); syncDirectory(path.dirname(file)); }
function directoryList(root: string, prefix: string): string[] {
  if (!existsSync(root)) return [];
  const result = [prefix];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    if (lstatSync(file).isSymbolicLink() || !isCanonicalPath(file)) throw new Error('完整备份拒绝符号链接或路径别名');
    if (entry.isDirectory()) result.push(...directoryList(file, path.posix.join(prefix, entry.name)));
    else if (!entry.isFile()) throw new Error('完整备份拒绝非普通文件');
  }
  return result;
}
function settingsSnapshot(db: Database.Database): string {
  return sha256(JSON.stringify(db.prepare("SELECT * FROM settings WHERE key<>'editorMigrationBackup' ORDER BY key").all()));
}
function assertTablesPreserved(before: Record<string, E11Table>, after: Record<string, E11Table>): void {
  for (const [name, snapshot] of Object.entries(before)) if (name !== 'settings' && JSON.stringify(after[name]) !== JSON.stringify(snapshot)) throw new Error(`升级改变既有表：${name}`);
}
function assertResourcesPreserved(before: E11File[], after: E11File[]): void {
  const found = new Map(after.map(file => [file.path, file]));
  for (const file of before) if (JSON.stringify(found.get(file.path)) !== JSON.stringify(file)) throw new Error('升级改变既有本地资源');
}
function validateBackup(backup: string): { manifest: BackupManifest; manifestSha256: string } {
  if (!path.isAbsolute(backup) || path.normalize(backup) !== backup || path.basename(path.dirname(backup)) !== 'upgrade-backups' || !/^upgrade-[0-9a-f-]+$/.test(path.basename(backup))) throw new Error('必须明确指定E11完整备份目录');
  const sourceRoot = path.dirname(path.dirname(backup)); resolveE11Paths(sourceRoot, { mustExist: true });
  if (lstatSync(backup).isSymbolicLink() || !isCanonicalPath(backup)) throw new Error('完整备份目录不能使用符号链接或别名');
  const manifestFile = boundedFile(backup, 'manifest.json'), bytes = readFileSync(manifestFile), manifest = JSON.parse(bytes.toString('utf8')) as BackupManifest;
  if (manifest.kind !== 'editor-e11-complete-backup' || manifest.version !== 1 || manifest.sourceRoot !== sourceRoot || ![4, 6].includes(manifest.inputSchema) || manifest.targetSchema !== 7 || !manifest.databaseConsistentSnapshot || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) throw new Error('完整备份清单无效');
  const actual = treeFiles(backup).filter(file => !['manifest.json', 'upgrade-result.json'].includes(file.path));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('完整备份文件、大小或SHA清单不符');
  for (const directory of manifest.directories) {
    if (!directory || path.isAbsolute(directory) || directory.split('/').some(part => !part || part === '.' || part === '..') || !statSync(path.join(backup, directory)).isDirectory()) throw new Error('完整备份目录清单无效');
  }
  const db = new Database(boundedFile(backup, 'data/workbench.sqlite'), { readonly: true, fileMustExist: true, nativeBinding: binding() });
  try {
    db.pragma('query_only=ON');
    if (db.pragma('user_version', { simple: true }) !== manifest.inputSchema || db.pragma('quick_check', { simple: true }) !== 'ok' || JSON.stringify(tableSnapshot(db)) !== JSON.stringify(manifest.tables)) throw new Error('完整备份数据库校验失败');
  } finally { db.close(); }
  return { manifest, manifestSha256: sha256(bytes) };
}

export async function upgradeE11(root: string, options: { failAfterSchema?: boolean; failAfterBackup?: boolean } = {}): Promise<E11UpgradeResult> {
  const p = resolveE11Paths(root, { mustExist: true }), database = path.join(p.dataDir, 'workbench.sqlite');
  // Unknown versions are rejected through a read-only connection before any
  // lock, backup directory, writable connection, or migration can be created.
  const check = new Database(database, { readonly: true, fileMustExist: true, nativeBinding: binding() });
  let version: number;
  try { version = Number(check.pragma('user_version', { simple: true })); if (![4, 6, 7].includes(version)) throw new Error('隔离升级仅接受schema 4或6到7；拒绝未知高版本'); if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('升级前数据库完整性检查失败'); } finally { check.close(); }
  if (version === 7) return { kind: 'editor-e11-isolated-upgrade', migrated: false, fromSchema: 7, schema: 7, backup: null, backupManifestSha256: null, integrity: true, existingTablesPreserved: true, originalResourcesPreserved: true, requestAndCallRowsPreserved: true, productionUpgrade: false };
  const lock = path.join(p.root, '.e11-upgrade.lock'), lockFd = openSync(lock, 'wx', 0o600);
  let db: Database.Database | undefined;
  try {
    db = new Database(database, { fileMustExist: true, nativeBinding: binding() });
    db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL');
    if (Number(db.pragma('user_version', { simple: true })) !== version) throw new Error('隔离库在检查后发生变化，请关闭应用再重试');
    const before = tableSnapshot(db), settings = settingsSnapshot(db), resources = resourceSnapshot(p.dataDir, p.assetsDir);
    const backups = path.join(p.root, 'upgrade-backups'); mkdirSync(backups, { recursive: true, mode: 0o700 });
    if (lstatSync(backups).isSymbolicLink() || !isCanonicalPath(backups)) throw new Error('备份目录不能使用符号链接或别名');
    const backup = path.join(backups, `upgrade-${randomUUID()}`); mkdirSync(backup, { mode: 0o700 });
    const directories = [...directoryList(p.dataDir, 'data'), ...directoryList(p.assetsDir, 'editor-assets')].sort();
    for (const directory of directories) mkdirSync(path.join(backup, directory), { recursive: true, mode: 0o700 });
    // SQLite backup is WAL-aware. The original DB is never copied piecemeal.
    const readonly = new Database(database, { readonly: true, fileMustExist: true, nativeBinding: binding() });
    try { await readonly.backup(path.join(backup, 'data/workbench.sqlite')); } finally { readonly.close(); }
    // A portable backup is one self-contained DB. Normalize only this new copy
    // to DELETE journaling before hashing, so later read-only verification does
    // not need to create WAL/SHM coordination files inside the frozen package.
    const standalone = new Database(path.join(backup, 'data/workbench.sqlite'), { fileMustExist: true, nativeBinding: binding() });
    try { standalone.pragma('journal_mode=DELETE'); standalone.pragma('synchronous=FULL'); } finally { standalone.close(); }
    for (const file of resources) {
      const source = file.path.startsWith('data/') ? boundedFile(p.dataDir, file.path.slice(5)) : boundedFile(p.assetsDir, file.path.slice(14));
      const destination = path.join(backup, file.path); copyFileSync(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); syncFile(destination);
      if (statSync(destination).size !== file.bytes || sha256File(destination) !== file.sha256) throw new Error('完整备份资源SHA校验失败');
    }
    copyFileSync(path.join(p.root, 'e11-isolated.json'), path.join(backup, 'e11-isolated.json'), constants.COPYFILE_EXCL);
    syncFile(path.join(backup, 'data/workbench.sqlite')); syncFile(path.join(backup, 'e11-isolated.json'));
    const manifest: BackupManifest = { kind: 'editor-e11-complete-backup', version: 1, sourceRoot: p.root, inputSchema: version as 4 | 6, targetSchema: 7, createdAt: new Date().toISOString(), tables: before, files: treeFiles(backup), directories, resourcesSha256: sha256(JSON.stringify(resources)), databaseConsistentSnapshot: true, noProfileCopied: true };
    writeJson(path.join(backup, 'manifest.json'), manifest);
    const verified = validateBackup(backup);
    if (JSON.stringify(tableSnapshot(db)) !== JSON.stringify(before) || JSON.stringify(resourceSnapshot(p.dataDir, p.assetsDir)) !== JSON.stringify(resources)) throw new Error('备份期间隔离库或资源发生变化，尚未升级');
    if (options.failAfterBackup) throw new Error('injected failure after complete backup');
    try { migrateEditorSchema(db, p.dataDir, { targetVersion: 7, failAfterSchema: options.failAfterSchema }); }
    catch (error) {
      if (db.pragma('user_version', { simple: true }) !== version || JSON.stringify(tableSnapshot(db)) !== JSON.stringify(before)) throw new Error('升级事务未完整回滚；已保留完整备份，请停止使用此隔离副本');
      throw error;
    }
    if (db.pragma('user_version', { simple: true }) !== 7 || db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('升级后数据库完整性检查失败；完整备份保留');
    assertTablesPreserved(before, tableSnapshot(db));
    if (settingsSnapshot(db) !== settings) throw new Error('升级改变既有设置');
    assertResourcesPreserved(resources, resourceSnapshot(p.dataDir, p.assetsDir));
    const result: E11UpgradeResult = { kind: 'editor-e11-isolated-upgrade', migrated: true, fromSchema: version, schema: 7, backup, backupManifestSha256: verified.manifestSha256, integrity: true, existingTablesPreserved: true, originalResourcesPreserved: true, requestAndCallRowsPreserved: true, productionUpgrade: false };
    writeJson(path.join(backup, 'upgrade-result.json'), result);
    return result;
  } finally { db?.close(); closeSync(lockFd); unlinkSync(lock); }
}

/** Restore into a fresh isolated root, preserving the upgraded source and all
 * saved versions there. Restoring never overwrites a live/existing directory. */
export function restoreE11Backup(backup: string, targetRoot: string): { restored: true; schema: number; root: string; backupManifestSha256: string; resourcesVerified: true } {
  const { manifest, manifestSha256 } = validateBackup(backup);
  const p = createE11Paths(targetRoot);
  for (const directory of manifest.directories) mkdirSync(path.join(p.root, directory), { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    if (file.path === 'e11-isolated.json') continue;
    const source = boundedFile(backup, file.path), destination = path.join(p.root, file.path);
    copyFileSync(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); syncFile(destination);
    if (statSync(destination).size !== file.bytes || sha256File(destination) !== file.sha256) throw new Error('完整恢复资源SHA校验失败；源备份与升级副本均保留');
  }
  const marker = JSON.parse(readFileSync(boundedFile(backup, 'e11-isolated.json'), 'utf8'));
  writeJson(path.join(p.root, 'e11-isolated.json'), { ...marker, root: p.root, restoredAt: new Date().toISOString(), restoredFromBackupManifestSha256: manifestSha256 });
  const db = new Database(path.join(p.dataDir, 'workbench.sqlite'), { readonly: true, fileMustExist: true, nativeBinding: binding() });
  try { db.pragma('query_only=ON'); if (db.pragma('user_version', { simple: true }) !== manifest.inputSchema || db.pragma('quick_check', { simple: true }) !== 'ok' || JSON.stringify(tableSnapshot(db)) !== JSON.stringify(manifest.tables)) throw new Error('完整恢复数据库校验失败'); } finally { db.close(); }
  for (const directory of [...manifest.directories].reverse()) syncDirectory(path.join(p.root, directory));
  syncDirectory(p.root);
  return { restored: true, schema: manifest.inputSchema, root: p.root, backupManifestSha256: manifestSha256, resourcesVerified: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.RLW_E11_UPGRADE_CONFIRM !== 'isolated-copy-only-no-running-app') throw new Error('仅用于已关闭应用的新E11隔离副本；需RLW_E11_UPGRADE_CONFIRM=isolated-copy-only-no-running-app，正式升级未授权');
  const result = process.env.RLW_E11_RESTORE_BACKUP ? restoreE11Backup(process.env.RLW_E11_RESTORE_BACKUP, process.env.RLW_E11_DIR!) : await upgradeE11(process.env.RLW_E11_DIR!);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
