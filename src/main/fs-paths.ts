/** Cross-platform filesystem helpers for the main process. */
import { renameSync } from 'node:fs';
import { rename } from 'node:fs/promises';
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

/** Windows reserved device names cannot be file basenames. */
const RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Sanitize one filename (not a path): Windows-illegal characters, reserved names, trailing dots/spaces. */
export function safeFilename(name: string, fallback = '文件'): string {
  const clean = name.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+$/, '');
  const base = clean.split('.')[0];
  return !clean || RESERVED_BASENAME.test(base) ? `${fallback}${clean ? `-${clean}` : ''}` : clean;
}
