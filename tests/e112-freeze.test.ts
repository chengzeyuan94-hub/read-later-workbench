import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setup, seed, png, request as saveRequest } from './e1-helpers.js';
import { clone, type SourceReference } from '../src/editor-core/model.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { OcrRepository, type OcrInspectOutput, type OcrJobToken, type OcrNativeOutput } from '../src/main/ocr-store.js';
import { classifyFreezeError } from '../src/main/digest-freeze-errors.js';
import { sha256File } from '../src/main/editor-media.js';
import type { OcrEngine } from '../src/shared/ocr-contracts.js';

// Mechanism fixtures only: no native OCR, disk-fill experiment, platform access or production profile.
const engine: OcrEngine = { id: 'apple-vision', version: 'unit-stub-E112-only', osVersion: 'test', osBuild: 'test', architecture: 'test', revision: 3, supportedRevisions: [3], supportedLanguages: ['zh-Hans'], languages: ['zh-Hans'], mode: 'accurate', algorithm: 'unit-e112', normalizationPolicy: 'imageio-decode-v2', helperSha256: 'b'.repeat(64), configSha256: 'a'.repeat(64) };
function fixture(count = 2) {
  const f = setup();
  assert.ok(f.root.includes(`${path.sep}.acceptance-data${path.sep}editor-e112${path.sep}`), 'Use the E112 isolated test runner');
  const id = seed(f.store);
  f.store.db.prepare('UPDATE contents SET digested_at=NULL,last_reviewed_at=NULL WHERE id=?').run(id);
  migrateEditorSchema(f.store.db, f.root, { targetVersion: 7 });
  const editor = new EditorRepository(f.store.db, f.root), opened = editor.open(id, 'source');
  if (!opened.initialized) throw new Error('fixture workspace');
  const original = clone(opened.bundle), source = original.sources[0];
  const ref: SourceReference = { kind: 'capturedSource', sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, blockId: source.blocks[0].id };
  const map = clone(original.map); map.nodes[map.rootId].sourceRefs = [ref];
  assert.equal(editor.save([saveRequest(map)])[0].status, 'saved');
  editor.title(original.workspace.id, '人工标题不覆盖');
  const savedManual = JSON.stringify(editor.load(original.workspace.id));
  f.store.detailSaved(id, { body: '新来源正文', bodyComplete: true, mediaManifestComplete: true, media: Array.from({ length: count }, (_, i) => ({ kind: 'image' as const, remoteUrl: `https://example.invalid/${i}`, mime: 'image/png', role: 'gallery', resourceKey: `image-${i}`, version: '1' })) });
  for (const [i, media] of f.store.content(id)!.media.entries()) { const bytes = Buffer.concat([png, Buffer.from(String(i))]), file = `image-${i}.png`; writeFileSync(path.join(f.root, 'media', file), bytes); f.store.downloadSaved(media.id, file, bytes.length, media.mime); }
  const digest = new DigestRepository(f.store.db, f.root, editor), ocr = new OcrRepository(f.store.db, f.root, editor, digest, { normalizationPolicy: 'imageio-decode-v2' });
  ocr.setCapability({ available: true, engine });
  return { ...f, id, editor, digest, ocr, savedManual, workspaceId: original.workspace.id, ref };
}
// These inject filesystem permission failures via chmod/mocked writes, so they
// only run under the E112 isolated runner (its own TMPDIR root). Elsewhere they
// skip with an explicit reason instead of failing.
const e112Runner = os.tmpdir().includes(`${path.sep}.acceptance-data${path.sep}editor-e112${path.sep}`);
const e112Test = (name: string, fn: () => void | Promise<void>) => test(name, { skip: e112Runner ? false : 'requires the E112 isolated test runner' }, fn);
function click(f: ReturnType<typeof fixture>, renew = false) { const request = f.digest.request(f.id, renew).request!; f.ocr.syncAuthorized(); return request; }
function scopeJSON(f: ReturnType<typeof fixture>, requestId: string): string { return (f.store.db.prepare('SELECT scope_json FROM digest_requests WHERE id=?').get(requestId) as any).scope_json; }
function inspection(t: OcrJobToken): OcrInspectOutput { return { schemaVersion: 1, ok: true, op: 'inspect', engine: clone(t.engine), limits: {}, image: { sha256: t.media.sha256!, bytes: t.media.bytes, mime: t.media.mime, width: 1, height: 1, rawWidth: 1, rawHeight: 1, orientation: 1, orientationTransform: { normalizedDisplayToRaw: [1, 0, 0, 1, 0, 0] }, normalization: { policyVersion: 'imageio-decode-v2', basis: 'imageio-default-after-full-decode', decode: 'full-resolution' } } }; }
function recognition(t: OcrJobToken): OcrNativeOutput { const text = '明确标注的合成识别结果', bounds = { x: 0, y: 0, width: 1, height: 1, unit: 'normalized' as const }; return { ...inspection(t), op: 'recognize', recognition: { text, blocks: [{ id: 'line-0', text, order: 0, bounds, sliceIds: ['slice-0'], provenance: { selectedId: 'candidate-0', candidates: [{ id: 'candidate-0', text, bounds, confidence: .9, sliceId: 'slice-0', edgeDistancePx: 1, selected: true }], conflict: false, mergePolicy: 'overlap-position-completeness-v2', selectionReason: 'fixture', row: 0, baselinePx: 1 } }], slices: [{ id: 'slice-0', x: 0, y: 0, width: 1, height: 1, status: 'succeeded' }], coverage: 'complete', warnings: [], quality: { execution: 'complete', review: 'required', conflictBlocks: 0 }, startedAt: '2026-10-17T00:00:00Z', completedAt: '2026-10-17T00:00:01Z' } }; }
function completeOne(f: ReturnType<typeof fixture>) { const t = f.ocr.nextInspection(engine)!; assert.ok(t); assert.equal(f.ocr.acceptInspection(t, inspection(t)), true); const recognitionToken = f.ocr.next(engine); if (recognitionToken) assert.equal(f.ocr.accept(recognitionToken, recognition(recognitionToken)), true); return t.media.id; }
function assertNoFinalArtifacts(f: ReturnType<typeof fixture>) { assert.equal(f.digest.status(f.id).library, null); assert.equal((f.store.db.prepare('SELECT count(*) n FROM digest_calls').get() as any).n, 0); assert.equal(JSON.stringify(f.editor.load(f.workspaceId)), f.savedManual); assert.equal(f.editor.resolve(f.workspaceId, f.ref).selectedText, '原文🙂'); }

