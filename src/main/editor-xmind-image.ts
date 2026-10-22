/** XMind receives an embedded PNG for WebP; fixed originals are never rewritten. */
import { readFile } from 'node:fs/promises';
import { imageInfo, sha256 } from './editor-media.js';

export type XmindWebpDecoder = (file: string, bytes: Buffer, size: { width: number; height: number }) => Promise<Buffer>;
export interface XmindImageResource { bytes: Buffer; mime: 'image/png' | 'image/jpeg'; width: number; height: number; sha256: string; converted: boolean }

/** Lazy Electron import keeps the bounded export mechanics independently testable in Node. */
async function decodeWebp(file: string, bytes: Buffer, size: { width: number; height: number }): Promise<Buffer> {
  const { nativeImage } = await import('electron');
  let decoded = nativeImage.createFromBuffer(bytes);
  // The macOS decoder used by the existing image picker understands saved WebP.
  // Request the original dimensions, not the small picker preview dimensions.
  if (decoded.isEmpty()) decoded = await nativeImage.createThumbnailFromPath(file, size);
  if (decoded.isEmpty()) throw new Error('节点图片无法解码；原图和当前稿件已保留');
  const actual = decoded.getSize();
  if (actual.width !== size.width || actual.height !== size.height) throw new Error('节点图片转换未能保留原尺寸；请使用 PNG／JPEG 节点图片');
  return decoded.toPNG();
}

/** file must be the exact owned path established with boundedFile + readFixedAsset. */
export async function prepareXmindImage(file: string, bytes: Buffer, decoder: XmindWebpDecoder = decodeWebp): Promise<XmindImageResource> {
  const info = imageInfo(bytes);
  if (!bytes.length || bytes.length > 24 * 1024 ** 2 || info.width <= 0 || info.height <= 0 || info.width * info.height > 60_000_000) throw new Error('节点图片尺寸或大小超过导出范围');
  const before = sha256(bytes);
  if (info.mime === 'image/png' || info.mime === 'image/jpeg') return { bytes, mime: info.mime, width: info.width, height: info.height, sha256: before, converted: false };
  if (info.mime !== 'image/webp') throw new Error('节点图片格式尚不支持；原图和当前稿件已保留');
  let converted: Buffer;
  try { converted = await decoder(file, bytes, { width: info.width, height: info.height }); }
  catch (error) { throw new Error(`WebP 节点图片转换失败；原图和当前稿件已保留${error instanceof Error && /原尺寸/.test(error.message) ? '（无法保留原尺寸）' : ''}`); }
  // The asynchronous system decoder cannot silently consume replaced bytes.
  if (sha256(await readFile(file)) !== before) throw new Error('节点图片原件在转换期间发生变化，请重新选择资料后导出');
  const result = imageInfo(converted);
  if (result.mime !== 'image/png' || result.width !== info.width || result.height !== info.height || converted.length > 32 * 1024 ** 2) throw new Error('节点图片转换结果的格式、尺寸或大小不符；未发布导出文件');
  return { bytes: converted, mime: 'image/png', width: result.width, height: result.height, sha256: sha256(converted), converted: true };
}
