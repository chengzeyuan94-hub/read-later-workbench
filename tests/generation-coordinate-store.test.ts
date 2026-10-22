import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository } from '../src/main/digest-store.js';
import { migrateAsrSchema } from '../src/main/asr-store.js';
import { GenerationRepository, migrateGenerationSchema, type GenerationCallToken } from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { generationSha256 } from '../src/main/generation-validation.js';
import type { GenerationModelSelection, GenerationProviderResult, OrganizedDocument } from '../src/shared/generation-contracts.js';
const model: GenerationModelSelection = { provider: 'deepseek', model: 'synthetic-no-http', discoveredAt: 1, accountModelsSha256: 'a'.repeat(64), publishedContextTokens: 65536, providerOutputLimitTokens: null, inputBudgetUtf8Bytes: 32000, maxOutputTokens: 16384, applicationContextBudgetTokens: 65536, responseFormat: 'json_object', promptVersion: 'read-create-source-grounded-v1', configurationSha256: 'b'.repeat(64), capabilitySources: ['synthetic no HTTP'] };
function fixture() {
  const base = path.resolve('.acceptance-data/editor-e3-real'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(path.join(base, 'coordinate-store-')), store = new Store(root);
  const item = { sourceId: 'coordinate-mechanism', title: '坐标机制，不是真实生成', author: 'test', url: 'https://www.xiaohongshu.com/explore/synthetic', kind: 'text' as const, folderIds: [] };
  store.saveSnapshot({ platform: 'xiaohongshu', accountId: 'synthetic', accountName: 'test', folders: [], complete: true, items: [item] }, [{ item, discovery: 'historical' }], 1);
  const id = store.find('xiaohongshu', 'synthetic', item.sourceId)!; store.detailSaved(id, { body: '开头🙂e\u0301，只有满足条件才可使用25mg，不能超过30天。', bodyComplete: true, mediaManifestComplete: true, media: [] });
  migrateEditorSchema(store.db, root, { targetVersion: 7 }); const editor = new EditorRepository(store.db, root); migrateAsrSchema(store.db, root); const digest = new DigestRepository(store.db, root, editor); migrateGenerationSchema(store.db,root);migrateE44Schema(store.db,root); const generation = new GenerationRepository(store.db, root, editor, digest); generation.setCapability(true, true);
  digest.request(id); generation.authorize(id); generation.prepareReady(); const pending = generation.pendingModel()!; generation.beginModelDiscovery(pending.requestId); generation.setModel(pending.requestId, model); const token = generation.next()!; generation.markSubmitted(token);
  return { root, store, editor, digest, generation, token, id };
}
function response(token: GenerationCallToken): GenerationProviderResult {
  const unit = token.input.units[0], value: OrganizedDocument = { schemaVersion: 1, sourceRevisionId: token.input.sourceRevisionId, title: '保持原文事实', lead: '', blocks: [{ id: 'p', type: 'paragraph', role: 'fact', text: unit.text, citations: [{ unitId: unit.id, start: 900, end: -8, excerpt: unit.text }] }], coverage: [{ unitId: unit.id, start: 900, end: -8, disposition: 'included' }] };
  return { value, rawResponse: { object: 'synthetic', message: { content: JSON.stringify(value) } }, model: model.model, configurationSha256: model.configurationSha256, promptVersion: model.promptVersion };
}
test('repository durably retains original parsed/wire response and separate coordinate proof; successful cache is reused without changing old files, and its original digest is actually checked', () => {
  const f = fixture(); try {
    const raw = response(f.token), before = JSON.stringify(raw); assert.equal(f.generation.accept(f.token, raw), true); assert.equal(JSON.stringify(raw), before);
    const task = f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(f.token.taskId) as any, saved = JSON.parse(task.result_json) as GenerationProviderResult, proof = saved.coordinateNormalization!;
    const originalFile = path.join(f.generation.resultsDir, proof.originalResponse.relativePath), stageFile = path.join(f.generation.resultsDir, task.result_path), stageBytes = readFileSync(stageFile);
    assert.equal(readFileSync(originalFile, 'utf8'), before); assert.deepEqual(saved.rawResponse, raw.rawResponse); assert.equal(proof.originalResponse.sha256, generationSha256(before)); assert.equal(proof.originalValueSha256, generationSha256(raw.value)); assert.equal(proof.canonicalValueSha256, generationSha256(saved.value));
    assert.equal(proof.repairs.length, 2); assert.equal(f.store.db.pragma('user_version', { simple: true }), 10); assert.equal((f.store.db.prepare('SELECT count(*) n FROM digest_library').get() as any).n, 0);
    // Explicit synthetic interruption fault: the exact frozen task is re-queued;
    // its healthy cache must be consumed without another call or coordinate search.
    f.store.db.prepare("UPDATE generation_tasks SET state='queued' WHERE id=?").run(f.token.taskId);
    assert.equal(f.generation.next(), null); assert.deepEqual(readFileSync(stageFile), stageBytes); assert.equal(readFileSync(originalFile, 'utf8'), before);
    const reused = f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(f.token.taskId) as any; assert.equal(reused.reused, 1); assert.equal(reused.result_json, task.result_json); assert.equal((f.store.db.prepare('SELECT count(*) n FROM generation_calls').get() as any).n, 1);
    writeFileSync(originalFile, 'synthetic damage of coordinate-original proof only');
    f.store.db.prepare("UPDATE generation_tasks SET state='queued' WHERE id=?").run(f.token.taskId);
    f.generation.next(); assert.equal((f.store.db.prepare('SELECT state FROM generation_tasks WHERE id=?').get(f.token.taskId) as any).state, 'failed'); assert.deepEqual(readFileSync(stageFile), stageBytes); assert.equal((f.store.db.prepare('SELECT count(*) n FROM generation_calls').get() as any).n, 1);
  } finally { f.store.close(); }
});

test('nonmatching facts stay rejected with raw response preserved; cancellation prevents any late coordinate derivation or overwrite', () => {
  const f = fixture(); try {
    const raw = response(f.token), value = raw.value as OrganizedDocument; value.blocks[0].citations[0].excerpt = '伪造的26mg，不能把它修成原文25mg'; const before = JSON.stringify(raw), draft = f.editor.load(f.generation.status(f.id).target!.workspaceId).bundle;
    assert.equal(f.generation.accept(f.token, raw), false); assert.equal(readFileSync(path.join(f.generation.resultsDir, 'rejected', f.token.runId + '.json'), 'utf8'), before); assert.deepEqual(f.editor.load(draft.workspace.id).bundle, draft); assert.equal((f.store.db.prepare('SELECT count(*) n FROM digest_library').get() as any).n, 0);
    f.generation.retry(f.id); const retry = f.generation.next()!; f.generation.markSubmitted(retry); f.generation.cancel(f.id); f.digest.cancel(f.id); const files = readdirSync(f.generation.resultsDir, { recursive: true });
    assert.equal(f.generation.accept(retry, response(retry)), false); assert.deepEqual(readdirSync(f.generation.resultsDir, { recursive: true }), files); assert.deepEqual(f.editor.load(draft.workspace.id).bundle, draft);
  } finally { f.store.close(); }
});

test('a missing original coordinate proof blocks downstream map preparation before another call while preserving the healthy saved upstream stage', () => {
  const f = fixture(); try {
    assert.equal(f.generation.accept(f.token, response(f.token)), true);
    const task = f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(f.token.taskId) as any, saved = JSON.parse(task.result_json) as GenerationProviderResult;
    const stageFile = path.join(f.generation.resultsDir, task.result_path), stageBytes = readFileSync(stageFile), manual = f.editor.load(f.generation.status(f.id).target!.workspaceId).bundle;
    writeFileSync(path.join(f.generation.resultsDir, saved.coordinateNormalization!.originalResponse.relativePath), 'synthetic lost/corrupt original response');
    assert.equal(f.generation.next(), null);
    assert.equal((f.store.db.prepare('SELECT state FROM generation_tasks WHERE id=?').get(f.token.taskId) as any).state, 'succeeded');
    assert.equal((f.store.db.prepare('SELECT count(*) n FROM generation_tasks WHERE stage=\'map\'').get() as any).n, 0);
    assert.equal((f.store.db.prepare('SELECT count(*) n FROM generation_calls').get() as any).n, 1);
    assert.deepEqual(readFileSync(stageFile), stageBytes); assert.deepEqual(f.editor.load(manual.workspace.id).bundle, manual);
    assert.equal((f.store.db.prepare('SELECT count(*) n FROM digest_library').get() as any).n, 0);
  } finally { f.store.close(); }
});