e112Test('E112 initial attachment writes classify injected ENOSPC/EACCES; retries keep original cause, successes and manual references; only an explicit new request freezes restored input', () => {
  for (const systemCode of ['ENOSPC', 'EACCES']) {
    const f = fixture(); let restore = () => {};
    try {
      f.ocr.list(f.id); f.ocr.syncAuthorized();
      assert.deepEqual(f.ocr.callCounts(), { probe: 0, inspect: 0, recognize: 0 });
      const failedMedia = f.store.content(f.id)!.media[1], hash = sha256File(path.join(f.root, 'media', failedMedia.localPath!)), originalWrite = fs.writeFileSync;
      const injected = mock.method(fs, 'writeFileSync', ((file: any, ...args: any[]) => {
        if (String(file).startsWith(f.editor.assetsDir + path.sep) && String(file).includes(hash)) throw Object.assign(new Error('mechanism fault only: not a real full disk'), { code: systemCode, syscall: 'open' });
        return (originalWrite as any)(file, ...args);
      }) as any);
      syncBuiltinESMExports(); restore = () => { injected.mock.restore(); syncBuiltinESMExports(); };
      const request = click(f), immutable = scopeJSON(f, request.id), frozen = f.digest.internalScope(request.id).input.media.find(m => m.id === failedMedia.id)!;
      assert.equal(frozen.available, false); assert.equal(frozen.freezeError!.code, systemCode === 'ENOSPC' ? 'disk-full' : 'permission-denied');
      assert.equal(frozen.freezeError!.systemCode, systemCode); assert.equal(frozen.freezeError!.operation, 'pin-attachment'); assert.equal(frozen.freezeError!.recovery, 'new-request');
      assert.equal(f.ocr.list(f.id).jobs[1].recovery, 'new-request'); assert.ok(!frozen.freezeError!.message.includes(f.root)); assert.doesNotMatch(frozen.freezeError!.message, /元数据|坏图|堆栈/);
      restore();
      completeOne(f);
      const beforeRetry = f.ocr.callCounts(), successful = f.ocr.list(f.id).jobs[0].resultId!, savedResult = f.ocr.read(f.id, successful);
      const retry = f.ocr.retry(f.id); assert.equal(retry.jobs[1].errorCode, frozen.freezeError!.code); assert.equal(retry.jobs[1].state, 'waiting-files');
      assert.equal(f.ocr.nextInspection(engine), null); assert.equal(f.ocr.next(engine), null); assert.deepEqual(f.ocr.callCounts(), beforeRetry); assert.equal(scopeJSON(f, request.id), immutable); assert.deepEqual(f.ocr.read(f.id, successful), savedResult);
      assertNoFinalArtifacts(f);
      const resumed = new OcrRepository(f.store.db, f.root, f.editor, f.digest, { normalizationPolicy: 'imageio-decode-v2' }); resumed.setCapability({ available: true, engine }); resumed.syncAuthorized();
      assert.equal(resumed.retry(f.id).jobs[1].errorCode, frozen.freezeError!.code); assert.equal(resumed.nextInspection(engine), null); assert.equal(scopeJSON(f, request.id), immutable);
      const fresh = click(f, true); assert.notEqual(fresh.id, request.id); assert.equal(fresh.inputScope.media.every(m => m.available), true);
      completeOne(f); completeOne(f);
      assert.equal(f.ocr.list(f.id).progress.succeeded, 2); assert.equal(scopeJSON(f, request.id), immutable); assert.deepEqual(f.ocr.read(f.id, successful), savedResult); assertNoFinalArtifacts(f);
    } finally { restore(); f.close(); }
  }
});

