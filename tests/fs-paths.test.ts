import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isCanonicalPath, joinStored, ntfsPathKey, renameSyncRetry, safeFilename, samePath, toStoredPath } from '../src/main/fs-paths.js';
import { exportFilename } from '../src/main/editor-export.js';
import { boundedFile } from '../src/main/editor-media.js';

// realpath first: on macOS TMPDIR itself is a symlink, which the bounded-root
// checks deliberately refuse.
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'rlw-fspaths-')));

test('safeFilename strips Windows-illegal characters, reserved names, and trailing dots or spaces', () => {
  assert.equal(safeFilename('note: 2024-01-01T12:30:00.md'), 'note_ 2024-01-01T12_30_00.md');
  assert.equal(safeFilename('a*b?c"d<e>f|g\\h'), 'a_b_c_d_e_f_g_h');
  assert.equal(safeFilename('CON'), '文件-CON');
  assert.equal(safeFilename('aux.txt'), '文件-aux.txt');
  assert.equal(safeFilename('name.'), 'name');
  assert.equal(safeFilename('...'), '文件');
  assert.equal(safeFilename(''), '文件');
  assert.equal(safeFilename('COM3.md'), '文件-COM3.md');
});

test('exportFilename keeps CJK names while remaining a safe portable basename', () => {
  assert.equal(exportFilename('我的 笔记: 第一稿? '), '我的 笔记_ 第一稿_');
  assert.equal(exportFilename('LPT1.md'), '整理稿-LPT1.md');
  assert.equal(exportFilename('normal title'), 'normal title');
  // The byte cap keeps long titles writable on every filesystem.
  const long = exportFilename(`${'藏'.repeat(200)}.md`);
  assert.ok(Buffer.byteLength(long) <= 140);
});

test('toStoredPath and joinStored round-trip POSIX database paths on every OS', () => {
  const native = path.join('a', 'b', 'c.png');
  assert.equal(toStoredPath(native), 'a/b/c.png');
  assert.equal(joinStored('/root', 'a/b/c.png'), path.join('/root', 'a', 'b', 'c.png'));
  // win32 semantics even when the suite runs on macOS/Linux.
  assert.equal(path.win32.join('C:\\root', ...'a/b/c.png'.split('/')), 'C:\\root\\a\\b\\c.png');
});

test('boundedFile resolves POSIX stored paths and still refuses escapes and symlinks', () => {
  const root = tmp();
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'sub', 'f.png'), 'x');
  assert.equal(boundedFile(root, 'sub/f.png'), path.join(root, 'sub', 'f.png'));
  assert.throws(() => boundedFile(root, '../outside'), /路径|目录|符号链接/);
  assert.throws(() => boundedFile(root, '/etc/passwd'), /路径|目录|符号链接/);
  rmSync(root, { recursive: true, force: true });
});

test('renameSyncRetry replaces an existing target atomically', () => {
  const root = tmp(), a = path.join(root, 'a.txt'), b = path.join(root, 'b.txt');
  writeFileSync(a, 'new'); writeFileSync(b, 'old');
  renameSyncRetry(a, b);
  assert.equal(statSync(b).size, 3);
  assert.throws(() => statSync(a));
  rmSync(root, { recursive: true, force: true });
});

test('renameSyncRetry propagates a permanent failure after retrying', () => {
  const root = tmp(), missing = path.join(root, 'missing.txt'), target = path.join(root, 't.txt');
  writeFileSync(target, 'old');
  const started = Date.now();
  assert.throws(() => renameSyncRetry(missing, target), /ENOENT/);
  assert.ok(Date.now() - started < 2000, 'permanent ENOENT must not retry for the full window');
  assert.equal(statSync(target).size, 3);
  rmSync(root, { recursive: true, force: true });
});

test('ntfsPathKey covers the \\?\\ prefix and case folding that samePath relies on', () => {
  // NTFS semantics written as win32 strings so the contract is pinned on every OS.
  assert.equal(ntfsPathKey('\\\\?\\C:\\Users\\Runner~1\\App'), 'c:\\users\\runner~1\\app');
  assert.equal(ntfsPathKey('C:\\Users\\RunnerAdmin'), 'c:\\users\\runneradmin');
  assert.equal(ntfsPathKey('\\\\server\\share\\Dir'), '\\\\server\\share\\dir');
});

test('isCanonicalPath accepts real directories, tolerates NTFS-style spelling only through samePath, and rejects link ancestors', () => {
  const root = tmp();
  assert.equal(isCanonicalPath(root), true);
  const nested = path.join(root, 'inner');
  mkdirSync(nested);
  assert.equal(isCanonicalPath(nested), true);
  // The leaf must be spelled canonically even when ancestors use valid alternates.
  assert.equal(isCanonicalPath(path.join(root, 'missing')), false);
  assert.equal(isCanonicalPath(`${nested}${path.sep}..${path.sep}inner`), false); // non-normalized
  assert.equal(isCanonicalPath(`${nested}${path.sep}`), false); // trailing separator
  assert.equal(isCanonicalPath('relative/path'), false);
    // Junctions work unprivileged on win32; skip silently if links are impossible.
    const target = path.join(root, 'real'), alias = path.join(root, 'alias');
    mkdirSync(target);
    try {
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : undefined);
      assert.equal(isCanonicalPath(alias), false);
      assert.equal(isCanonicalPath(path.join(alias, 'inner')), false);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
    }
  rmSync(root, { recursive: true, force: true });
});
