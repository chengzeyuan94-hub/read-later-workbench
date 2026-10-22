import { plainText, pointLength, pointSlice, type DraftBlock, type MindMapDocument, type SourceReference, type TextRun, type TranscriptSegment } from '../editor-core/model.js';

export interface SubtitleVersion { key: string; transcriptId: string; revision: number; segments: TranscriptSegment[] }
/** Transcript IDs are content hashes, not dates. Never infer the current version from load order. */
export function sourceSubtitleVersions(transcripts: readonly TranscriptSegment[], workspaceId: string, currentSubtitle: string): { current: SubtitleVersion | null; versions: SubtitleVersion[] } {
  const grouped = new Map<string, SubtitleVersion>();
  for (const segment of transcripts) {
    if (segment.workspaceId !== workspaceId || segment.inputSource?.kind === 'plain-text-response' || segment.inputSource?.kind === 'manual-correction') continue;
    const key = `${segment.transcriptId}@${segment.revision}`;
    const version = grouped.get(key) ?? { key, transcriptId: segment.transcriptId, revision: segment.revision, segments: [] };
    version.segments.push(segment); grouped.set(key, version);
  }
  const versions = [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
  // Existing collected subtitles are one immutable full-text segment. Do not guess a
  // segment order or snapshot association for future multi-segment transcriptions.
  const matches = currentSubtitle ? versions.filter(version => version.segments.length === 1 && plainText(version.segments[0].runs) === currentSubtitle) : [];
  const current = matches.length === 1 ? matches[0] : null;
  return { current, versions: current ? [current, ...versions.filter(version => version !== current)] : versions };
}

/** Collapse is a view projection. The source document and every exported branch remain intact. */
export function visibleTree(map: MindMapDocument, collapsed: ReadonlySet<string>): MindMapDocument {
  const nodes: MindMapDocument['nodes'] = {};
  const visit = (id: string) => { const source = map.nodes[id]; const children = collapsed.has(id) ? [] : source.children; nodes[id] = { ...source, children }; children.forEach(visit); };
  visit(map.rootId); return { ...map, nodes };
}
export function revealNode(map: MindMapDocument, collapsed: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(collapsed); let parent = map.nodes[id]?.parentId; while (parent) { next.delete(parent); parent = map.nodes[parent]?.parentId; } return next;
}
export function treeOrder(map: MindMapDocument, collapsed: ReadonlySet<string> = new Set()): { id: string; depth: number }[] {
  const result: { id: string; depth: number }[] = []; const walk = (id: string, depth: number) => { result.push({ id, depth }); if (!collapsed.has(id)) map.nodes[id].children.forEach(child => walk(child, depth + 1)); }; walk(map.rootId, 0); return result;
}
export function excerptTitle(text: string, limit = 100): TextRun[] { const compact = text.replace(/\s+/gu, ' ').trim(); return [{ text: pointLength(compact) > limit ? `${pointSlice(compact, 0, limit)}…` : compact || '摘录' }]; }
export function blockById(blocks: DraftBlock[], id: string): DraftBlock | undefined { for (const block of blocks) { if (block.id === id) return block; const nested = block.children && blockById(block.children, id); if (nested) return nested; } return undefined; }
export function sourceRangeReference(base: Omit<Extract<SourceReference, { kind: 'capturedSource' }>, 'range'>, text: string, start: number, end: number): SourceReference {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > pointLength(text)) throw new Error('选区超出文本范围');
  return { ...base, range: { start, end, unit: 'unicode-code-point', excerpt: pointSlice(text, start, end), before: pointSlice(text, Math.max(0, start - 12), start), after: pointSlice(text, end, end + 12) } };
}
/** Only text/plain is accepted from an external clipboard. No internal identities are parsed. */
export function externalTextPreview(text: string): { lines: string[]; error?: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(value => value.trim()).filter(Boolean);
  if (pointLength(text) > 10000 || lines.length > 100) return { lines: [], error: '一次最多粘贴 100 行、10,000 字。请在整理稿中粘贴长文，再选择片段加入导图。' };
  if (!lines.length) return { lines: [], error: '剪贴板没有可加入的文字。' }; return { lines };
}
export interface DOMTextSelection { blockId: string; start: number; end: number; excerpt: string; kind: string; identity: string }
export function readSourceSelection(host: HTMLElement, selection: Selection | null): DOMTextSelection | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0); const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  const first = element(range.startContainer)?.closest<HTMLElement>('[data-source-block]'); const last = element(range.endContainer)?.closest<HTMLElement>('[data-source-block]');
  if (!first || !last || !host.contains(first) || !host.contains(last)) return null;
  if (first !== last) throw new Error('一次只能引用一个文本块。请缩小选区，不能跨段落加入。');
  const before = range.cloneRange(); before.selectNodeContents(first); before.setEnd(range.startContainer, range.startOffset);
  const through = range.cloneRange(); through.selectNodeContents(first); through.setEnd(range.endContainer, range.endOffset);
  return { blockId: first.dataset.sourceBlock!, identity: first.dataset.sourceIdentity!, kind: first.dataset.sourceKind!, start: pointLength(before.toString()), end: pointLength(through.toString()), excerpt: range.toString() };
}
export function highlightPieces(text: string, range?: SourceReference['range']): { before: string; selected: string; after: string } {
  if (!range) return { before: '', selected: text, after: '' };
  if (range.start < 0 || range.end > pointLength(text) || range.end < range.start) throw new Error('引用选区已失效');
  return { before: pointSlice(text, 0, range.start), selected: pointSlice(text, range.start, range.end), after: pointSlice(text, range.end) };
}
