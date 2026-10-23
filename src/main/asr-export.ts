import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { samePath } from './fs-paths.js';
import { randomUUID } from 'node:crypto';
import { plainText, validateTranscript } from '../editor-core/model.js';
import type { AsrContentState, AsrDocument, AsrExportResult, AsrExportSelection } from '../shared/asr-contracts.js';
import { exportFilename } from './editor-export.js';
interface ExportRepository { read(contentId: number, resultId: string, revision?: number): AsrDocument; list(contentId: number): AsrContentState; digest: { internalScope(requestId: string): { sources: { originalUrl: string }[] } } }
const escaped = (text: string) => text.replace(/([\\`*_\[\]<>#|])/g, '\\$1');
function sourceUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('转录来源链接无效'); return (url.origin + url.pathname).replace(/[()\s]/g, value => value === '(' ? '%28' : value === ')' ? '%29' : encodeURIComponent(value)); }
/** Export only immutable, explicitly selected saved text versions. It never prepares or uploads media. */
export function exportAsrMarkdown(repository: ExportRepository, contentId: number, selection: AsrExportSelection[], chosenPath: string, options: { failAt?: 'after-write' | 'before-publish' } = {}): AsrExportResult {
  if (!Number.isSafeInteger(contentId) || contentId < 1 || !Array.isArray(selection) || !selection.length || selection.length > 1000 || !path.isAbsolute(chosenPath) || chosenPath !== path.normalize(chosenPath)) throw new Error('转录导出范围或位置无效');
  const parent = path.dirname(chosenPath); if (!existsSync(parent) || !samePath(realpathSync(parent), parent) || lstatSync(parent).isSymbolicLink()) throw new Error('导出父目录不存在或使用别名');
  const seen = new Set<string>(), documents: AsrDocument[] = [];
  for (const item of selection) {
    if (!item || Object.keys(item).some(key => !['resultId', 'version'].includes(key)) || !item.version || Object.keys(item.version).some(key => !['kind', 'revision'].includes(key)) || !['original', 'correction'].includes(item.version.kind) || !Number.isSafeInteger(item.version.revision) || item.version.kind === 'original' && item.version.revision !== 1 || item.version.kind === 'correction' && item.version.revision < 2) throw new Error('导出需要确切已保存的转录版本');
    const key = `${item.resultId}@${item.version.revision}`; if (seen.has(key)) continue; seen.add(key);
    const document = repository.read(contentId, item.resultId, item.version.revision), result = document.result, segment = document.correction?.segment ?? result.segment;
    if (result.contentId !== contentId || result.resultId !== item.resultId || (document.correction?.revision ?? 1) !== item.version.revision || (document.correction ? 'correction' : 'original') !== item.version.kind) throw new Error('导出转录身份或版本不符');
    validateTranscript(segment); if (plainText(segment.runs) !== (document.correction?.text ?? result.text) || segment.timing?.state !== 'unknown' || segment.timing.reason !== 'not-provided') throw new Error('转录文字版本或未知时间契约不符'); documents.push(document);
  }
  documents.sort((a, b) => a.result.mediaOrder - b.result.mediaOrder || a.result.chunkOrder - b.result.chunkOrder || a.result.createdAt - b.result.createdAt || a.result.resultId.localeCompare(b.result.resultId) || (a.correction?.revision ?? 1) - (b.correction?.revision ?? 1));
  const state = repository.list(contentId), selectedIds = new Set(documents.map(document => document.result.resultId));
  const allCurrent = documents.every(document => document.result.requestId === state.requestId), complete = allCurrent && state.progress.totalMedia > 0 && state.progress.preparedMedia === state.progress.totalMedia && state.progress.totalChunks > 0 && state.progress.succeeded === state.progress.totalChunks && state.jobs.every(job => job.state === 'succeeded' && !!job.resultId && selectedIds.has(job.resultId));
  let markdown = '# 音视频转录来源\n\n本文件是已保存原始转录／人工校对版本，不是自动整理或完整清洗成稿。供应商未提供逐句时间；输入分片范围仅描述实际上传音频，不能作为句子时间。\n\n';
  markdown += `导出覆盖：${complete ? '本次冻结请求的全部已完成输入分片（处理完成不表示字字正确）' : '部分／历史所选输入分片；不宣称本条全文覆盖'}。\n\n原音视频默认未包含。此文件不依赖应用私有 URL，可移动后离线阅读。\n\n`;
  for (const document of documents) {
    const result = document.result, correction = document.correction, version = correction?.revision ?? 1, scope = repository.digest.internalScope(result.requestId), links = [...new Set(scope.sources.map(source => sourceUrl(source.originalUrl)))];
    markdown += `## ${escaped(result.mediaTitle || `媒体 ${result.mediaId}`)} · ${escaped(result.partId)} · 输入分片 ${result.chunkOrder + 1}\n\n`;
    markdown += `${correction ? '人工校对' : '供应商原始转录（未校对）'} revision ${version}；转录 ID：${escaped(result.resultId)}；段 ID：${escaped((correction?.segment ?? result.segment).segmentId)}。\n\n`;
    markdown += `媒体身份：${result.mediaId} / ${escaped(result.sourceIdentity)} / ${escaped(result.partId)}。原件 SHA256：${result.originalSha256}；输入音频 SHA256：${result.audioSha256}。\n\n`;
    markdown += `原P输入范围：${result.inputRange.startMs}–${result.inputRange.endMs} ms（输入分片，非逐句时间）。此输入分片处理完成；供应商模型 ${escaped(result.provider.provider)} / ${escaped(result.provider.model)}，配置 ${result.provider.configSha256}。\n\n`;
    if (correction) markdown += `校对来源：原稿 ${escaped(result.resultId)} / revision 1；校对独立保留，未覆盖原始响应。\n\n`;
    markdown += escaped(correction?.text ?? result.text) + '\n\n来源：' + (links.length ? links.map(url => `[原收藏](${url})`).join('、') : '来源链接尚未保存') + '\n\n';
  }
  const base = exportFilename(path.basename(chosenPath).replace(/\.md$/i, '')), temporary = mkdtempSync(path.join(parent, '.rlw-asr-export-')), file = path.join(temporary, 'transcript.md');
  try {
    writeFileSync(file, markdown, { flag: 'wx', mode: 0o600 }); if (options.failAt === 'after-write') throw new Error('injected ASR export failure');
    if (readFileSync(file, 'utf8') !== markdown) throw new Error('导出文字落盘校验失败'); if (options.failAt === 'before-publish') throw new Error('injected ASR export failure');
    let target = path.join(parent, `${base}.md`);
    for (let attempt = 0; attempt < 20; attempt++) { try { linkSync(file, target); return { status: 'exported', path: target, files: 1 }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; target = path.join(parent, `${base}-${randomUUID().slice(0, 8)}.md`); } }
    throw new Error('同名导出文件较多，请更换名称后重试');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
