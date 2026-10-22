import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOrdinaryOutput } from './e111-build-paths.mjs';

// Compilation is a build step. Electron spawns only the resulting executable.
if (process.platform !== 'darwin') throw new Error('Apple Vision OCR helper requires macOS');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'ocr-helper.swift');
const buildRoot = path.resolve(root, process.env.RLW_BUILD_DIR || 'dist/editor-e111');
const acceptanceRoot = path.join(root, '.acceptance-data', 'editor-e111');
if (buildRoot !== path.join(root, 'dist', 'editor-e111') && !buildRoot.startsWith(acceptanceRoot + path.sep)) {
  throw new Error('E1.1.1 helper output must use dist/editor-e111 or a new .acceptance-data/editor-e111 child; sealed older outputs are protected');
}
const outputDir = path.join(buildRoot, 'native');
assertOrdinaryOutput(outputDir);
const output = path.join(outputDir, 'ocr-helper');
// A stable basename also makes the linker's ad-hoc signature identifier stable.
const temporaryDir = path.join(outputDir, `.ocr-build-${process.pid}`);
const temporary = path.join(temporaryDir, 'ocr-helper');
const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!architecture) throw new Error(`Unsupported build architecture: ${process.arch}`);
const target = `${architecture}-apple-macos13.0`;
function run(args) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`OCR helper build failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trim();
}
mkdirSync(outputDir, { recursive: true });
mkdirSync(temporaryDir);
try {
  const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  const compiler = run(['swiftc', '--version']);
  const sdkPath = run(['--show-sdk-path']);
  const testing = process.env.RLW_OCR_HELPER_TESTING === '1';
  run(['swiftc', '-O', '-whole-module-optimization', '-module-name', 'ReadLaterOCRHelper', ...(testing ? ['-D', 'OCR_HELPER_TESTING'] : []), '-target', target, '-sdk', sdkPath, source, '-o', temporary]);
  chmodSync(temporary, 0o755);
  const probe = spawnSync(temporary, [], { input: JSON.stringify({ schemaVersion: 1, op: 'probe' }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const capability = JSON.parse(probe.stdout || '{}');
  if (probe.status !== 0 || capability.schemaVersion !== 1 || capability.ok !== true || capability.op !== 'probe') throw new Error('Built OCR helper capability probe failed');
  const binarySha256 = createHash('sha256').update(readFileSync(temporary)).digest('hex');
  if (capability.engine.helperSha256 !== binarySha256) throw new Error('Built OCR helper executable identity mismatch');
  if (createHash('sha256').update(readFileSync(source)).digest('hex') !== sourceSha256) throw new Error('OCR helper source changed during compilation; retry from one fixed source version');
  renameSync(temporary, output);
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(path.join(outputDir, 'build-manifest.json'), JSON.stringify({ schemaVersion: 1, target, compiler, testing,
    sdkVersion: run(['--show-sdk-version']), sourceSha256, executableSha256: hash(output), capability }, null, 2) + '\n');
  process.stdout.write(`Built Apple Vision OCR helper (${target}, revision ${capability.engine.revision})\n`);
} finally {
  rmSync(temporaryDir, { force: true, recursive: true });
}
