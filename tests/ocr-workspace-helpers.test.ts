import assert from 'node:assert/strict';
import test from 'node:test';
import { fitImage, locateImageBounds, OcrCorrectionSession, ocrRangeReference, zoomImage } from '../src/renderer/ocr-workspace-helpers.js';
import type { OcrCorrectionSave, OcrCorrectionSaveResult, OcrDocument } from '../src/shared/ocr-contracts.js';

const fixture = (): OcrDocument => ({ result: { resultId: 'result-1', blocks: [{ id: 'line-1', text: '原文😀', order: 0 }] }, correction: null, correctionHead: 0, correctionHistory: [], adopted: { kind: 'original', revision: 1 } }) as unknown as OcrDocument;
const ack = (request: OcrCorrectionSave, revision: number): OcrCorrectionSaveResult => ({ contentId: request.contentId, resultId: request.resultId, sessionId: request.sessionId, requestId: request.requestId, status: 'saved', revision });

test('OCR校对晚回包只确认已提交输入，后续输入继续dirty并以新revision保存', async () => {
  const pending: { request: OcrCorrectionSave; resolve(value: OcrCorrectionSaveResult): void }[] = [];
  const session = new OcrCorrectionSession(9, fixture(), { saveCorrection: request => new Promise(resolve => pending.push({ request, resolve })) });
  const first = session.save(); session.replace([{ ...session.blocks[0], text: '校对中文😀' }]);
  assert.equal(pending[0].request.blocks[0].text, '原文😀'); pending[0].resolve(ack(pending[0].request, 1)); assert.equal(await first, true);
  assert.equal(session.revision, 1); assert.equal(session.dirty, true); assert.equal(session.blocks[0].text, '校对中文😀');
  const second = session.save(); assert.equal(pending[1].request.expectedRevision, 1); pending[1].resolve(ack(pending[1].request, 2)); await second;
  assert.equal(session.revision, 2); assert.equal(session.dirty, false);
});

test('OCR保存冲突及跨结果伪回包保留当前输入和确认版本', async () => {
  const session = new OcrCorrectionSession(9, fixture(), { saveCorrection: async request => ({ ...ack(request, 1), status: 'conflict', actualRevision: 3 }) });
  session.replace([{ ...session.blocks[0], text: '我的未保存校对' }]); assert.equal(await session.barrier(), false); assert.equal(session.status, 'conflict'); assert.equal(session.revision, 0); assert.equal(session.blocks[0].text, '我的未保存校对');
  const wrong = new OcrCorrectionSession(9, fixture(), { saveCorrection: async request => ({ ...ack(request, 1), resultId: 'other-result' }) });
  assert.equal(await wrong.save(), false); assert.equal(wrong.status, 'failed'); assert.equal(wrong.revision, 0); assert.equal(wrong.dirty, true);
});

test('OCR输入法一次组合对应一次撤销，保存不改变原稿和引用映射', async () => {
  const original = fixture(), before = structuredClone(original), session = new OcrCorrectionSession(9, original, { saveCorrection: async request => ack(request, request.expectedRevision + 1) });
  const composition = structuredClone(session.blocks);
  session.replace([{ ...session.blocks[0], text: '中文输入' }], false); session.replace([{ ...session.blocks[0], text: '中文输入完成' }], false); session.rememberComposition(composition);
  assert.equal(session.undo.length, 1); await session.barrier(); session.history('undo'); assert.equal(session.blocks[0].text, '原文😀'); session.history('redo'); assert.equal(session.blocks[0].text, '中文输入完成'); assert.deepEqual(session.blocks[0].originalBlockIds, ['line-1']); assert.deepEqual(original, before);
});

test('OCR选区用Unicode code point固定原稿和校对版本', () => {
  const reference = ocrRangeReference('result-1', 'line-1', '甲😀中文乙', 1, 4, 7);
  assert.equal(reference.kind, 'ocr'); if (reference.kind !== 'ocr') return;
  assert.equal(reference.correctionRevision, 7); assert.equal(reference.range?.excerpt, '😀中文'); assert.equal(reference.range?.before, '甲'); assert.equal(reference.range?.after, '乙');
  assert.throws(() => ocrRangeReference('r', 'b', '😀', 0, 2));
});

test('OCR原图缩放固定鼠标像素位置，长图行框定位使用完整原图坐标', () => {
  const image = { width: 1080, height: 20000 }, host = { width: 600, height: 700 }, fit = fitImage(image, host), at = { x: 230, y: 330 };
  const next = zoomImage(fit, fit.zoom * 4, at);
  assert.ok(Math.abs((at.x - fit.x) / fit.zoom - (at.x - next.x) / next.zoom) < .0001);
  const centered = locateImageBounds(next, [{ x: .1, y: .85, width: .8, height: .01, unit: 'normalized' }], image, host);
  assert.ok(Math.abs(centered.x + .5 * image.width * centered.zoom - host.width / 2) < .0001);
  assert.ok(Math.abs(centered.y + .855 * image.height * centered.zoom - host.height / 2) < .0001);
});
