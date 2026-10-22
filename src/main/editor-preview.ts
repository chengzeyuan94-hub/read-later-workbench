import { layoutTree, type Size } from '../editor-core/canvas.js';
import { plainText } from '../editor-core/model.js';
import type { EditorPreview } from '../shared/editor-contracts.js';
import type { EditorRepository } from './editor-store.js';
import { imageInfo, readFixedAsset } from './editor-media.js';

export const PREVIEW_CONFIG = 'e1-tree-v1';
const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
function lines(value: string): string[] {
  const result: string[] = []; let line = '', cells = 0;
  for (const point of value) {
    const width = point.codePointAt(0)! > 255 ? 2 : 1;
    if (point === '\n' || cells + width > 22) { result.push(line); line = ''; cells = 0; }
    if (point !== '\n') { line += point; cells += width; }
  }
  result.push(line); return result;
}
/** Saved-tree projection: no editor toolbar, selection, caret, transient fold or drag state. */
export function savedPreview(repository: EditorRepository, workspaceId: string, revision: number, configKey = PREVIEW_CONFIG): EditorPreview {
  if (configKey !== PREVIEW_CONFIG) throw new Error('预览配置不支持');
  const { bundle } = repository.load(workspaceId);
  if (bundle.map.revision !== revision) throw new Error('预览版本已更新，请重试');
  const cached = repository.previews().find(p => p.workspaceId === workspaceId && p.mapRevision === revision && p.configKey === configKey && p.state === 'ready');
  const identity = { workspaceId, mapRevision: revision, configKey };
  try {
    // A successful cached tree must not conceal a now missing/corrupt image.
    if (cached) {
      for (const node of Object.values(bundle.map.nodes)) if (node.image) {
        const asset = repository.asset(workspaceId, node.image);
        if (!asset) throw new Error('预览图片版本缺失');
        readFixedAsset(repository.assetsDir, asset);
      }
      return cached;
    }
    const measured = new Map<string, Size>(), labels = new Map<string, string[]>(), images = new Map<string, { href: string; width: number; height: number }>();
    for (const node of Object.values(bundle.map.nodes)) {
      const textLines = lines(plainText(node.title)); labels.set(node.id, textLines);
      let imageHeight = 0;
      if (node.image) {
        const asset = repository.asset(workspaceId, node.image);
        if (!asset) throw new Error('预览图片版本缺失');
        const info = imageInfo(readFixedAsset(repository.assetsDir, asset));
        const scale = Math.min(156 / info.width, 140 / info.height);
        const width = info.width * scale, height = info.height * scale;
        images.set(node.id, { href: `rlw-editor://local/${encodeURIComponent(workspaceId)}/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.version)}?thumbnail=1`, width, height });
        imageHeight = height + 10;
      }
      measured.set(node.id, { width: 194, height: Math.max(48, 22 + textLines.length * 20 + imageHeight) });
    }
    const layout = layoutTree(bundle.map, measured), dark = bundle.map.theme.id === 'dark';
    const bg = dark ? '#181b20' : '#f5f4ef', foreground = dark ? '#eeeeee' : '#202020';
    let body = '';
    for (const node of Object.values(bundle.map.nodes)) for (const childId of node.children) {
      const a = layout.nodes[node.id], b = layout.nodes[childId];
      body += `<path d="M${a.x + a.width},${a.y + a.height / 2}H${b.x - 24}V${b.y + b.height / 2}H${b.x}" fill="none" stroke="${foreground}" stroke-width="2"/>`;
    }
    for (const node of Object.values(bundle.map.nodes)) {
      const box = layout.nodes[node.id], image = images.get(node.id);
      body += `<g><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${node.style?.fill || (node.id === bundle.map.rootId ? '#fb8a39' : bg)}" stroke="${foreground}" stroke-width="2"/>`;
      labels.get(node.id)!.forEach((line, index) => {
        body += `<text x="${box.x + 12}" y="${box.y + 26 + index * 20}" font-size="14" font-family="sans-serif" fill="${node.style?.textColor || foreground}"${node.style?.bold ? ' font-weight="bold"' : ''}>${xml(line)}</text>`;
      });
      if (image) body += `<image href="${xml(image.href)}" x="${box.x + (box.width - image.width) / 2}" y="${box.y + box.height - image.height - 10}" width="${image.width}" height="${image.height}"/>`;
      body += '</g>';
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.bounds.width + 48} ${layout.bounds.height + 48}" role="img" aria-label="已保存导图预览"><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`;
    const preview: EditorPreview = { ...identity, state: 'ready', svg };
    if (!repository.putPreview(preview)) return { ...identity, state: 'failed', error: '保存版本已更新，请重试预览' };
    return preview;
  } catch {
    const preview: EditorPreview = { ...identity, state: 'failed', error: '导图预览未生成，本地图片可能缺失或损坏；已保存内容保留，可重试' };
    repository.putPreview(preview); return preview;
  }
}
