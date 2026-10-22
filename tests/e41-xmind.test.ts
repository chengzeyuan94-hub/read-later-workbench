import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { clone, type SourceReference } from '../src/editor-core/model.js';
import { exportEditorXmind, inspectEditorXmindBytes } from '../src/main/editor-xmind.js';
import { prepareXmindImage } from '../src/main/editor-xmind-image.js';
import { sha256 } from '../src/main/editor-media.js';
import { png, seed, repository, bundle, request, setup } from './e1-helpers.js';

// Synthesized container + injected decoder are mechanism tests, never native OCR/image evidence.
function webp(width = 360, height = 90): Buffer { const bytes = Buffer.alloc(32); bytes.write('RIFF'); bytes.writeUInt32LE(24, 4); bytes.write('WEBP', 8); bytes.write('VP8X', 12); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3); return bytes; }
function pngImage(width = 360, height = 90): Buffer {
  const chunk = (kind: string, data: Buffer) => { const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(kind, 4); data.copy(out, 8); let crc = 0xffffffff; for (const byte of out.subarray(4, out.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() { const f = setup(), contentId = seed(f.store), repo = repository(f.store), original = bundle(repo, contentId), out = path.join(f.root, 'exports'); mkdirSync(out); return { ...f, repo, contentId, original, out }; }
function addWebp(f: ReturnType<typeof fixture>) {
  const bytes = webp(); f.store.detailSaved(f.contentId, { body: '人工兼容验收稿', bodyComplete: true, mediaManifestComplete: true, media: [{ kind: 'image', remoteUrl: 'https://example.invalid/mechanism.webp', mime: 'image/webp', role: 'gallery' }] });
  const media = f.store.content(f.contentId)!.media[0]; writeFileSync(path.join(f.root, 'media', 'mechanism.webp'), bytes); f.store.downloadSaved(media.id, 'mechanism.webp', bytes.length, 'image/webp');
  const asset = f.repo.selectImage(f.original.workspace.id, media.id), map = clone(f.original.map); map.nodes[map.rootId].image = { assetId: asset.id, version: asset.version }; assert.equal(f.repo.save([request(map, 'webp-node')])[0].status, 'saved'); return asset;
}
function expected(f: ReturnType<typeof fixture>) { const b = f.repo.load(f.original.workspace.id).bundle; return { draftRevision: b.draft.revision, mapRevision: b.map.revision }; }

test('E4.1 WebP creates only a full-size PNG package derivative; proportion, original SHA and current map stay exact', async () => {
  const f = fixture(); try {
    const asset = addWebp(f), sourceFile = path.join(f.repo.assetsDir, asset.relativePath), before = JSON.stringify(f.repo.load(f.original.workspace.id)); let calls = 0;
    const result = await exportEditorXmind(f.repo, f.original.workspace.id, expected(f), path.join(f.out, '人工 WebP 🙂.xmind'), { decodeWebp: async (file, bytes, size) => { calls++; assert.equal(file, sourceFile); assert.equal(sha256(bytes), asset.sha256); assert.deepEqual(size, { width: 360, height: 90 }); return pngImage(); } });
    const archive = readFileSync(result.path!), inspected = inspectEditorXmindBytes(archive), files = unzipSync(archive), root = JSON.parse(strFromU8(files['content.json']))[0].rootTopic, binding = JSON.parse(strFromU8(files['rlw-export.json']));
    assert.equal(calls, 1); assert.equal(inspected.resources.length, 1); assert.equal(root.image.width, 320); assert.equal(root.image.height, 80); assert.equal(root.image.src, 'xap:' + inspected.resources[0].path); assert.match(inspected.resources[0].path, /\.png$/); assert.deepEqual(binding.imageConversions, [{ assetId: asset.id, sourceSha256: asset.sha256, outputSha256: sha256(pngImage()), width: 360, height: 90 }]);
    assert.equal(sha256(readFileSync(sourceFile)), asset.sha256); assert.equal(JSON.stringify(f.repo.load(f.original.workspace.id)), before); assert.deepEqual(readdirSync(f.out), ['人工 WebP 🙂.xmind']);
  } finally { f.close(); }
});

test('E4.1 original PNG stays verbatim; conversion failures, replacement during decode and invalid dimensions publish nothing', async () => {
  const f = fixture(); try {
    const file = path.join(f.root, 'original.png'); writeFileSync(file, png); const kept = await prepareXmindImage(file, png, async () => { throw Error('must not decode PNG'); }); assert.deepEqual(kept.bytes, png); assert.equal(kept.converted, false);
    const asset = addWebp(f), target = path.join(f.out, '已有成果.xmind'), source = path.join(f.repo.assetsDir, asset.relativePath), bytes = readFileSync(source); writeFileSync(target, 'KEEP USER FILE');
    for (const decodeWebp of [async () => { throw Error('bad pixel stream'); }, async () => pngImage(359, 90), async () => { writeFileSync(source, 'replaced while asynchronous'); return pngImage(); }]) {
      await assert.rejects(exportEditorXmind(f.repo, f.original.workspace.id, expected(f), target, { decodeWebp }), /转换|变化/); assert.equal(readFileSync(target, 'utf8'), 'KEEP USER FILE'); assert.deepEqual(readdirSync(f.out), ['已有成果.xmind']); writeFileSync(source, bytes);
    }
    unlinkSync(source); await assert.rejects(exportEditorXmind(f.repo, f.original.workspace.id, expected(f), target)); assert.deepEqual(readdirSync(f.out), ['已有成果.xmind']);
    writeFileSync(path.join(f.root, 'outside.webp'), bytes); symlinkSync(path.join(f.root, 'outside.webp'), source); await assert.rejects(exportEditorXmind(f.repo, f.original.workspace.id, expected(f), target), /符号链接/); assert.equal(readFileSync(target, 'utf8'), 'KEEP USER FILE');
  } finally { f.close(); }
});

test('E4.1 editable plain titles, uniform rich formatting, safe source links and explicit mixed-title fallback do not rewrite the saved map', async () => {
  const f = fixture(); try {
    const map = clone(f.original.map), root = map.nodes[map.rootId], source = f.original.sources[0]; root.title = [{ text: '中文🙂 第一行\n第二行', bold: true, italic: true }]; root.children = ['mixed', 'uniform']; root.style = { fill: '#FFF4B0', textColor: '#171717' };
    const captured: SourceReference = { kind: 'capturedSource', sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, blockId: source.blocks[0].id };
    map.nodes.mixed = { id: 'mixed', parentId: root.id, children: [], title: [{ text: '局部', bold: true }, { text: '普通', code: true, href: 'https://example.com/article?private=secret' }], notes: '人工普通备注\n保持换行', sourceRefs: [captured] };
    map.nodes.uniform = { id: 'uniform', parentId: root.id, children: [], title: [{ text: '完整', italic: true }, { text: '斜体', italic: true }], notes: '', sourceRefs: [] };
    assert.equal(f.repo.save([request(map, 'format-map')])[0].status, 'saved'); const before = JSON.stringify(f.repo.load(f.original.workspace.id));
    const result = await exportEditorXmind(f.repo, f.original.workspace.id, expected(f), path.join(f.out, '格式.xmind')), files = unzipSync(readFileSync(result.path!)), topic = JSON.parse(strFromU8(files['content.json']))[0].rootTopic;
    assert.equal(topic.id, root.id); assert.equal(topic.title, '中文🙂 第一行\n第二行'); assert.equal(topic.style.properties['fo:font-weight'], 'bold'); assert.equal(topic.style.properties['fo:font-style'], 'italic'); assert.deepEqual(topic.children.attached.map((x: any) => x.id), ['mixed', 'uniform']);
    assert.match(topic.children.attached[0].notes.plain.content, /人工普通备注\n保持换行/); assert.match(topic.children.attached[0].notes.plain.content, /局部粗体.*普通标题文字/); assert.match(topic.children.attached[0].notes.plain.content, /原收藏网页：https:\/\/www.xiaohongshu.com\/explore\/test/); assert.match(topic.children.attached[0].notes.plain.content, /标题网页链接：\nhttps:\/\/example.com\/article/); assert.doesNotMatch(strFromU8(files['content.json']), /private=secret|file:\/\/|rlw-media:/); assert.equal(topic.children.attached[1].style.properties['fo:font-style'], 'italic'); assert.equal(JSON.stringify(f.repo.load(f.original.workspace.id)), before);
    // A package consumer cannot accept injected image geometry or resource paths.
    const imageFiles = { ...files }; topic.image = { src: 'xap:resources/../../outside.png', width: 1, height: 1 }; imageFiles['content.json'] = strToU8(JSON.stringify([{ ...JSON.parse(strFromU8(files['content.json']))[0], rootTopic: topic }])); await assert.rejects(async () => inspectEditorXmindBytes(zipSync(imageFiles)), /资源/);
  } finally { f.close(); }
});
