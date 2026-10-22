import fs from 'node:fs';
import path from 'node:path';

export interface IsolationPolicy { allowedRoot: string; forbiddenRoots?: string[] }
export const E0_ROOT = path.resolve('.acceptance-data/editor-e0');
const inside = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + path.sep);
/** Resolve the existing ancestor before creating anything. Never follows an alias into another tree. */
function projectedRealPath(candidate: string): string {
  const tail: string[] = []; let existing = candidate;
  while (!fs.existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) throw new Error('No existing ancestor'); tail.unshift(path.basename(existing)); existing = parent; }
  return path.join(fs.realpathSync(existing), ...tail);
}
export function validateIsolationDirectory(value: unknown, policy: IsolationPolicy = { allowedRoot: E0_ROOT }): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value !== path.normalize(value) || value.endsWith(path.sep)) throw new Error('E0 requires an explicit normalized absolute RLW_E0_DIR');
  const allowed = path.resolve(policy.allowedRoot), realAllowed = projectedRealPath(allowed), resolved = projectedRealPath(value);
  if (!inside(value, allowed) || !inside(resolved, realAllowed) || value !== resolved || allowed !== realAllowed) throw new Error('E0 directory escapes isolation root or uses a path alias/symlink');
  for (const root of policy.forbiddenRoots ?? []) if (inside(value, path.resolve(root)) || inside(resolved, projectedRealPath(path.resolve(root)))) throw new Error('E0 directory overlaps a forbidden tree');
  // Reject even a symlink which resolves back into the same tree, and dangling links.
  let cursor = path.parse(value).root;
  for (const part of value.slice(cursor.length).split(path.sep)) { cursor = path.join(cursor, part); try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('E0 symbolic-link components are forbidden'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  return value;
}
export function initializeIsolationDirectory(value: unknown, policy?: IsolationPolicy): string {
  const root = validateIsolationDirectory(value, policy);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); validateIsolationDirectory(root, policy);
  const marker = path.join(root, '.editor-e0.json');
  if (fs.existsSync(marker)) { if (JSON.parse(fs.readFileSync(marker, 'utf8')).purpose !== 'synthetic-editor-e0') throw new Error('Invalid E0 isolation marker'); }
  else fs.writeFileSync(marker, JSON.stringify({ purpose: 'synthetic-editor-e0', schema: 1 }), { flag: 'wx', mode: 0o600 });
  for (const name of ['profile', 'assets', 'exports', 'evidence']) { const dir = path.join(root, name); validateIsolationDirectory(dir, policy); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  return root;
}
export function isolatedFile(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '.' || x === '..' || !x)) throw new Error('Unsafe relative E0 file');
  const file = path.join(root, relative); const real = projectedRealPath(file);
  if (!inside(real, fs.realpathSync(root)) || real === root || real !== file) throw new Error('E0 file escaped its real root');
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('E0 file symlink rejected'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return file;
}
