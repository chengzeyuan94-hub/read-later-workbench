import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertTranscriptReference, pointLength, validateTranscript, type TranscriptSegment } from '../src/editor-core/model.js';
import type { AsrContentState, AsrCorrectionSave, AsrCorrectionSaveResult, AsrDocument } from '../src/shared/asr-contracts.js';
import { AsrCorrectionSession, asrRangeReference } from '../src/renderer/asr-workspace-helpers.js';
import { sourceSubtitleVersions } from '../src/renderer/editor-workspace-helpers.js';
import { exportAsrMarkdown } from '../src/main/asr-export.js';

const segment = (text = '原音😀中文', revision = 1, partId = 'cid-200'): TranscriptSegment => ({ workspaceId: 'workspace-1', transcriptId: 'asr-result-1', revision, segmentId: 'segment-1', runs: [{ text }], mediaId: '17', partId, timeContractVersion: 2, inputSource: { kind: revision === 1 ? 'plain-text-response' : 'manual-correction', sourceId: 'asr-result-1', revision, rawText: text, responseFormat: 'text-only', mediaId: '17', partId, ...(revision === 1 ? {} : { derivedFrom: { sourceId: 'asr-result-1', revision: 1 } }) }, inputRange: { coordinate: 'media-part', mediaId: '17', partId, startMs: 12345, endMs: 24680 }, sourceTextRange: { start: 0, end: pointLength(text), unit: 'unicode-code-point' }, timing: { state: 'unknown', reason: 'not-provided' } });
const fixture = (): AsrDocument => ({ result: { resultId: 'asr-result-1', revision: 1, contentId: 7, requestId: 'digest-request-1', scopeRevisionId: 'scope-1', generation: 1, mediaId: 17, sourceIdentity: 'bilibili:bv1:cid200', partId: 'cid-200', mediaTitle: '真实夹具，仅机制测试', mediaOrder: 0, chunkOrder: 0, originalSha256: 'a'.repeat(64), audioSha256: 'b'.repeat(64), inputRange: { startMs: 12345, endMs: 24680 }, provider: { provider: 'siliconflow', model: 'TeleAI/TeleSpeechASR', configSha256: 'c'.repeat(64), responseContract: 'text-only-v1' }, text: '原音😀中文', segment: segment(), coverage: 'complete', createdAt: 100, responseSha256: 'd'.repeat(64), responsePath: 'response.json' }, correction: null, correctionHead: 0, correctionHistory: [], adopted: { kind: 'original', revision: 1 } });
const ack = (request: AsrCorrectionSave, revision: number): AsrCorrectionSaveResult => ({ status: 'saved', contentId: request.contentId, resultId: request.resultId, sessionId: request.sessionId, requestId: request.requestId, revision });

test('ASR 校对晚回包只确认已提交输入，新输入保持 dirty 并使用新 revision', async () => {
  const pending: { request: AsrCorrectionSave; resolve(value: AsrCorrectionSaveResult): void }[] = [], original = fixture(), before = structuredClone(original);
  const session = new AsrCorrectionSession(7, original, { saveCorrection: request => new Promise(resolve => pending.push({ request, resolve })) });
  assert.equal(session.dirty, false); session.replace('第一次中文😀'); const first = session.save(); session.replace('后续中文😀');
  assert.equal(pending[0].request.text, '第一次中文😀'); pending[0].resolve(ack(pending[0].request, 2)); assert.equal(await first, true); assert.equal(session.revision, 2); assert.equal(session.dirty, true);
  const second = session.save(); assert.equal(pending[1].request.expectedRevision, 2); pending[1].resolve(ack(pending[1].request, 3)); assert.equal(await second, true); assert.equal(session.dirty, false); assert.deepEqual(original, before);
});
test('ASR 校对冲突、伪回包和跳版本均保留本地文字，不确认错误保存', async () => {
  for (const kind of ['conflict', 'identity', 'revision'] as const) {
    const session = new AsrCorrectionSession(7, fixture(), { saveCorrection: async request => kind === 'conflict' ? { ...ack(request, 2), status: 'conflict', actualRevision: 4 } : kind === 'identity' ? { ...ack(request, 2), resultId: 'other' } : ack(request, 7) });
    session.replace('我的未保存输入'); assert.equal(await session.barrier(), false); assert.equal(session.text, '我的未保存输入'); assert.equal(session.revision, 0); assert.equal(session.dirty, true);
  }
});
test('ASR 中文组合输入为一次撤销，保存及重做不改原始响应', async () => {
  const original = fixture(), session = new AsrCorrectionSession(7, original, { saveCorrection: async request => ack(request, request.expectedRevision === 0 ? 2 : request.expectedRevision + 1) }), before = session.text;
  session.replace('中', false); session.replace('中文校对😀', false); session.rememberComposition(before); assert.equal(session.undo.length, 1); await session.barrier(); session.history('undo'); assert.equal(session.text, before); session.history('redo'); assert.equal(session.text, '中文校对😀'); assert.equal(original.result.text, before);
});
test('ASR 引用冻结 Unicode 码点、P、原稿或独立校对版本，未知时间没有伪句时间', () => {
  const raw = segment('甲😀中文乙'), corrected = segment('甲😀校对乙', 2), oldRef = asrRangeReference(raw, 1, 4), correctedRef = asrRangeReference(corrected, 1, 4);
  assert.equal(oldRef.range?.excerpt, '😀中文'); assert.equal(correctedRef.range?.excerpt, '😀校对'); assert.equal(correctedRef.kind, 'transcript'); if (correctedRef.kind !== 'transcript' || oldRef.kind !== 'transcript') return;
  assert.equal(correctedRef.revision, 2); assert.equal(correctedRef.partId, 'cid-200'); assert.equal(correctedRef.startMs, undefined); assert.deepEqual(correctedRef.timing, { state: 'unknown', reason: 'not-provided' }); assert.equal(correctedRef.inputRange?.startMs, 12345);
  assert.doesNotThrow(() => assertTranscriptReference(oldRef, raw)); assert.throws(() => assertTranscriptReference(oldRef, corrected), /identity/); assert.throws(() => assertTranscriptReference(correctedRef, { ...corrected, partId: 'cid-other' }), /ownership|mismatch/); assert.throws(() => asrRangeReference(raw, 0, 100));
});
test('ASR 校对必须对应确切文字及原稿身份，不能借校对新增时间或修改 rawText 映射', () => {
  const corrected = segment('校对😀', 2); assert.doesNotThrow(() => validateTranscript(corrected));
  assert.throws(() => validateTranscript({ ...corrected, runs: [{ text: '偷偷改变' }] }), /match/);
  assert.throws(() => validateTranscript({ ...corrected, inputSource: { ...corrected.inputSource, derivedFrom: { sourceId: 'other', revision: 1 } } }), /original/);
  assert.throws(() => validateTranscript({ ...corrected, timing: { state: 'unknown', reason: 'legacy-unverified' } }), /timing/);
});
test('ASR 多P与校对版本不会参与旧拼接字幕当前版本猜测', () => {
  const raw = segment(), correction = segment('校对', 2), legacy = { workspaceId: 'workspace-1', transcriptId: 'subtitle-source', revision: 1, segmentId: 'subtitle-full', runs: [{ text: '旧字幕' }] };
  const result = sourceSubtitleVersions([raw, correction, legacy], 'workspace-1', '旧字幕'); assert.equal(result.versions.length, 1); assert.equal(result.current?.transcriptId, 'subtitle-source');
});

