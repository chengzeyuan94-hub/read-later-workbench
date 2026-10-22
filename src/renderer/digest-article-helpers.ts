import { findDraftBlock, isSafeLink, plainText, pointSlice, type AssetRef, type SourceReference, type WorkspaceBundle } from '../editor-core/model.js';
import type { DigestArtifactResult } from '../shared/digest-contracts.js';
export type ReadyDigestArtifact = Extract<DigestArtifactResult, { state: 'ready' }>;
export type DigestAttachment = ReadyDigestArtifact['attachments'][number];
/** No renderer-side path reconstruction or latest-image fallback. */
export function digestImageAttachment(ref: AssetRef, artifact: ReadyDigestArtifact): DigestAttachment | null {
  if (!/^[a-f0-9]{64}$/.test(ref.version)) return null;
  const fixed = artifact.bundle.assets.find(asset => asset.id === ref.assetId && asset.version === ref.version && asset.sha256 === ref.version);
  if (!fixed) return null;
  return artifact.attachments.find(attachment => attachment.sha256 === ref.version && /^image\/(?:png|jpeg|webp|gif)$/i.test(attachment.mime) && safeArtifactPath(attachment.relativePath)) || null;
}
export function safeArtifactPath(value: string): boolean {
  return !!value && !/[\u0000-\u001f\u007f\\]/.test(value) && !value.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !/%(?:2f|5c|2e)/i.test(value);
}
export const digestSafeLink = (value?: string): string | null => value && isSafeLink(value) ? value : null;
export function digestArticleVersions(artifact: ReadyDigestArtifact): { consistent: boolean; label: string } {
  const b = artifact.bundle, consistent = Number.isSafeInteger(artifact.draftRevision) && artifact.draftRevision > 0 && Number.isSafeInteger(artifact.mapRevision) && artifact.mapRevision > 0 && b.draft.workspaceId === b.workspace.id && b.map.workspaceId === b.workspace.id && b.draft.documentId === b.workspace.draftDocumentId && b.map.documentId === b.workspace.mindMapDocumentId && artifact.draftRevision === b.draft.revision && artifact.mapRevision === b.map.revision && b.workspace.draftRevision === b.draft.revision && b.workspace.mapRevision === b.map.revision;
  return { consistent, label: `固定成稿版本 · 整理稿 ${artifact.draftRevision} · 导图 ${artifact.mapRevision}` };
}
export interface DigestReferenceText { label: string; text: string | null; selectedText: string | null; before: string; after: string; exactInBundle: boolean; assets: AssetRef[]; originalUrl: string | null; unknownTime: boolean }
/** Resolves only exact versions present in this immutable generated bundle. */
export function digestReferenceText(ref: SourceReference, bundle: WorkspaceBundle): DigestReferenceText {
  let text: string | null = null, assets: AssetRef[] = [], originalUrl: string | null = null, label: string, unknownTime = false;
  if (ref.kind === 'capturedSource') {
    const source = bundle.sources.find(source => source.sourceId === ref.sourceId && source.sourceRevisionId === ref.sourceRevisionId), block = source && findDraftBlock(source.blocks, ref.blockId);
    if (block) { text = plainText(block.runs); assets = block.assetRefs || []; originalUrl = digestSafeLink(source?.originalUrl); } label = '来源原文 · 引用时版本';
  } else if (ref.kind === 'userDraft') {
    const block = ref.documentId === bundle.draft.documentId && ref.revision === bundle.draft.revision ? findDraftBlock(bundle.draft.blocks, ref.blockId) : undefined;
    if (block) { text = plainText(block.runs); assets = block.assetRefs || []; } label = `整理稿 · 引用版本 ${ref.revision}`;
  } else if (ref.kind === 'ocr') {
    label = `图片文字 · ${ref.correctionRevision === undefined ? '原始识别' : '校对版本 '+ref.correctionRevision}（需对应OCR资料）`;
  } else {
    const segment = bundle.transcripts.find(segment => segment.transcriptId === ref.transcriptId && segment.revision === ref.revision && segment.segmentId === ref.segmentId);
    if (segment) text = plainText(segment.runs); unknownTime = !segment?.timing || segment.timing.state === 'unknown'; label = `字幕文字 · 引用版本 ${ref.revision}`;
  }
  if (text === null) return { label, text: null, selectedText: ref.range?.excerpt || null, before: '', after: '', exactInBundle: false, assets: [...assets, ...(ref.assets || [])], originalUrl, unknownTime };
  const start = ref.range?.start || 0, end = ref.range?.end ?? Array.from(text).length;
  if (start < 0 || end > Array.from(text).length || end < start || ref.range?.excerpt !== undefined && pointSlice(text, start, end) !== ref.range.excerpt) return { label, text: null, selectedText: ref.range?.excerpt || null, before: '', after: '', exactInBundle: false, assets: [], originalUrl, unknownTime };
  return { label, text, selectedText: pointSlice(text, start, end), before: pointSlice(text, 0, start), after: pointSlice(text, end), exactInBundle: true, assets: [...assets, ...(ref.assets || [])], originalUrl, unknownTime };
}
