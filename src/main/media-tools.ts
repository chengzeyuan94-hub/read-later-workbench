/** Resolve ffmpeg/ffprobe binaries across dev trees, packaged apps and host installs. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type MediaToolName = 'ffmpeg' | 'ffprobe';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function withExecutableSuffix(name: MediaToolName): string { return process.platform === 'win32' ? `${name}.exe` : name; }

/** The QA/test convention: a repo-local package directory populated by native:prepare. */
export function qaToolPath(name: MediaToolName): string { return path.resolve('.runtime/qa/package', withExecutableSuffix(name)); }

/** Candidate locations for a media tool, in priority order. */
export function mediaToolCandidates(name: MediaToolName, envValue?: string): string[] {
  const exe = withExecutableSuffix(name);
  const candidates: string[] = [];
  if (envValue) candidates.push(envValue);
  // Bundled @ffmpeg-installer / @ffprobe-installer binaries. In a packaged app the
  // file must be spawned from app.asar.unpacked, so prefer that variant first.
  // moduleDir is <root>/src/main in dev and <resources>/app.asar/dist/main packaged;
  // node_modules sits two levels up in both layouts.
  const installer = path.join(moduleDir, '..', '..', 'node_modules', `@${name}-installer`, `${process.platform}-${process.arch}`, exe);
  const unpacked = installer.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (unpacked !== installer) candidates.push(unpacked);
  candidates.push(installer);
  candidates.push(qaToolPath(name));
  return candidates;
}

/** env → bundled installer → .runtime/qa/package → PATH lookup by bare name. */
export function resolveMediaTool(name: MediaToolName, envValue?: string): string {
  for (const candidate of mediaToolCandidates(name, envValue)) if (existsSync(candidate)) return candidate;
  return withExecutableSuffix(name);
}
