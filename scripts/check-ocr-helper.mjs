import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, ftruncateSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This native integration check creates synthetic images only. It never reads a
// library, profile, credentials, real image manifest, or running application.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.RLW_OCR_CHECK_DIR;
const allowed = path.join(project, '.acceptance-data', 'editor-e11');
if (!root || path.resolve(root) !== root || path.dirname(root) !== allowed || existsSync(root)) throw new Error('RLW_OCR_CHECK_DIR must name a fresh absolute child of .acceptance-data/editor-e11');
mkdirSync(root, { recursive: true, mode: 0o700 });
const fixtures = path.join(root, 'fixtures');
mkdirSync(fixtures, { mode: 0o700 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function command(file, args, extra = {}) {
  const p = spawnSync(file, args, { cwd: project, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...extra });
  if (p.error || p.status !== 0) throw new Error(`Native integration command failed: ${p.error?.message || p.stderr || p.status}`);
  return p.stdout;
}
for (const testing of [false, true]) {
  command(process.execPath, ['scripts/build-ocr-helper.mjs'], { env: { ...process.env, RLW_BUILD_DIR: path.join(root, testing ? 'test-build' : 'build'), RLW_OCR_HELPER_TESTING: testing ? '1' : '0' } });
}
command('xcrun', ['swift', 'native/ocr-fixtures.swift', fixtures]);
const helper = path.join(root, 'build', 'native', 'ocr-helper');
const testHelper = path.join(root, 'test-build', 'native', 'ocr-helper');
const checks = [], metrics = [], rawDir = path.join(root, 'raw');
mkdirSync(rawDir, { mode: 0o700 });
function invoke(name, request, { test = false, failSlice, success = true, code } = {}) {
  const p = spawnSync(test ? testHelper : helper, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 95_000, maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, ...(failSlice ? { RLW_OCR_TEST_FAIL_SLICE: failSlice } : {}) } });
  writeFileSync(path.join(rawDir, `${name}.json`), p.stdout || '', { mode: 0o600 });
  writeFileSync(path.join(rawDir, `${name}.stderr.txt`), p.stderr || '', { mode: 0o600 });
  assert.ifError(p.error); const output = JSON.parse(p.stdout);
  assert.equal(output.schemaVersion, 1); assert.equal(output.ok, success);
  assert.equal(p.status, success ? 0 : 1);
  if (code) assert.equal(output.error.code, code);
  if (output.metrics) metrics.push({ name, ...output.metrics });
  return output;
}
function request(file, op = 'recognize') {
  const bytes = readFileSync(path.join(fixtures, file));
  return { schemaVersion: 1, op, input: { root: fixtures, relativePath: file, expectedSha256: hash(bytes), expectedBytes: bytes.length,
    expectedMime: file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' } };
}
function check(name, run) { run(); checks.push({ name, passed: true }); }
const probe = invoke('probe', { schemaVersion: 1, op: 'probe' });
check('probe without image', () => { assert.ok(!probe.image && !probe.recognition); assert.ok(probe.engine.languages.includes('zh-Hans')); assert.ok(!probe.engine.testBuild); assert.equal(probe.engine.helperSha256, hash(readFileSync(helper))); });
check('probe refuses image input', () => invoke('probe-with-input', request('blank.png', 'probe'), { success: false, code: 'invalid-input' }));
const refs = JSON.parse(readFileSync(path.join(fixtures, 'references.json'), 'utf8'));
for (let orientation = 1; orientation <= 8; orientation++) {
  check(`JPEG EXIF orientation ${orientation}`, () => {
    const o = invoke(`orientation-${orientation}`, request(`orientation-${orientation}.jpg`));
    assert.equal(o.image.orientation, orientation); assert.equal(o.image.width, 1400); assert.equal(o.image.height, 1000);
    assert.equal(o.image.rawWidth, orientation >= 5 ? 1000 : 1400); assert.equal(o.image.rawHeight, orientation >= 5 ? 1400 : 1000);
    assert.equal(o.recognition.coverage, 'complete'); assert.equal(o.recognition.blocks.length, refs.orientation.length);
    for (const ref of refs.orientation) {
      const block = o.recognition.blocks.find(b => b.text === ref.text); assert.ok(block, `Missing orientation reference: ${ref.text}`);
      assert.ok(Math.abs(block.bounds.x * 1400 - 80) < 20); assert.ok(Math.abs(block.bounds.y * 1000 - ref.y) < 90);
      assert.ok(block.bounds.width > 0 && block.bounds.height > 0 && block.bounds.x + block.bounds.width <= 1 && block.bounds.y + block.bounds.height <= 1);
    }
  });
}
let long;
check('long image seams and repeated paragraphs', () => {
  long = invoke('long-seams', request('long-seams.png'));
  assert.equal(long.image.width, 1400); assert.equal(long.image.height, 8500); assert.equal(long.recognition.coverage, 'complete');
  assert.equal(long.recognition.slices.length, 3); assert.equal(long.recognition.blocks.length, refs.long.length);
  assert.equal(long.recognition.blocks.filter(b => b.text === 'REPEATED PARAGRAPH ALPHA').length, 2);
  for (const text of ['OVERLAP SEAM MUST SURVIVE', 'SECOND SEAM MUST SURVIVE']) assert.ok(long.recognition.text.includes(text));
  assert.ok(long.recognition.blocks.some(b => b.sliceIds.length > 1));
  for (const block of long.recognition.blocks) assert.ok(block.bounds.x >= 0 && block.bounds.y >= 0 && block.bounds.x + block.bounds.width <= 1 && block.bounds.y + block.bounds.height <= 1);
});
check('single slice failure preserves partial text', () => {
  const o = invoke('partial-slice', request('long-seams.png'), { test: true, failSlice: 'slice-1' });
  assert.equal(o.engine.testBuild, true); assert.equal(o.recognition.coverage, 'partial');
  assert.equal(o.recognition.slices.filter(s => s.status === 'failed').length, 1); assert.ok(o.recognition.blocks.length > 0);
  assert.notEqual(o.engine.configSha256, probe.engine.configSha256);
});
check('all slices failed is error', () => invoke('all-slices-failed', request('blank.png'), { test: true, failSlice: 'slice-0', success: false, code: 'recognition-failed' }));
check('production ignores test fault environment', () => {
  const o = invoke('production-fault-ignored', request('blank.png'), { failSlice: 'slice-0' }); assert.equal(o.recognition.coverage, 'no-text');
});
check('blank PNG is no-text', () => { const o = invoke('blank', request('blank.png')); assert.equal(o.recognition.coverage, 'no-text'); assert.equal(o.recognition.blocks.length, 0); });
check('inspect does not return recognition', () => { const o = invoke('inspect', request('orientation-6.jpg', 'inspect')); assert.equal(o.image.orientation, 6); assert.ok(!o.recognition); });
check('hash change rejected', () => { const q = request('blank.png'); q.input.expectedSha256 = '0'.repeat(64); invoke('hash-mismatch', q, { success: false, code: 'input-mismatch' }); });
check('MIME change rejected', () => { const q = request('blank.png'); q.input.expectedMime = 'image/jpeg'; invoke('mime-mismatch', q, { success: false, code: 'input-mismatch' }); });
check('orientation change rejected', () => { const q = request('orientation-6.jpg'); q.input.expectedOrientation = 1; invoke('orientation-mismatch', q, { success: false, code: 'input-mismatch' }); });
check('missing file rejected', () => { const q = request('blank.png'); q.input.relativePath = 'missing.png'; invoke('missing-file', q, { success: false, code: 'missing-file' }); });
check('bad file is not no-text', () => { writeFileSync(path.join(fixtures, 'bad.png'), 'not image'); invoke('bad-file', request('bad.png'), { success: false, code: 'unsupported-image' }); });
check('symlink rejected', () => { symlinkSync('blank.png', path.join(fixtures, 'alias.png')); invoke('symlink', request('alias.png'), { success: false, code: 'invalid-path' }); });
check('path traversal rejected', () => { const q = request('blank.png'); q.input.relativePath = '../fixtures/blank.png'; invoke('traversal', q, { success: false, code: 'invalid-path' }); });
check('file size limit rejected', () => {
  const fd = openSync(path.join(fixtures, 'large.png'), 'wx'); ftruncateSync(fd, probe.limits.maxInputBytes + 1); closeSync(fd);
  const q = request('blank.png'); q.input.relativePath = 'large.png'; invoke('file-limit', q, { success: false, code: 'input-limit' });
});
check('pixel limit rejected before decode', () => {
  const bytes = readFileSync(path.join(fixtures, 'blank.png')); bytes.writeUInt32BE(50001, 16); bytes.writeUInt32BE(1, 20);
  let crc = 0xffffffff; for (const byte of bytes.subarray(12, 29)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29); writeFileSync(path.join(fixtures, 'wide.png'), bytes);
  invoke('pixel-limit', request('wide.png'), { success: false, code: 'pixel-limit' });
});
check('unsupported language rejected', () => invoke('unsupported-language', { schemaVersion: 1, op: 'probe', config: { languages: ['made-up'] } }, { success: false, code: 'unsupported-languages' }));

const compact = text => text.replace(/\s/gu, '');
const references = refs.long.map(r => r.text), recognized = long.recognition.blocks.map(b => b.text);
const summary = { schemaVersion: 1, synthetic: true, realImageQualityEvidence: false, checks,
  longImage: { referenceLines: references.length, recognizedLines: recognized.length,
    exactTextMismatches: references.filter(ref => !recognized.includes(ref)).length,
    whitespaceNormalizedMismatches: references.filter(ref => !recognized.some(text => compact(text) === compact(ref))).length,
    repeatedParagraphs: recognized.filter(text => text === 'REPEATED PARAGRAPH ALPHA').length,
    slices: long.recognition.slices.length, multiSliceBlocks: long.recognition.blocks.filter(b => b.sliceIds.length > 1).length },
  metrics, engine: probe.engine,
  binding: Object.fromEntries(['native/ocr-helper.swift', 'native/ocr-fixtures.swift', 'scripts/build-ocr-helper.mjs', 'scripts/check-ocr-helper.mjs'].map(file => [file, hash(readFileSync(path.join(project, file)))])),
  helperSha256: hash(readFileSync(helper)), testHelperSha256: hash(readFileSync(testHelper)) };
writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ checksPassed: checks.length, synthetic: true, longImage: summary.longImage, peakHelperResidentBytes: Math.max(...metrics.map(m => m.peakResidentBytes)), summary: path.join(root, 'summary.json') }) + '\n');
