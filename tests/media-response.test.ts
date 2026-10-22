import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaResponse, mediaThumbnail, type NativeImageLike } from '../src/main/media.js';
import type { MediaRecord } from '../src/shared/contracts.js';

const rec = (localPath: string | null, mime = 'image/png', state = 'succeeded'): MediaRecord => ({ id: 42, contentId: 1, kind: 'image', mime, state: state as MediaRecord['state'], localPath, remoteUrl: 'https://x', bytes: 0, error: null, createdAt: 0, current: true } as MediaRecord);
const get = (url = 'http://local/42', headers: Record<string, string> = {}, method = 'GET') => new Request(url, { method, headers });

test('mediaResponse serves cache headers, ETag 304, range and path guards', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-media-'));
  try {
    await writeFile(path.join(dir, 'a.png'), Buffer.from('0123456789'));
    const res = await mediaResponse(get(), dir, rec('a.png'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'private, max-age=86400');
    assert.ok(res.headers.get('ETag'));
    assert.ok(res.headers.get('Last-Modified'));
    const etag = res.headers.get('ETag')!;
    await res.arrayBuffer();
    const cached = await mediaResponse(get('http://local/42', { 'if-none-match': etag }), dir, rec('a.png'));
    assert.equal(cached.status, 304);
    const partial = await mediaResponse(get('http://local/42', { range: 'bytes=2-5' }), dir, rec('a.png'));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('Content-Range'), 'bytes 2-5/10');
    assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [...Buffer.from('2345')]);
    assert.equal((await mediaResponse(get(), dir, rec('../escape.png'))).status, 403);
    assert.equal((await mediaResponse(get(), dir, rec('missing.png'))).status, 404);
    assert.equal((await mediaResponse(get('http://local/42', { range: 'bytes=99-' }), dir, rec('a.png'))).status, 416);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const fakeImage = (width: number, bytes = 'jpeg'): NativeImageLike => ({
  createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width, height: width }), resize: () => ({ toJPEG: () => Buffer.from(bytes) }) }),
});

test('mediaThumbnail respects the width allowlist and image-only rule', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-media-'));
  try {
    await writeFile(path.join(dir, 'a.png'), Buffer.from('0123456789'));
    assert.equal(await mediaThumbnail(dir, rec('a.png'), 999, { nativeImage: fakeImage(800) }), null, 'width outside allowlist');
    assert.equal(await mediaThumbnail(dir, rec('a.png', 'video/mp4'), 480, { nativeImage: fakeImage(800) }), null, 'non-image media');
    assert.equal(await mediaThumbnail(dir, rec('a.png', 'image/png', 'queued'), 480, { nativeImage: fakeImage(800) }), null, 'not succeeded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mediaThumbnail falls back on decode failure or small source, single-flights, keys by size+mtime', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-media-'));
  try {
    const file = path.join(dir, 'a.png');
    await writeFile(file, Buffer.from('0123456789'));
    let decodes = 0;
    const counting: NativeImageLike = { createFromPath: p => { decodes++; return fakeImage(800).createFromPath(p); } };
    const empty: NativeImageLike = { createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => ({ toJPEG: () => Buffer.alloc(0) }) }) };
    assert.equal(await mediaThumbnail(dir, rec('a.png'), 480, { nativeImage: empty }), null, 'decode failure falls back');
    assert.equal(await mediaThumbnail(dir, rec('a.png'), 960, { nativeImage: fakeImage(300) }), null, 'small source serves original');
    const [first, second] = await Promise.all([mediaThumbnail(dir, rec('a.png'), 480, { nativeImage: counting }), mediaThumbnail(dir, rec('a.png'), 480, { nativeImage: counting })]);
    assert.ok(first && second && first === second, 'both callers share the single flight');
    assert.equal(decodes, 1, 'decoded exactly once');
    assert.ok(first.endsWith('-w480.jpg') && existsSync(first), 'thumb file written');
    assert.equal((await stat(first)).size, 4);
    const stale = first;
    await new Promise(r => setTimeout(r, 30));
    await writeFile(file, Buffer.from('0123456789abcdef'));
    const fresh = await mediaThumbnail(dir, rec('a.png'), 480, { nativeImage: counting });
    assert.ok(fresh && fresh !== stale, 'size/mtime change produces a new key');
    assert.ok(existsSync(stale), 'stale thumb left behind');
    assert.ok(readdirSync(path.join(dir, '.thumbs')).every(f => f.startsWith('42-')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
