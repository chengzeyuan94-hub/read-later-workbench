import { clone, pointLength, pointSlice, type SourceReference } from '../editor-core/model.js';
import type { OcrAPI, OcrBounds, OcrCorrectionBlock, OcrDocument } from '../shared/ocr-contracts.js';

export interface ImageViewport { x: number; y: number; zoom: number }
export interface ImageSize { width: number; height: number }
export const OCR_MIN_ZOOM = .015, OCR_MAX_ZOOM = 8;
export function fitImage(image: ImageSize, host: ImageSize): ImageViewport {
  const zoom = Math.max(OCR_MIN_ZOOM, Math.min(1, (host.width - 32) / image.width, (host.height - 32) / image.height));
  return { zoom, x: (host.width - image.width * zoom) / 2, y: (host.height - image.height * zoom) / 2 };
}
export function zoomImage(view: ImageViewport, desired: number, at: { x: number; y: number }): ImageViewport {
  const zoom = Math.max(OCR_MIN_ZOOM, Math.min(OCR_MAX_ZOOM, desired)), ratio = zoom / view.zoom;
  return { zoom, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}
export function locateImageBounds(view: ImageViewport, bounds: OcrBounds[], image: ImageSize, host: ImageSize): ImageViewport {
  if (!bounds.length) return view;
  const left = Math.min(...bounds.map(b => b.x)), top = Math.min(...bounds.map(b => b.y));
  const right = Math.max(...bounds.map(b => b.x + b.width)), bottom = Math.max(...bounds.map(b => b.y + b.height));
  const zoom = Math.max(view.zoom, Math.min(2, (host.width - 60) / ((right - left) * image.width), (host.height - 60) / ((bottom - top) * image.height)));
  return { zoom, x: host.width / 2 - (left + right) / 2 * image.width * zoom, y: host.height / 2 - (top + bottom) / 2 * image.height * zoom };
}
export function ocrRangeReference(resultId: string, blockId: string, text: string, start: number, end: number, correctionRevision?: number): SourceReference {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > pointLength(text)) throw new Error('请在同一文字块中选择非空文字。');
  return { kind: 'ocr', resultId, revision: 1, blockId, ...(correctionRevision ? { correctionRevision } : {}), range: { start, end, unit: 'unicode-code-point', excerpt: pointSlice(text, start, end), before: pointSlice(text, Math.max(0, start - 12), start), after: pointSlice(text, end, end + 12) } };
}
/** This session owns only an OCR correction. It never writes the user's draft or map. */
export class OcrCorrectionSession {
  readonly id = `ocr-session-${crypto.randomUUID()}`;
  readonly resultId: string;
  blocks: OcrCorrectionBlock[];
  revision: number;
  edit = 0;
  savedEdit = 0;
  status: 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict' = 'saved';
  error = '';
  saving?: Promise<boolean>;
  undo: OcrCorrectionBlock[][] = [];
  redo: OcrCorrectionBlock[][] = [];
  constructor(readonly contentId: number, document: OcrDocument, private api: Pick<OcrAPI, 'saveCorrection'>, private changed: () => void = () => {}) {
    this.resultId = document.result.resultId;
    this.revision = document.correction?.revision ?? 0;
    this.blocks = clone(document.correction?.blocks ?? document.result.blocks.map(block => ({ id: block.id, text: block.text, originalBlockIds: [block.id], provenance: 'ocr' as const })));
    if (!document.correction) { this.edit = 1; this.status = 'dirty'; }
  }
  get dirty() { return this.edit !== this.savedEdit; }
  replace(blocks: OcrCorrectionBlock[], remember = true) {
    if (JSON.stringify(blocks) === JSON.stringify(this.blocks)) return;
    if (remember) { this.undo.push(clone(this.blocks)); this.trimHistory(); this.redo = []; }
    this.blocks = clone(blocks); this.edit++; if (!['failed', 'conflict'].includes(this.status)) this.status = this.saving ? 'saving' : 'dirty'; this.changed();
  }
  rememberComposition(before: OcrCorrectionBlock[]) { if (JSON.stringify(before) !== JSON.stringify(this.blocks)) { this.undo.push(clone(before)); this.trimHistory(); this.redo = []; } }
  history(kind: 'undo' | 'redo') {
    const from = kind === 'undo' ? this.undo : this.redo, to = kind === 'undo' ? this.redo : this.undo, blocks = from.pop();
    if (!blocks) return; to.push(clone(this.blocks)); this.replace(blocks, false);
  }
  private trimHistory() { while (this.undo.length > 60 || this.undo.length > 1 && this.undo.reduce((sum, blocks) => sum + blocks.reduce((n, block) => n + block.text.length, 0), 0) > 4_000_000) this.undo.shift(); }
  async save(): Promise<boolean> {
    if (this.saving) return this.saving;
    if (!this.dirty) return true;
    const atEdit = this.edit, expectedRevision = this.revision;
    const request = { contentId: this.contentId, resultId: this.resultId, sessionId: this.id, requestId: `ocr-save-${crypto.randomUUID()}`, expectedRevision, blocks: clone(this.blocks) };
    this.status = 'saving'; this.error = ''; this.changed();
    const operation = (async () => {
      try {
        const result = await this.api.saveCorrection(request);
        if (result.contentId !== request.contentId || result.resultId !== request.resultId || result.sessionId !== request.sessionId || result.requestId !== request.requestId) throw new Error('校对保存回包身份不匹配，当前输入保留。');
        if (result.status === 'conflict') { this.status = 'conflict'; this.error = `磁盘已有校对版本 ${result.actualRevision}，当前输入保留。`; return false; }
        if (result.status === 'failed') throw new Error(result.error || '校对保存失败。');
        if (!Number.isSafeInteger(result.revision) || result.revision <= expectedRevision) throw new Error('校对保存版本无效，当前输入保留。');
        this.revision = result.revision; this.savedEdit = atEdit; this.status = this.dirty ? 'dirty' : 'saved'; return true;
      } catch (error) { this.status = 'failed'; this.error = error instanceof Error ? error.message : '校对保存失败，当前输入保留。'; return false; }
      finally { this.saving = undefined; this.changed(); }
    })();
    this.saving = operation; return operation;
  }
  async barrier(): Promise<boolean> { for (let attempt = 0; attempt < 4; attempt++) { if (!await this.save()) return false; if (!this.dirty && !this.saving) return true; } return false; }
}
