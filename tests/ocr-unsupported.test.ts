import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DigestRepository } from '../src/main/digest-store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { OCR_UNSUPPORTED_REASON } from '../src/shared/ocr-contracts.js';
import type { DigestEngineConfig, DigestStageName, DigestStageOutput } from '../src/shared/digest-contracts.js';
import { png, setup, seed } from './e1-helpers.js';

// Non-darwin hosts report image recognition as unsupported, not failed: digest
// must freeze without the ocr stage and record that images were not recognized.
const config: DigestEngineConfig = { id: 'synthetic-contract-runner', version: 'test-v1', configurationSha256: 'a'.repeat(64), synthetic: true };
function imageFixture() {
  const f = setup(), id = seed(f.store);
  f.store.db.prepare("UPDATE contents SET kind='image',manifest_complete=1,detail_state='succeeded' WHERE id=?").run(id);
  f.store.detailSaved(id, { body: '合成来源正文', bodyComplete: true, mediaManifestComplete: true, media: [{ remoteUrl: 'https://example.invalid/synthetic', kind: 'image', mime: 'image/png', resourceKey: 'synthetic-image', version: '1', role: 'image' }] });
  const media = f.store.content(id)!.media[0];
  writeFileSync(path.join(f.root, 'media', 'synthetic.bin'), png);
  f.store.downloadSaved(media.id, 'synthetic.bin', png.length, media.mime);
  migrateEditorSchema(f.store.db, f.root, { targetVersion: 7 });
  const editor = new EditorRepository(f.store.db, f.root), pipeline = new DigestRepository(f.store.db, f.root, editor);
  return { ...f, id, editor, pipeline };
}
function stage(f: ReturnType<typeof imageFixture>, requestId: string, name: DigestStageName, output: DigestStageOutput) {
  const token = f.pipeline.beginStage(requestId, 1, name, config);
  assert.ok(token, `${name} started`);
  assert.equal(f.pipeline.acceptStage(token, output), true, `${name} accepted`);
}

test('unsupported OCR digests text-only: no ocr stage, honest selection record, completion unblocked', () => {
  const f = imageFixture();
  try {
    f.pipeline.setOCRCapability(false, OCR_UNSUPPORTED_REASON, undefined, false);
    const request = f.pipeline.requestSynthetic(f.id).request!;
    const scope = request.inputScope;
    assert.equal(scope.requiresOCR, false);
    assert.equal(scope.requiresASR, false);
    assert.equal(scope.ocrSelection!.length, 1);
    assert.equal(scope.ocrSelection![0].included, false);
    assert.equal(scope.ocrSelection![0].reason, OCR_UNSUPPORTED_REASON);
    assert.equal(scope.ocrMediaIds!.length, 0);
    assert.equal(f.pipeline.status(f.id).stages.find(s => s.name === 'ocr')!.state, 'not-required');
    // The frozen scope keeps the honest record for the receipt.
    const internal = f.pipeline.internalScope(request.id);
    assert.equal(internal.input.ocrSelection![0].reason, OCR_UNSUPPORTED_REASON);
    // organize/map/markdown still run on the source text alone and can complete.
    stage(f, request.id, 'organize', { kind: 'draft', scopeRevisionId: scope.revisionId, document: { documentId: internal.reserved.draftDocumentId, workspaceId: internal.reserved.workspaceId, schemaVersion: 1, revision: 1, blocks: [{ id: 't1', type: 'paragraph', runs: [{ text: '正文整理稿' }] }] } });
    stage(f, request.id, 'map', { kind: 'map', scopeRevisionId: scope.revisionId, document: { documentId: internal.reserved.mapDocumentId, workspaceId: internal.reserved.workspaceId, schemaVersion: 1, revision: 1, sheetId: 's', rootId: 'r', theme: { id: 'light', name: '浅色' }, nodes: { r: { id: 'r', parentId: null, children: ['c'], title: [{ text: '图' }], notes: '', sourceRefs: [] }, c: { id: 'c', parentId: 'r', children: [], title: [{ text: '节点' }], notes: '', sourceRefs: [{ kind: 'capturedSource', sourceId: internal.sources[0].sourceId, sourceRevisionId: internal.sources[0].sourceRevisionId, blockId: internal.sources[0].blocks[0].id }] } } } });
    stage(f, request.id, 'markdown', { kind: 'markdown', scopeRevisionId: scope.revisionId, draftRevision: 1, mapRevision: 1 });
    const result = f.pipeline.commitCompletion(request.id, 1);
    assert.equal(result.request!.state, 'complete');
  } finally { f.close(); }
});

test('supported-but-unavailable OCR still gates image digest as before', () => {
  const f = imageFixture();
  try {
    f.pipeline.setOCRCapability(false, '本地识别尚未就绪', undefined, true);
    const state = f.pipeline.request(f.id);
    assert.equal(state.request!.inputScope.requiresOCR, true);
    assert.equal(state.request!.state, 'waiting-capability');
    assert.equal(state.stages.find(s => s.name === 'ocr')!.state, 'waiting-capability');
  } finally { f.close(); }
});
