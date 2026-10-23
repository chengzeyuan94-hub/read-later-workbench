/** Cross-platform filesystem helpers for the main process. */
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';

/** Stored relative paths always use `/`, independent of the host separator. */
export function toStoredPath(relative: string): string { return relative.split(path.sep).join('/'); }

/** Resolve a stored (`/` separated) relative path inside `root`. */
export function joinStored(root: string, relative: string): string { return path.join(root, ...relative.split('/')); }

function retryable(error: unknown): boolean {
  return ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** Windows can EPERM/EBUSY a rename over an existing target (AV scan, open handle). */
export function renameSyncRetry(source: string, target: string, attempts = 8): void {
  for (let i = 0; ; i++) {
    try { renameSync(source, target); return; }
    catch (error) { if (i >= attempts - 1 || !retryable(error)) throw error; busyWait(20 + i * 30); }
  }
}

export async function renameRetry(source: string, target: string, attempts = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try { await rename(source, target); return; }
    catch (error) { if (i >= attempts - 1 || !retryable(error)) throw error; await sleep(20 + i * 30); }
  }
}

function busyWait(ms: number): void { const end = Date.now() + ms; while (Date.now() < end) { /* bounded spin for sync callers */ } }

/**
 * Durability helpers. Windows denies FlushFileBuffers on handles opened
 * read-only and cannot open directories for fsync at all: files are opened
 * for update, and directory fsync is a no-op (NTFS commits renames itself).
 */
export function fsyncFileSync(file: string): void {
  const fd = openSync(file, process.platform === 'win32' ? 'r+' : 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function fsyncDirectorySync(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, process.platform === 'win32' ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** NTFS comparison key: strip the \\?\ long-path prefix and fold case. */
export function ntfsPathKey(value: string): string {
  return value.replace(/^[/\\]{2}\?[/\\]/, '').toLowerCase();
}

/** Path equality for alias checks; NTFS is case-insensitive and may report \\?\ prefixes. */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? ntfsPathKey(a) === ntfsPathKey(b) : a === b;
}

/**
 * `file` names the real on-disk object: absolute, normalized, no component is a
 * link (checked explicitly, since a resolved path cannot reveal link spelling),
 * and the leaf is spelled with its canonical name. Comparing both sides through
 * realpath tolerates legitimate ancestor spellings — NTFS 8.3 names, case
 * variants, \\?\ prefixes — while still rejecting the leaf's own aliases.
 */
export function isCanonicalPath(file: string): boolean {
  if (!path.isAbsolute(file) || file !== path.normalize(file) || file === path.parse(file).root || file.endsWith(path.sep)) return false;
  try {
    let cursor = path.parse(file).root;
    for (const part of file.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return false;
    }
    return samePath(realpathSync(file), path.join(realpathSync(path.dirname(file)), path.basename(file)));
  } catch { return false; }
}

export async function isCanonicalPathAsync(file: string): Promise<boolean> {
  if (!path.isAbsolute(file) || file !== path.normalize(file) || file === path.parse(file).root || file.endsWith(path.sep)) return false;
  try {
    let cursor = path.parse(file).root;
    for (const part of file.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) return false;
    }
    return samePath(await realpath(file), path.join(await realpath(path.dirname(file)), path.basename(file)));
  } catch { return false; }
}

/** Windows reserved device names cannot be file basenames. */
const RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Sanitize one filename (not a path): Windows-illegal characters, reserved names, trailing dots/spaces. */
export function safeFilename(name: string, fallback = '文件'): string {
  const clean = name.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+$/, '');
  const base = clean.split('.')[0];
  return !clean || RESERVED_BASENAME.test(base) ? `${fallback}${clean ? `-${clean}` : ''}` : clean;
}
