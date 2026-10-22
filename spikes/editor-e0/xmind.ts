/** Bounded single-sheet XMind JSON adapter; no proprietary client code. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { type WorkspaceBundle, type MindMapNode, type SourceReference, plainText, referenceDescription, validateBundle } from './model.js';
import { inspectXmindBytes, inspectXmindFile, type XmindInspection } from './inspect-xmind.js';
import { isolatedFile, validateIsolationDirectory } from './isolation.js';

export interface XmindExportOptions {
  /** exportsDir must be assetDir/exports; assetDir is the marked isolated root. */
  exportsDir: string;
  assetDir: string;
  filename?: string;
  signal?: AbortSignal;
  /** Explicit E0 fault injection, unavailable to the regular renderer IPC. */
  failureStage?: 'after-temp-write' | 'before-publish';
}
export interface XmindExportResult { path: string; bytes: number; sha256: string; inspection: XmindInspection }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('export cancelled'); }
async function exactDirectory(dir: string): Promise<string> {
  validateIsolationDirectory(dir);
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new Error('export/asset directory must be normalized absolute path');
  const canonical = await realpath(dir);
  if (canonical !== dir || !(await lstat(dir)).isDirectory()) throw new Error('directory aliases/symlinks are not accepted');
  return canonical;
}
async function assetBytes(root: string, relativePath: string): Promise<Buffer> {
  if (!relativePath || relativePath.includes('\\') || path.isAbsolute(relativePath) || relativePath.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe asset path');
  const target = path.join(root, relativePath);
  if (!target.startsWith(root + path.sep) || await realpath(target) !== target || (await lstat(target)).isSymbolicLink()) throw new Error('asset alias escapes isolated directory');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('invalid/oversized image asset'); return await file.readFile(); }
  finally { await file.close(); }
}
function publicLink(node: MindMapNode, bundle: WorkspaceBundle): string | undefined {
  for (const ref of node.sourceRefs) if (ref.kind === 'capturedSource') {
    const source = bundle.sources.find(s => s.sourceId === ref.sourceId && s.sourceRevisionId === ref.sourceRevisionId);
    if (!source) throw new Error('cannot export unresolved source version');
    const url = new URL(source.originalUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid public source URL');
    return url.href;
  }
  return undefined;
}
export async function exportXmind(bundle: WorkspaceBundle, options: XmindExportOptions): Promise<XmindExportResult> {
  validateBundle(bundle);
  cancelled(options.signal);
  const exportsDir = await exactDirectory(options.exportsDir);
  const assetDir = await exactDirectory(options.assetDir);
  if (exportsDir !== path.join(assetDir, 'exports')) throw new Error('export directory must be the same isolated root/exports');
  const marker = JSON.parse(await readFile(isolatedFile(assetDir, '.editor-e0.json'), 'utf8')) as { purpose?: unknown; schema?: unknown };
  if (marker.purpose !== 'synthetic-editor-e0' || marker.schema !== 1) throw new Error('export requires an E0 synthetic isolation marker');
  const filename = options.filename ?? 'editor-e0.xmind';
  if (filename !== path.basename(filename) || !filename.endsWith('.xmind') || !/^[\p{L}\p{N} _().-]+\.xmind$/u.test(filename)) throw new Error('filename must be a safe .xmind basename');
  const entries: Record<string, Uint8Array> = {};
  const images = new Map<string, string>();
  for (const node of Object.values(bundle.map.nodes)) if (node.image) {
    const key = `${node.image.assetId}\0${node.image.version}`;
    if (images.has(key)) continue;
    const asset = bundle.assets.find(a => a.id === node.image!.assetId && a.version === node.image!.version);
    if (!asset) throw new Error('missing image metadata');
    if (asset.mime !== 'image/png') throw new Error('E0 XMind export only supports the verified synthetic PNG subset');
    const bytes = await assetBytes(assetDir, asset.relativePath);
    if (hash(bytes) !== asset.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('image bytes/hash mismatch');
    const resource = `resources/${asset.sha256}.png`;
    entries[resource] = bytes;
    images.set(key, resource);
    cancelled(options.signal);
  }
  const topic = (id: string): Record<string, unknown> => {
    const node = bundle.map.nodes[id]!;
    const notes = [node.notes, ...node.sourceRefs.map(ref=>referenceDescription(ref,bundle))].filter(Boolean).join('\n\n');
    const properties: Record<string, string> = {};
    if (node.style?.bold !== undefined) properties['fo:font-weight'] = node.style.bold ? 'bold' : 'normal';
    if (node.style?.italic !== undefined) properties['fo:font-style'] = node.style.italic ? 'italic' : 'normal';
    if (node.style?.fill) properties['svg:fill'] = node.style.fill;
    if (node.style?.textColor) properties['fo:color'] = node.style.textColor;
    const result: Record<string, unknown> = { id, class: 'topic', title: plainText(node.title) };
    // A compatibility attempt, kept separately from whole-node style. Client evidence decides support.
    if (node.title.some(run => run.bold !== undefined || run.italic !== undefined || run.code)) result.attributedTitle = node.title.map(run => ({ text: run.text, ...(run.bold === undefined ? {} : { 'fo:font-weight': run.bold ? 'bold' : 'normal' }), ...(run.italic === undefined ? {} : { 'fo:font-style': run.italic ? 'italic' : 'normal' }), ...(run.code ? { 'fo:font-family': 'monospace' } : {}) }));
    if (Object.keys(properties).length) result.style = { id: `style-${id}`, properties };
    if (notes) result.notes = { plain: { content: notes } };
    const href = publicLink(node, bundle); if (href) result.href = href;
    if (node.children.length) result.children = { attached: node.children.map(topic) };
    if (node.image) result.image = { src: `xap:${images.get(`${node.image.assetId}\0${node.image.version}`)!}`, width: 320, height: 180 };
    return result;
  };
  const rootTopic = topic(bundle.map.rootId);
  rootTopic.structureClass = 'org.xmind.ui.logic.right';
  entries['content.json'] = strToU8(JSON.stringify([{ id: bundle.map.sheetId, class: 'sheet', title: bundle.workspace.userTitle, rootTopic }], null, 2));
  entries['metadata.json'] = strToU8(JSON.stringify({ creator: { name: 'read-later-workbench E0' }, dataStructureVersion: '2' }));
  entries['manifest.json'] = strToU8(JSON.stringify({ 'file-entries': Object.fromEntries(Object.keys(entries).map(name => [name, {}])) }));
  const archive = zipSync(entries, { level: 0 });
  inspectXmindBytes(archive);
  cancelled(options.signal);
  const temporary = path.join(exportsDir, `.${randomUUID()}.xmind.part`);
  let published: string | null = null;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(archive); await file.sync(); } finally { await file.close(); }
    if (options.failureStage === 'after-temp-write') throw new Error('injected export write failure');
    const inspection = await inspectXmindFile(temporary);
    if (inspection.sha256 !== hash(archive)) throw new Error('temporary export verification failed');
    if (options.failureStage === 'before-publish') throw new Error('injected export publication failure');
    cancelled(options.signal);
    // link publishes an already verified inode atomically and never overwrites an existing name.
    for (let suffix = 0; suffix < 10000; suffix++) {
      const candidate = path.join(exportsDir, suffix === 0 ? filename : `${filename.slice(0, -6)} (${suffix + 1}).xmind`);
      try { await link(temporary, candidate); published = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; cancelled(options.signal); }
    }
    if (!published) throw new Error('no available export filename');
    const dir = await open(exportsDir, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return { path: published, bytes: inspection.bytes, sha256: inspection.sha256, inspection };
  } finally { await unlink(temporary).catch(() => undefined); }
}
