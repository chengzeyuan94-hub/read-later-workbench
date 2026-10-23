import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaToolCandidates, qaToolPath, resolveMediaTool, withExecutableSuffix } from '../src/main/media-tools.js';

test('withExecutableSuffix appends .exe only on Windows', () => {
  assert.equal(withExecutableSuffix('ffmpeg'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
});

test('media tool candidates follow env → bundled installer → .runtime/qa/package order', () => {
  const candidates = mediaToolCandidates('ffmpeg', '/custom/ffmpeg');
  assert.equal(candidates[0], '/custom/ffmpeg');
  const qa = qaToolPath('ffmpeg');
  assert.equal(candidates.at(-1), qa, 'the .runtime/qa/package staging path is last before PATH');
  const installer = candidates.find(c => c.includes(`@ffmpeg-installer${process.platform === 'win32' ? '\\' : '/'}`));
  assert.ok(installer, 'the npm installer package binary is a candidate');
  // env wins outright (the resolver requires the override to exist).
  const dir = mkdtempSync(path.join(tmpdir(), 'rlw-tools-'));
  try {
    const custom = path.join(dir, withExecutableSuffix('ffmpeg'));
    writeFileSync(custom, 'stub');
    assert.equal(resolveMediaTool('ffmpeg', custom), custom);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The dev environment resolves a real binary (bundled installer or QA staging).
  const resolved = resolveMediaTool('ffprobe');
  assert.ok(existsSync(resolved), `${resolved} must exist`);
  assert.ok(resolved.includes('ffprobe-installer') || resolved === qa, 'resolved from the bundled installer or QA staging');
});
