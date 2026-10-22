import { mkdirSync, copyFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import path from 'node:path';
if (!process.versions.node.startsWith('24.')) throw new Error('native:prepare requires Node 24');
mkdirSync('.runtime', {recursive:true});
// better-sqlite3 13 ships Node-API prebuilds. Verify both runtimes separately;
// no legacy V8 ABI rebuild or copying binaries out of the reference project.
const binding = `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`;
copyFileSync(binding,'.runtime/node24.node');
copyFileSync(binding,'.runtime/electron.node');
if (!existsSync('.runtime/node24.node')) throw new Error('Node binding missing');

// ASR media tests expect ffmpeg/ffprobe under .runtime/qa/package/. Provision them
// from RLW_FFMPEG / RLW_FFPROBE, PATH / common install locations, or the
// @ffmpeg-installer / @ffprobe-installer devDependency binaries.
const qaPackage = '.runtime/qa/package';
function findTool(name) {
  const envValue = process.env[`RLW_${name.toUpperCase()}`];
  if (envValue && existsSync(envValue)) return envValue;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', `${process.env.HOME}/.local/bin`];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  const bundled = `node_modules/@${name}-installer/${process.platform}-${process.arch}/${name}`;
  if (existsSync(bundled)) return bundled;
  return null;
}
mkdirSync(qaPackage, {recursive:true});
const missing = [];
for (const name of ['ffmpeg', 'ffprobe']) {
  const target = path.join(qaPackage, name);
  if (existsSync(target)) continue;
  const found = findTool(name);
  if (found) {
    copyFileSync(realpathSync(found), target);
    chmodSync(target, 0o755);
    console.log(`${name}: provisioned from ${found}`);
  } else missing.push(name);
}
if (missing.length) console.warn(`native:prepare: ${missing.join(', ')} not found; install ffmpeg (e.g. brew install ffmpeg) and re-run. ASR media tests will fail without them.`);