function exportFixture() {
  const document = fixture(), state = { contentId: 7, requestId: document.result.requestId, progress: { totalMedia: 1, preparedMedia: 1, totalChunks: 1, succeeded: 1 }, jobs: [{ state: 'succeeded', resultId: document.result.resultId }] } as AsrContentState;
  const repository = { read(_id: number, _result: string, revision?: number) { if (revision === 2) return { ...document, correction: { resultId: document.result.resultId, revision: 2, text: '校对：20 kg，中文😀。', segment: segment('校对：20 kg，中文😀。', 2), savedAt: 200, derivedFrom: { transcriptId: document.result.resultId, revision: 1 as const } }, correctionHead: 2 }; return document; }, list() { return state; }, digest: { internalScope() { return { sources: [{ originalUrl: 'https://example.invalid/note?private-token=removed' }] }; } } };
  const parent = path.join(process.cwd(), '.acceptance-data/editor-e2'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'unit-transcript-export-')); return { document, state, repository, root };
}
test('ASR Markdown 按明确原稿/校对版本导出，保留P和输入范围，不伪时间、不带媒体且搬移可读', () => {
  const f = exportFixture(); try { const exported = exportAsrMarkdown(f.repository, 7, [{ resultId: f.document.result.resultId, version: { kind: 'correction', revision: 2 } }], path.join(f.root, '转录.md')), moved = path.join(f.root, 'moved.md'); renameSync(exported.path!, moved); const text = readFileSync(moved, 'utf8'); assert.match(text, /人工校对 revision 2/); assert.match(text, /cid-200/); assert.match(text, /12345–24680 ms（输入分片，非逐句时间）/); assert.match(text, /校对：20 kg，中文😀。/); assert.match(text, /全部已完成输入分片/); assert.match(text, /原音视频默认未包含/); assert.doesNotMatch(text, /private-token|rlw-.*:\/\/|\[00:/); assert.deepEqual(readdirSync(f.root), ['moved.md']); } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('ASR 部分/历史导出不冒称完整；同名保护与写入失败不覆盖旧文件', () => {
  const f = exportFixture(); try { const target = path.join(f.root, '转录.md'), selection = [{ resultId: f.document.result.resultId, version: { kind: 'original' as const, revision: 1 } }]; writeFileSync(target, '用户旧文件'); f.state.progress.totalChunks = 2;
    assert.throws(() => exportAsrMarkdown(f.repository, 7, selection, target, { failAt: 'before-publish' }), /injected/); assert.deepEqual(readdirSync(f.root), ['转录.md']); assert.equal(readFileSync(target, 'utf8'), '用户旧文件'); const exported = exportAsrMarkdown(f.repository, 7, selection, target); assert.notEqual(exported.path, target); assert.match(readFileSync(exported.path!, 'utf8'), /部分／历史所选输入分片/); assert.equal(readFileSync(target, 'utf8'), '用户旧文件');
    assert.throws(() => exportAsrMarkdown(f.repository, 7, [{ resultId: 'wrong-result', version: { kind: 'original', revision: 1 } }], target), /身份/); assert.throws(() => exportAsrMarkdown(f.repository, 7, [{ resultId: f.document.result.resultId, version: { kind: 'correction', revision: 1 } }], target), /版本/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
