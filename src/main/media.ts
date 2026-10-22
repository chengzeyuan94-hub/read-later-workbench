import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { MediaRecord } from '../shared/contracts.js';

/** Serve only the database-selected file under this application's real media root. */
export async function mediaResponse(request: Request, mediaDir: string, mediaRecord: MediaRecord | undefined): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (!mediaRecord || mediaRecord.state !== 'succeeded' || !mediaRecord.localPath) return new Response('本地资源尚未保存', { status: 404 });
  try {
    const root = await realpath(mediaDir);
    const candidate = path.resolve(root, mediaRecord.localPath);
    if (candidate === root || !candidate.startsWith(root + path.sep)) return new Response(null, { status: 403 });
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(root + path.sep)) return new Response(null, { status: 403 });
    const info = await stat(resolved);
    if (!info.isFile()) return new Response(null, { status: 404 });
    const etag = `"${mediaRecord.id}-${info.size}-${Math.floor(info.mtimeMs)}"`;
    const headers = new Headers({ 'Content-Type': mediaRecord.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', ETag: etag, 'Last-Modified': info.mtime.toUTCString() });
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return invalidRange(info.size);
      if (!match[1]) { const length = Number(match[2]); if (!Number.isSafeInteger(length) || length <= 0) return invalidRange(info.size); start = Math.max(0, info.size - length); }
      else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size || start < 0) return invalidRange(info.size);
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    headers.set('Content-Length', String(info.size === 0 ? 0 : end - start + 1));
    const body = request.method === 'HEAD' || info.size === 0 ? null : Readable.toWeb(createReadStream(resolved, { start, end })) as ReadableStream;
    return new Response(body, { status, headers });
  } catch { return new Response('本地资源不存在，请重新保存', { status: 404 }); }
}
function invalidRange(size: number): Response { return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } }); }

export const THUMB_WIDTHS = new Set([240, 480, 960]);
export interface NativeImageLike {
  createFromPath(file: string): { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(options: { width: number; quality: string }): { toJPEG(quality: number): Buffer } };
}
const thumbInflight = new Map<string, Promise<string | null>>();

/** Lazily built JPEG thumbnail under <mediaDir>/.thumbs keyed by id+size+mtime,
 *  so a retried/changed source gets a fresh thumb and stale ones are harmless.
 *  Returns the absolute path, or null to serve the original instead. */
export async function mediaThumbnail(mediaDir: string, record: MediaRecord, width: number, deps?: { nativeImage?: NativeImageLike }): Promise<string | null> {
  if (!THUMB_WIDTHS.has(width) || !record.localPath || !record.mime.startsWith('image/') || record.state !== 'succeeded') return null;
  const nativeImage = deps?.nativeImage ?? (await import('electron')).nativeImage as NativeImageLike;
  const root = await realpath(mediaDir);
  const candidate = path.resolve(root, record.localPath);
  if (candidate === root || !candidate.startsWith(root + path.sep)) return null;
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(root + path.sep)) return null;
  const info = await stat(resolved);
  if (!info.isFile()) return null;
  const dir = path.join(root, '.thumbs');
  const target = path.join(dir, `${record.id}-${info.size}-${Math.floor(info.mtimeMs)}-w${width}.jpg`);
  if (existsSync(target)) return target;
  const key = `${resolved}:${width}`;
  let flight = thumbInflight.get(key);
  if (!flight) {
    // The delete must ride a chained finally: a synchronously-completing flight
    // would otherwise delete the key before set() stores it.
    flight = (async () => {
      try {
        if (existsSync(target)) return target;
        const image = nativeImage.createFromPath(resolved);
        if (image.isEmpty()) return null;
        if (image.getSize().width <= width) return null;
        const jpeg = image.resize({ width, quality: 'good' }).toJPEG(82);
        if (!jpeg.length) return null;
        mkdirSync(dir, { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, jpeg);
        await rename(temporary, target);
        return target;
      } catch { return null; }
    })();
    thumbInflight.set(key, flight);
    void flight.finally(() => thumbInflight.delete(key));
  }
  return flight;
}
