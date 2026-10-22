import { pointLength, pointSlice, transcriptTrace, type SourceReference, type TranscriptSegment } from '../editor-core/model.js';
import type { AsrAPI, AsrCorrectionSave, AsrDocument } from '../shared/asr-contracts.js';

/** A text citation always names the exact immutable raw/correction version and original P. */
export function asrRangeReference(segment: TranscriptSegment, start: number, end: number): SourceReference {
  const text = segment.runs.map(run => run.text).join(''), trace = transcriptTrace(segment);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > pointLength(text)) throw new Error('请在同一分片中选择非空文字。');
  return { kind: 'transcript', transcriptId: segment.transcriptId, revision: segment.revision, segmentId: segment.segmentId, mediaId: segment.mediaId, partId: segment.partId, timeContractVersion: 2, inputSource: trace.inputSource, inputRange: trace.inputRange, timing: trace.timing, range: { start, end, unit: 'unicode-code-point', excerpt: pointSlice(text, start, end), before: pointSlice(text, Math.max(0, start - 12), start), after: pointSlice(text, end, end + 12) } };
}
/** Correction editing never mutates the provider response or any editor document. */
export class AsrCorrectionSession {
  readonly id = `asr-session-${crypto.randomUUID()}`;
  readonly resultId: string;
  text: string; revision: number; edit = 0; savedEdit = 0;
  status: 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict' = 'saved'; error = '';
  saving?: Promise<boolean>; undo: string[] = []; redo: string[] = [];
  constructor(readonly contentId: number, document: AsrDocument, private api: Pick<AsrAPI, 'saveCorrection'>, private changed: () => void = () => {}) {
    this.resultId = document.result.resultId; this.text = document.correction?.text ?? document.result.text; this.revision = document.correction?.revision ?? 0;
  }
  get dirty() { return this.edit !== this.savedEdit; }
  replace(text: string, remember = true) {
    if (text === this.text) return;
    if (remember) { this.undo.push(this.text); while (this.undo.length > 60 || this.undo.length > 1 && this.undo.reduce((sum, item) => sum + item.length, 0) > 4_000_000) this.undo.shift(); this.redo = []; }
    this.text = text; this.edit++; if (!['failed', 'conflict'].includes(this.status)) this.status = this.saving ? 'saving' : 'dirty'; this.changed();
  }
  rememberComposition(before: string) { if (before !== this.text) { this.undo.push(before); this.redo = []; } }
  history(kind: 'undo' | 'redo') { const from = kind === 'undo' ? this.undo : this.redo, to = kind === 'undo' ? this.redo : this.undo, value = from.pop(); if (value === undefined) return; to.push(this.text); this.replace(value, false); }
  async save(): Promise<boolean> {
    if (this.saving) return this.saving; if (!this.dirty) return true;
    const edit = this.edit, request: AsrCorrectionSave = { contentId: this.contentId, resultId: this.resultId, sessionId: this.id, requestId: `asr-save-${crypto.randomUUID()}`, expectedRevision: this.revision, text: this.text };
    this.status = 'saving'; this.error = ''; this.changed();
    const operation = (async () => {
      try {
        const result = await this.api.saveCorrection(request);
        for (const key of ['contentId', 'resultId', 'sessionId', 'requestId'] as const) if (result[key] !== request[key]) throw new Error('校对保存回包身份不匹配，当前输入保留。');
        if (result.status === 'conflict') { this.status = 'conflict'; this.error = `磁盘已有校对版本 ${result.actualRevision}；当前输入保留，请先查看磁盘版本。`; return false; }
        if (result.status === 'failed') throw new Error(result.error || '校对保存失败，当前输入保留。');
        if (result.revision !== (request.expectedRevision === 0 ? 2 : request.expectedRevision + 1)) throw new Error('校对保存版本不匹配，当前输入保留。');
        this.revision = result.revision; this.savedEdit = edit; this.status = this.dirty ? 'dirty' : 'saved'; return true;
      } catch (error) { this.status = 'failed'; this.error = error instanceof Error ? error.message : '校对保存失败，当前输入保留。'; return false; }
      finally { this.saving = undefined; this.changed(); }
    })();
    this.saving = operation; return operation;
  }
  async barrier(): Promise<boolean> { for (let attempt = 0; attempt < 4; attempt++) { if (!await this.save()) return false; if (!this.dirty && !this.saving) return true; } return false; }
}