e112Test('E112 initially unwritable attachment directory is a permission failure; restoring permissions cannot fill the old scope, a new request can proceed', () => {
  const f = fixture(1);
  try {
    chmodSync(f.editor.assetsDir, 0o500);
    const request = click(f), scope = scopeJSON(f, request.id), job = f.ocr.list(f.id).jobs[0];
    assert.equal(job.errorCode, 'permission-denied'); assert.equal(job.recovery, 'new-request'); assert.equal(job.state, 'waiting-files'); assert.match(job.error!, /权限/); assert.doesNotMatch(job.error!, /元数据/);
    chmodSync(f.editor.assetsDir, 0o700);
    f.ocr.retry(f.id); assert.equal(f.ocr.nextInspection(engine), null); assert.deepEqual(f.ocr.callCounts(), { probe: 0, inspect: 0, recognize: 0 }); assert.equal(scopeJSON(f, request.id), scope); assertNoFinalArtifacts(f);
    click(f, true); completeOne(f); assert.equal(f.ocr.list(f.id).progress.succeeded, 1); assert.equal(scopeJSON(f, request.id), scope); assertNoFinalArtifacts(f);
  } finally { chmodSync(f.editor.assetsDir, 0o700); f.close(); }
});

e112Test('E112 header filesystem codes outrank metadata interpretation while a real header incompatibility stays distinct', () => {
  const expected = { EACCES: 'permission-denied', EPERM: 'permission-denied', EROFS: 'permission-denied', ENOSPC: 'disk-full', EDQUOT: 'disk-full', ENOENT: 'missing-file', ENOTDIR: 'file-unavailable', EIO: 'file-unavailable' };
  for (const [systemCode, code] of Object.entries(expected)) {
    const error = classifyFreezeError(Object.assign(new Error('/private/path must never leak'), { code: systemCode }), 'read-header');
    assert.equal(error.code, code); assert.equal(error.systemCode, systemCode); assert.equal(error.recovery, 'new-request'); assert.doesNotMatch(error.message, /private|元数据/);
  }
  assert.equal(classifyFreezeError(new Error('unsupported header'), 'read-header').code, 'metadata-incompatible');
  assert.equal(classifyFreezeError(new Error('attachment validation'), 'pin-attachment').code, 'file-unavailable');
});

e112Test('E112 already frozen same-SHA input remains retryable after a temporary permission failure and preserves its original scope', () => {
  const f = fixture(1); let original: string | undefined;
  try {
    const request = click(f), scope = scopeJSON(f, request.id), internal = f.digest.internalScope(request.id), media = internal.input.media[0];
    original = path.join(f.digest.inputsDir, internal.fixedMediaPaths[String(media.id)]);
    const bytes = readFileSync(original); chmodSync(original, 0);
    assert.equal(f.ocr.nextInspection(engine), null); const job = f.ocr.list(f.id).jobs[0]; assert.equal(job.errorCode, 'file-unavailable'); assert.equal(job.recovery, 'retry-frozen'); assert.equal(f.ocr.callCounts().inspect, 0);
    chmodSync(original, 0o600); assert.deepEqual(readFileSync(original), bytes); f.ocr.retry(f.id); completeOne(f);
    assert.equal(f.digest.status(f.id).request!.id, request.id); assert.equal(scopeJSON(f, request.id), scope); assert.equal(f.ocr.list(f.id).progress.succeeded, 1); assertNoFinalArtifacts(f);
  } finally { if (original) chmodSync(original, 0o600); f.close(); }
});
