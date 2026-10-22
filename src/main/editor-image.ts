import { nativeImage } from 'electron';
import { readFileSync } from 'node:fs';
import { imageInfo, sha256 } from './editor-media.js';

/** Mac's image thumbnail service also decodes WebP, which Electron's buffer
 * nativeImage decoder does not. Callers supply only a bounded, owned local file.
 * Verify actual bytes on both sides of the asynchronous system decoder. */
export async function editorThumbnail(file: string, bytes: Buffer): Promise<Buffer> {
  const info = imageInfo(bytes), scale = Math.min(1, 256 / info.width, 256 / info.height);
  const width = Math.max(1, Math.round(info.width * scale)), height = Math.max(1, Math.round(info.height * scale));
  let decoded = nativeImage.createFromBuffer(bytes);
  if (decoded.isEmpty()) decoded = await nativeImage.createThumbnailFromPath(file, { width, height });
  if (decoded.isEmpty() || !decoded.getSize().width || !decoded.getSize().height) throw new Error('本地图片无法解码');
  if (sha256(readFileSync(file)) !== sha256(bytes)) throw new Error('本地图片版本已变化');
  return decoded.resize({ width, height, quality: 'good' }).toPNG();
}
