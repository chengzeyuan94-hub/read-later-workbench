/** Product workspaces → the bounded, single-sheet XMind JSON subset. No E0 marker or importer. */
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { clone, plainText, pointSlice, referenceDescription, transcriptTimeDescription, validateMap, type ResolvedReference, type SourceReference, type WorkspaceBundle } from '../editor-core/model.js';
import type { EditorExportResult } from '../shared/editor-contracts.js';
import type { EditorRepository } from './editor-store.js';
import { exportFilename } from './editor-export.js';
import { boundedFile, imageInfo, readFixedAsset, sha256 } from './editor-media.js';
import { prepareXmindImage, type XmindWebpDecoder } from './editor-xmind-image.js';

interface Topic { id: string; class: 'topic'; title: string; notes?: { plain: { content: string } }; children?: { attached: Topic[] }; image?: { src: string; width: number; height: number }; href?: string; style?: { id: string; properties: Record<string, string> }; structureClass?: string }
export interface EditorXmindInspection { bytes: number; sha256: string; topics: number; resources: { path: string; sha256: string; bytes: number }[] }
const LIMIT = 64 * 1024 ** 2;
function publicUrl(raw: string): string | undefined {
  try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return; url.search = ''; url.hash = ''; return url.href; } catch { return; }
}
function safeEntry(name: string): void { if (!name || path.isAbsolute(name) || /[\\\0]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('导图包包含不安全的资源路径'); }
/** Validates the file produced here; this is not a general user-file XMind importer. */
export function inspectEditorXmindBytes(archive: Uint8Array): EditorXmindInspection {
  if (!archive.byteLength || archive.byteLength > LIMIT) throw new Error('导图包超过本轮大小上限');
  const seen = new Set<string>(); let expanded = 0;
  const files = unzipSync(archive, { filter: entry => { safeEntry(entry.name); if (seen.has(entry.name) || entry.originalSize > 32 * 1024 ** 2 || (expanded += entry.originalSize) > LIMIT || seen.size >= 256) throw new Error('导图包的条目或展开大小无效'); seen.add(entry.name); return true; } });
  const json = (name: string) => { if (!files[name]) throw new Error('导图包缺少必要条目'); return JSON.parse(strFromU8(files[name])); };
  const content = json('content.json'), metadata = json('metadata.json'), manifest = json('manifest.json'), binding = json('rlw-export.json');
  if (!Array.isArray(content) || content.length !== 1 || metadata?.dataStructureVersion !== '2' || binding?.kind !== 'editor-xmind-v1' || binding.schemaVersion !== 1 || !manifest?.['file-entries'] || typeof manifest['file-entries'] !== 'object') throw new Error('导图包结构校验失败');
  const manifestNames = Object.keys(manifest['file-entries']).sort(), expectedNames = Object.keys(files).filter(name => name !== 'manifest.json').sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(expectedNames)) throw new Error('导图包清单不完整');
  if (typeof content[0]?.id !== 'string' || !content[0].id || typeof content[0].title !== 'string' || content[0].class !== 'sheet') throw new Error('导图包工作表身份无效');
  const ids = new Set<string>([content[0].id]), referenced = new Set<string>(); let topics = 0;
  const visit = (topic: Topic, depth: number) => {
    if (depth > 50 || ++topics > 3000 || !topic || typeof topic.id !== 'string' || ids.has(topic.id) || typeof topic.title !== 'string' || topic.class !== 'topic') throw new Error('导图包节点层级或身份无效');
    ids.add(topic.id); if (topic.notes && typeof topic.notes.plain?.content !== 'string') throw new Error('导图包备注无效');
    if (topic.href && publicUrl(topic.href) !== topic.href) throw new Error('导图包链接不符合公开来源规则');
    if (topic.image) { const name = topic.image.src?.slice(4); if (!topic.image.src?.startsWith('xap:resources/') || !name || !files[name]) throw new Error('导图图片资源缺失'); safeEntry(name); const info = imageInfo(Buffer.from(files[name])); if (!Number.isSafeInteger(topic.image.width) || !Number.isSafeInteger(topic.image.height) || topic.image.width < 1 || topic.image.height < 1 || topic.image.width > info.width || topic.image.height > info.height || Math.abs(topic.image.width * info.height - topic.image.height * info.width) > Math.max(info.width, info.height)) throw new Error('导图图片显示尺寸或比例无效'); referenced.add(name); }
    const children = topic.children?.attached ?? []; if (!Array.isArray(children)) throw new Error('导图包子节点顺序无效'); children.forEach(child => visit(child, depth + 1));
  };
  visit(content[0].rootTopic, 0);
  const resources = Object.keys(files).filter(name => name.startsWith('resources/')).map(name => { if (!referenced.has(name) || !/^resources\/[a-f0-9]{64}\.(png|jpg)$/.test(name)) throw new Error('导图包图片归属无效'); const bytes = Buffer.from(files[name]), info = imageInfo(bytes), digest = sha256(bytes); if (name !== `resources/${digest}.${info.mime === 'image/jpeg' ? 'jpg' : 'png'}` || !['image/png', 'image/jpeg'].includes(info.mime) || info.width <= 0 || info.height <= 0) throw new Error('导图包图片摘要或格式无效'); return { path: name, sha256: digest, bytes: bytes.length }; });
  if (referenced.size !== resources.length || binding.nodeCount !== topics || binding.images?.length !== resources.length || resources.some(resource => !binding.images.some((image: any) => image.path === resource.path && image.sha256 === resource.sha256 && image.bytes === resource.bytes))) throw new Error('导图包版本或图片绑定不符');
  return { bytes: archive.byteLength, sha256: sha256(archive), topics, resources };
}
function sourceLinks(ref: SourceReference, bundle: WorkspaceBundle): string[] {
  const sources = ref.kind === 'capturedSource' ? bundle.sources.filter(source => source.sourceId === ref.sourceId && source.sourceRevisionId === ref.sourceRevisionId) : ref.kind === 'ocr' || ref.kind === 'transcript' ? bundle.sources : [];
  return [...new Set(sources.map(source => publicUrl(source.originalUrl)).filter((value): value is string => !!value))];
}
function sourceNote(ref: SourceReference, resolved: ResolvedReference, bundle: WorkspaceBundle): string {
  const descriptive = clone(ref); if (descriptive.range) { delete descriptive.range.excerpt; delete descriptive.range.before; delete descriptive.range.after; }
  const label = ref.kind === 'transcript' ? `转录 ${ref.transcriptId} / revision ${ref.revision} / 段 ${ref.segmentId}\n${resolved.transcript ? transcriptTimeDescription(resolved.transcript) : '句子时间 未知；不声明逐句播放位置'}${ref.range ? `\n引用选区(${ref.range.unit}) ${ref.range.start}–${ref.range.end}` : ''}` : referenceDescription(descriptive).replace('（Markdown保留图片及可读出处，不保留交互热区）', '（保存可读出处；原图行框在应用内定位）');
  const excerpt = pointSlice(resolved.selectedText, 0, 240), suffix = Array.from(resolved.selectedText).length > 240 ? '…（摘录已截短，原出处版本不变）' : '';
  const region = resolved.ocr ? `\n原图媒体 ${resolved.ocr.mediaId} / 原件 ${resolved.ocr.asset.version} / 方向归一化行级区域 ${resolved.ocr.regions.slice(0, 20).map(item => `${item.id}: ${item.bounds.x.toFixed(4)},${item.bounds.y.toFixed(4)},${item.bounds.width.toFixed(4)},${item.bounds.height.toFixed(4)}`).join('；')}${resolved.ocr.regions.length > 20 ? '；其余区域见应用内确切来源' : ''}` : '';
  const links = sourceLinks(ref, bundle);
  return `${label}${region}\n摘录：${excerpt}${suffix}${links.length ? '\n原收藏网页：' + links.join('\n') : ''}`;
}
async function exactDirectory(directory: string): Promise<void> { if (!path.isAbsolute(directory) || directory !== path.normalize(directory) || await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('导出父目录不存在或使用路径别名'); }
/** Exports the exact selected, already saved map. Failure never changes a prior user file. */
export async function exportEditorXmind(repository: EditorRepository, workspaceId: string, expected: { draftRevision: number; mapRevision: number }, chosenPath: string, options: { failAt?: 'after-write' | 'before-publish'; decodeWebp?: XmindWebpDecoder } = {}): Promise<EditorExportResult> {
  if (!path.isAbsolute(chosenPath) || chosenPath !== path.normalize(chosenPath) || /[\0\r\n]/.test(chosenPath)) throw new Error('导图导出位置无效');
  const loaded = repository.load(workspaceId), bundle: WorkspaceBundle = loaded.bundle;
  if (bundle.draft.revision !== expected.draftRevision || bundle.map.revision !== expected.mapRevision) throw new Error('保存版本已变化，请重新保存后导出导图');
  validateMap(bundle.map); const entries: Record<string, Uint8Array> = Object.create(null), images = new Map<string, { resource: string; width: number; height: number }>(), notes = new Map<string, string[]>(), imageConversions: { assetId: string; sourceSha256: string; outputSha256: string; width: number; height: number }[] = [], warnings = new Set<string>();
  const nodeCount = Object.keys(bundle.map.nodes).length; if (nodeCount > 3000) throw new Error('导图节点超过本轮可导出范围');
  let totalBytes = 0, textBytes = 0;
  // Resolve every reference, even when its source has no image; stale/damaged history cannot silently export.
  for (const node of Object.values(bundle.map.nodes)) {
    if (node.sourceRefs.length > 128 || Buffer.byteLength(node.notes) > 1024 ** 2 || Buffer.byteLength(plainText(node.title)) > 100_000) throw new Error('导图节点的备注或出处超过本轮可导出范围');
    const resolved = node.sourceRefs.map(ref => ({ ref, value: repository.resolve(workspaceId, ref) })), sourceNotes = resolved.map(item => sourceNote(item.ref, item.value, bundle)); notes.set(node.id, sourceNotes);
    textBytes += Buffer.byteLength(node.notes + plainText(node.title) + sourceNotes.join('\n')); if (textBytes > 8 * 1024 ** 2) throw new Error('导图文字与出处超过本轮导出大小上限');
    if (!node.image) continue; const key = `${node.image.assetId}@${node.image.version}`; if (images.has(key)) continue;
    const asset = repository.asset(workspaceId, node.image); if (!asset) throw new Error('导图需要的图片版本不存在');
    const bytes = readFixedAsset(repository.assetsDir, asset), file = boundedFile(repository.assetsDir, asset.relativePath), prepared = await prepareXmindImage(file, bytes, options.decodeWebp);
    if (imageInfo(bytes).mime !== asset.mime || (totalBytes += prepared.bytes.length) > 48 * 1024 ** 2) throw new Error('导图图片格式、尺寸或大小未通过校验');
    const resource = `resources/${prepared.sha256}.${prepared.mime === 'image/jpeg' ? 'jpg' : 'png'}`; entries[resource] = prepared.bytes; images.set(key, { resource, width: prepared.width, height: prepared.height });
    if (prepared.converted) imageConversions.push({ assetId: asset.id, sourceSha256: asset.sha256, outputSha256: prepared.sha256, width: prepared.width, height: prepared.height });
  }
  const links = [...new Set(bundle.sources.map(source => publicUrl(source.originalUrl)).filter((value): value is string => !!value))];
  const topic = (nodeId: string, depth: number): Topic => {
    if (depth > 50) throw new Error('导图层级超过本轮可导出范围');
    const node = bundle.map.nodes[nodeId], result: Topic = { id: node.id, class: 'topic', title: plainText(node.title) }, properties: Record<string, string> = {};
    const nodeNotes = [node.notes, ...notes.get(nodeId) ?? []];
    if (nodeId === bundle.map.rootId) nodeNotes.push(`来源：${links.join('\n') || '原始链接未取得'}\n已保存正文 revision ${bundle.draft.revision} / 导图 revision ${bundle.map.revision}\n基础可编辑节点与纯文字备注；高级布局、视图折叠及混合富文本样式按普通节点／纯文字降级。原音视频未包含。`);
    const titleLinks = [...new Set(node.title.map(run => run.href ? publicUrl(run.href) : undefined).filter((value): value is string => !!value))];
    if (titleLinks.length) nodeNotes.push('标题网页链接：\n' + titleLinks.join('\n'));
    const uniform = (field: 'bold' | 'italic') => { const values = new Set(node.title.filter(run => run.text.length).map(run => run[field] ?? node.style?.[field] ?? false)); return values.size === 1 ? [...values][0] : undefined; };
    const mixedTitle = (['bold', 'italic'] as const).some(field => new Set(node.title.filter(run => run.text.length).map(run => run[field] ?? node.style?.[field] ?? false)).size > 1) || node.title.some(run => run.code);
    if (mixedTitle) { const warning = '标题局部粗体／斜体或代码字体已降为普通标题文字；完整文字保留。'; warnings.add(warning); nodeNotes.push('兼容说明：' + warning); }
    const note = nodeNotes.filter(Boolean).join('\n\n'); if (note) result.notes = { plain: { content: note } };
    const href = node.sourceRefs.flatMap(ref => sourceLinks(ref, bundle))[0] ?? titleLinks[0]; if (href) result.href = href;
    const bold = uniform('bold'), italic = uniform('italic');
    if (bold !== undefined) properties['fo:font-weight'] = bold ? 'bold' : 'normal';
    if (italic !== undefined) properties['fo:font-style'] = italic ? 'italic' : 'normal';
    if (node.style?.fill) properties['svg:fill'] = node.style.fill; if (node.style?.textColor) properties['fo:color'] = node.style.textColor;
    if (Object.keys(properties).length) result.style = { id: `style-${node.id}`, properties };
    if (node.children.length) result.children = { attached: node.children.map(child => topic(child, depth + 1)) };
    if (node.image) { const image = images.get(`${node.image.assetId}@${node.image.version}`)!; const scale = Math.min(1, 320 / image.width, 240 / image.height); result.image = { src: `xap:${image.resource}`, width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) }; }
    return result;
  };
  const rootTopic = topic(bundle.map.rootId, 0); rootTopic.structureClass = 'org.xmind.ui.logic.right';
  const content = [{ id: bundle.map.sheetId, class: 'sheet', title: bundle.workspace.userTitle, rootTopic }];
  entries['content.json'] = strToU8(JSON.stringify(content)); entries['metadata.json'] = strToU8(JSON.stringify({ creator: { name: '收藏阅读工作台' }, dataStructureVersion: '2' }));
  entries['rlw-export.json'] = strToU8(JSON.stringify({ schemaVersion: 1, kind: 'editor-xmind-v1', workspaceId, draftRevision: bundle.draft.revision, mapRevision: bundle.map.revision, mapSha256: sha256(JSON.stringify(bundle.map)), nodeCount, imagePolicy: 'saved-png-jpeg-verbatim-webp-png-v1', imageConversions, images: Object.entries(entries).filter(([name]) => name.startsWith('resources/')).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })) }));
  entries['manifest.json'] = strToU8(JSON.stringify({ 'file-entries': Object.fromEntries(Object.keys(entries).map(name => [name, {}])) }));
  const archive = zipSync(entries, { level: 0 }); inspectEditorXmindBytes(archive);
  const parent = path.dirname(chosenPath); await exactDirectory(parent); const base = exportFilename(path.basename(chosenPath).replace(/\.xmind$/i, '')), temporary = path.join(parent, `.rlw-${randomUUID()}.xmind.part`); let published: string | undefined, identity: { ino: number; dev: number } | undefined;
  try {
    const fd = await open(temporary, 'wx', 0o600); try { await fd.writeFile(archive); await fd.sync(); const info = await fd.stat(); identity = { ino: info.ino, dev: info.dev }; } finally { await fd.close(); }
    if (options.failAt === 'after-write') throw new Error('injected XMind export write failure');
    const actual = await readFile(temporary); const inspected = inspectEditorXmindBytes(actual); if (inspected.sha256 !== sha256(archive)) throw new Error('导图临时文件摘要不符');
    if (options.failAt === 'before-publish') throw new Error('injected XMind export publication failure');
    await exactDirectory(parent);
    for (let index = 1; index <= 10000; index++) { const target = path.join(parent, `${base}${index === 1 ? '' : ` (${index})`}.xmind`); try { await link(temporary, target); published = target; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    if (!published) throw new Error('导图导出位置没有可用文件名');
    const directory = await open(parent, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    return { status: 'exported', path: published, files: 1, draftRevision: bundle.draft.revision, mapRevision: bundle.map.revision, ...(warnings.size ? { warnings: [...warnings] } : {}) };
  } catch (error) { if (published && identity) try { const info = await lstat(published); if (info.ino === identity.ino && info.dev === identity.dev) await unlink(published); } catch {} throw error; }
  finally { await unlink(temporary).catch(() => {}); }
}
