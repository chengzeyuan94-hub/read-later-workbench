import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { createFixtureBundle, sha256 } from '../fixtures.js';
import { exportXmind } from '../xmind.js';
import { inspectXmindBytes, inspectXmindFile } from '../inspect-xmind.js';
import { initializeIsolationDirectory } from '../isolation.js';

async function isolated() {
  const base = path.resolve('.acceptance-data/editor-e0/xmind-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-'));
  const exportsDir = path.join(root, 'exports');
  initializeIsolationDirectory(root);
  const bundle = createFixtureBundle('a');
  for (const asset of bundle.assets) { await mkdir(path.dirname(path.join(root, asset.relativePath)), { recursive: true }); await writeFile(path.join(root, asset.relativePath), Buffer.from(asset.bytesBase64!, 'base64')); }
  return { root, exportsDir, assetDir: root, bundle, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('shared editor map exports stable IDs/order, Chinese/emoji/newlines, rich runs, notes/link and verified reused image bytes', async () => {
  const env = await isolated();
  try {
    const before = JSON.stringify(env.bundle);
    const result = await exportXmind(env.bundle, env);
    const data = await inspectXmindFile(result.path);
    assert.equal(JSON.stringify(env.bundle), before);
    assert.equal(data.sha256, result.sha256);
    assert.equal(data.sheets.length, 1);
    const sheet = data.sheets[0]!;
    assert.equal(sheet.id, env.bundle.map.sheetId);
    assert.equal(sheet.nodes.length, 12);
    for (const node of sheet.nodes) {
      const original = env.bundle.map.nodes[node.id]!;
      assert.equal(node.title, original.title.map(run => run.text).join(''));
      assert.equal(node.parentId, original.parentId);
      assert.deepEqual(node.children, original.children);
    }
    const byId = Object.fromEntries(sheet.nodes.map(node => [node.id, node]));
    assert.equal(byId['e0-a-n5']!.title, byId['e0-a-n7']!.title);
    assert.notEqual(byId['e0-a-n5']!.id, byId['e0-a-n7']!.id);
    assert.match(byId['e0-a-n9']!.title, /\n/);
    assert.match(byId['e0-a-n6']!.title, /📚/);
    assert.equal(byId['e0-a-n11']!.href, 'https://example.com/');
    assert.match(byId['e0-a-n11']!.notes, /source-v1/);
    assert.match(byId['e0-a-n12']!.notes, /句子时间 未知/);
    assert.match(byId['e0-a-n12']!.notes, /来源范围 60000–120000ms（输入分片，非逐句时间）/);
    assert.match(byId['e0-a-n12']!.notes, /输入来源 synthetic/);
    assert.match(byId['e0-a-n12']!.notes, /引用文本：第一段纯文本/);
    assert.match(byId['e0-a-n9']!.notes, /引用文本：第二段纯文本/);
    assert.match(byId['e0-a-n6']!.notes, /时间 0–3500ms \/ 来源 synthetic \/ 粒度 sentence/);
    assert.equal(byId['e0-a-n8']!.attributedTitle[1]!['fo:font-weight'], 'bold');
    assert.equal(byId['e0-a-n8']!.style, null);
    assert.equal(data.resources.length, 1);
    assert.equal(data.resources[0]!.sha256, env.bundle.assets[0]!.sha256);
    assert.deepEqual(data.resources[0]!.referencedBy.sort(), ['e0-a-n10', 'e0-a-n5'].sort());
  } finally { await env.cleanup(); }
});

test('same-name concurrent exports publish complete unique files without overwriting an existing target', async () => {
  const env = await isolated();
  try {
    const prior = path.join(env.exportsDir, 'editor-e0.xmind');
    await writeFile(prior, 'KEEP ORIGINAL');
    const [a, b] = await Promise.all([exportXmind(env.bundle, env), exportXmind(env.bundle, env)]);
    assert.notEqual(a.path, b.path);
    assert.notEqual(a.path, prior);
    assert.equal(await readFile(prior, 'utf8'), 'KEEP ORIGINAL');
    assert.equal((await inspectXmindFile(a.path)).sheets[0]!.nodes.length, 12);
    assert.equal((await inspectXmindFile(b.path)).sheets[0]!.nodes.length, 12);
    assert.deepEqual((await readdir(env.exportsDir)).filter(name => name.endsWith('.part')), []);
  } finally { await env.cleanup(); }
});

test('cancel and injected write/publication failures preserve the original and remove partial files', async () => {
  const env = await isolated();
  try {
    const prior = path.join(env.exportsDir, 'editor-e0.xmind');
    await writeFile(prior, 'KEEP ORIGINAL');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(exportXmind(env.bundle, { ...env, signal: abort.signal }), /cancelled/);
    for (const stage of ['after-temp-write', 'before-publish'] as const) await assert.rejects(exportXmind(env.bundle, { ...env, failureStage: stage }), /injected/);
    assert.equal(await readFile(prior, 'utf8'), 'KEEP ORIGINAL');
    assert.deepEqual(await readdir(env.exportsDir), ['editor-e0.xmind']);
  } finally { await env.cleanup(); }
});

test('missing or changed on-disk images never produce an export success, despite embedded fixture bytes', async () => {
  const env = await isolated();
  try {
    const image = path.join(env.root, env.bundle.assets[0]!.relativePath);
    await rm(image);
    await assert.rejects(exportXmind(env.bundle, env), /ENOENT/);
    await writeFile(image, 'wrong bytes');
    await assert.rejects(exportXmind(env.bundle, env), /image bytes\/hash mismatch/);
    assert.deepEqual(await readdir(env.exportsDir), []);
  } finally { await env.cleanup(); }
});

test('asset symlinks, export aliases, traversal and unsafe target basenames are rejected', async () => {
  const env = await isolated();
  try {
    const realImage = path.join(env.root, env.bundle.assets[0]!.relativePath);
    const alias = path.join(env.root, 'exports-alias');
    await symlink(env.exportsDir, alias);
    await assert.rejects(exportXmind(env.bundle, { ...env, exportsDir: alias }), /alias\/symlink|aliases\/symlinks/);
    const other = path.join(env.root, 'copied.png'); await writeFile(other, await readFile(realImage));
    await rm(realImage); await symlink(other, realImage);
    await assert.rejects(exportXmind(env.bundle, env), /asset alias/);
    env.bundle.assets[0]!.relativePath = '../outside.png';
    await assert.rejects(exportXmind(env.bundle, env), /safe relative path/);
    env.bundle.assets[0]!.relativePath = 'assets/e0-a-image.png';
    await assert.rejects(exportXmind(env.bundle, { ...env, filename: '../bad.xmind' }), /safe .xmind basename/);
  } finally { await env.cleanup(); }
});

test('export requires a marked synthetic root and exactly its exports directory', async () => {
  const env = await isolated();
  try {
    const different = path.join(env.root, 'somewhere');
    await mkdir(different);
    await assert.rejects(exportXmind(env.bundle, { ...env, exportsDir: different }), /same isolated root\/exports/);
    const marker = path.join(env.root, '.editor-e0.json');
    await writeFile(marker, JSON.stringify({ purpose: 'unrelated-data', schema: 1 }));
    await assert.rejects(exportXmind(env.bundle, env), /synthetic isolation marker/);
    await rm(marker);
    await assert.rejects(exportXmind(env.bundle, env), /ENOENT/);
    assert.deepEqual(await readdir(env.exportsDir), []);
  } finally { await env.cleanup(); }
});

test('read-only inspection rejects missing embedded bytes and unsafe archive entries', async () => {
  const env = await isolated();
  try {
    const result = await exportXmind(env.bundle, env);
    const entries = unzipSync(await readFile(result.path));
    delete entries[result.inspection.resources[0]!.path];
    await assert.rejects(async () => inspectXmindBytes(zipSync(entries)), /manifest points to missing/);
    entries['../outside'] = strToU8('unsafe');
    assert.throws(() => inspectXmindBytes(zipSync(entries)), /unsafe archive entry/);
    assert.equal(sha256(await readFile(result.path)), result.sha256);
  } finally { await env.cleanup(); }
});
