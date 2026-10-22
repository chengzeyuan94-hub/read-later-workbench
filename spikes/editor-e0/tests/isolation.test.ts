import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeIsolationDirectory, validateIsolationDirectory, isolatedFile } from '../isolation.js';
test('explicit normalized isolation is mandatory, aliases and synthetic forbidden trees fail before writes', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e0-isolation-')));
  try {
    const allowed = path.join(tmp, 'isolated'); const forbidden = path.join(tmp, 'synthetic-production'); fs.mkdirSync(allowed); fs.mkdirSync(forbidden);
    const policy = { allowedRoot: allowed, forbiddenRoots: [forbidden] };
    for (const value of [undefined, '', '.', './relative', `${allowed}/../synthetic-production`, `${allowed}/`, forbidden]) assert.throws(() => initializeIsolationDirectory(value, policy));
    assert.deepEqual(fs.readdirSync(forbidden), []);
    fs.symlinkSync(forbidden, path.join(allowed, 'alias')); assert.throws(() => initializeIsolationDirectory(path.join(allowed, 'alias', 'child'), policy));
    fs.symlinkSync(allowed, path.join(tmp, 'same-root')); assert.throws(() => initializeIsolationDirectory(path.join(tmp, 'same-root', 'child'), policy));
    fs.symlinkSync(path.join(forbidden, 'not-created'), path.join(allowed, 'dangling')); assert.throws(() => initializeIsolationDirectory(path.join(allowed, 'dangling'), policy));
    const good = initializeIsolationDirectory(path.join(allowed, 'run'), policy);
    assert.equal(validateIsolationDirectory(good, policy), good); assert.ok(fs.existsSync(path.join(good, '.editor-e0.json')));
    assert.throws(() => isolatedFile(good, '../secret')); fs.symlinkSync(forbidden, path.join(good, 'escape')); assert.throws(() => isolatedFile(good, 'escape/file'));
    assert.deepEqual(fs.readdirSync(forbidden), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
