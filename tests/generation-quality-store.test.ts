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
import { GenerationRunner } from '../src/main/generation-runner.js';
import { generationSha256 } from '../src/main/generation-validation.js';
import { generationRejectionDiagnostic, generationRetryFeedback, generationRepairHint } from '../src/main/generation-diagnostics.js';
import type { GenerationModelSelection, GenerationProviderResult, OrganizedDocument } from '../src/shared/generation-contracts.js';

const model: GenerationModelSelection = { provider: 'deepseek', model: 'synthetic-zero-http', discoveredAt: 1, accountModelsSha256: 'a'.repeat(64), publishedContextTokens: 65536, providerOutputLimitTokens: null, inputBudgetUtf8Bytes: 32000, maxOutputTokens: 16384, applicationContextBudgetTokens: 65536, responseFormat: 'json_object', promptVersion: 'read-create-quality-v2', configurationSha256: 'b'.repeat(64), capabilitySources: ['synthetic only, no provider'] };
function fixture() {
  const base = path.resolve('.acceptance-data/editor-e3-real'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'quality-store-')), store = new Store(root);
  const item = { sourceId: 'quality-mechanism', title: '使用说明', author: 'test', url: 'https://www.xiaohongshu.com/explore/synthetic', kind: 'text' as const, folderIds: [] };
  store.saveSnapshot({ platform: 'xiaohongshu', accountId: 'synthetic', accountName: 'mechanism', folders: [], complete: true, items: [item] }, [{ item, discovery: 'historical' }], 1);
  const id = store.find('xiaohongshu', 'synthetic', item.sourceId)!;
  store.detailSaved(id, { body: '七岁。只有条件满足才可以使用。不能超过十岁。', bodyComplete: true, mediaManifestComplete: true, media: [] });
  migrateEditorSchema(store.db, root, { targetVersion: 7 }); const editor = new EditorRepository(store.db, root);
  migrateAsrSchema(store.db, root); const digest = new DigestRepository(store.db, root, editor); migrateGenerationSchema(store.db,root);migrateE44Schema(store.db,root);
  const generation = new GenerationRepository(store.db, root, editor, digest); generation.setCapability(true, true);
  digest.request(id); generation.authorize(id); generation.prepareReady(); const request = generation.pendingModel()!; generation.setModel(request.requestId, model);
  return { root, store, id, editor, digest, generation };
}
type F = ReturnType<typeof fixture>;
const count = (f: F, table: string) => (f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n;
const next = (f: F) => { const token = f.generation.next()!; assert.ok(token); f.generation.markSubmitted(token); return token; };
function response(token: GenerationCallToken, wrongCoordinates = false): GenerationProviderResult {
  const unit = token.input.units[0], length = Array.from(unit.text).length;
  const citation = { unitId: unit.id, start: wrongCoordinates ? 100 : 0, end: wrongCoordinates ? 200 : length, excerpt: unit.text };
  const value: unknown = token.stage === 'organize' ? {
    schemaVersion: 1, sourceRevisionId: token.input.sourceRevisionId, title: '使用说明', lead: '', blocks: [{ id: 'body', type: 'paragraph', text: unit.text, role: 'fact', citations: [citation] }], coverage: [{ unitId: unit.id, start: citation.start, end: citation.end, disposition: 'included' }],
  } satisfies OrganizedDocument : {
    schemaVersion: 2, sourceRevisionId: token.input.sourceRevisionId, organizedSha256: generationSha256(token.organized), root: { kind: 'group', topic: '使用说明', children: [{ kind: 'claim', title: '使用条件', explanation: unit.text, citations: [citation], children: [] }] },
  };
  return { value, rawResponse: { object: 'synthetic-zero-http', choices: [{ message: { content: JSON.stringify(value) } }] }, model: model.model, configurationSha256: model.configurationSha256, promptVersion: model.promptVersion };
}
function organized(f: F) { const token = next(f); assert.equal(token.stage, 'organize'); assert.equal(f.generation.accept(token, response(token)), true); return token; }

test('typed original and coordinate original form a durable verified chain, retain raw fields and publish no semantic edits', () => {
  const f = fixture(); try {
    organized(f); const token = next(f), raw = response(token, true), before = JSON.stringify(raw);
    assert.equal(token.stage, 'map'); assert.equal(f.generation.accept(token, raw), true); assert.equal(JSON.stringify(raw), before);
    const task = f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(token.taskId) as any, saved = JSON.parse(task.result_json) as GenerationProviderResult;
    assert.ok(saved.qualityNormalization); assert.ok(saved.coordinateNormalization);
    assert.equal(readFileSync(path.join(f.generation.resultsDir, saved.qualityNormalization.originalResponse.relativePath), 'utf8'), before);
    const intermediate = JSON.parse(readFileSync(path.join(f.generation.resultsDir, saved.coordinateNormalization.originalResponse.relativePath), 'utf8'));
    assert.equal(intermediate.value.nodes[1].citations[0].start, 100); assert.equal((saved.value as any).nodes[1].citations[0].start, 0);
    assert.equal((saved.value as any).nodes[1].notes, token.input.units[0].text); assert.deepEqual(saved.rawResponse, raw.rawResponse);
    assert.equal(f.generation.readyToPublish().length, 1); assert.equal(f.generation.publish(token.requestId).state, 'succeeded'); assert.equal(count(f, 'digest_library'), 1);
    assert.equal(f.store.db.pragma('user_version', { simple: true }), 10);
  } finally { f.store.close(); }
});

test('typed rejection preserves exact response, bounded path and reason; only the explicit second attempt uses same-input feedback', () => {
  const f = fixture(); try {
    organized(f); const token = next(f), raw = response(token); (raw.value as any).root.explanation = '不得静默丢掉这段误放的事实';
    assert.equal(f.generation.accept(token, raw), false); assert.equal(count(f, 'digest_library'), 0);
    const row = f.store.db.prepare('SELECT * FROM generation_calls WHERE run_id=?').get(token.runId) as any, identity = JSON.parse(row.config_json).rejectionDiagnostic;
    const diagnostic = JSON.parse(readFileSync(path.join(f.generation.resultsDir, identity.relativePath), 'utf8'));
    assert.equal(diagnostic.code, 'quality-wire-field'); assert.equal(diagnostic.jsonPath, '/root'); assert.equal(diagnostic.response.sha256, generationSha256(raw));
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.generation.resultsDir, diagnostic.response.relativePath), 'utf8')), raw);
    assert.equal(f.generation.status(f.id).error, undefined, '自动重试排队中不向请求上浮错误');
    assert.doesNotMatch(f.generation.status(f.id).tasks.find(task => task.errorCode === 'invalid-output')!.error!, /generation-run-|qnode-|quality-wire-field/);
    assert.equal(f.generation.next(), null, 'bounded auto-retry waits out its backoff; dispatch only after retry()'); f.generation.retry(f.id);
    const retry = next(f); assert.equal(retry.requestId, token.requestId); assert.equal(retry.inputSha256, token.inputSha256);
    assert.equal(retry.retryFeedback?.previousResponseSha256, generationSha256(raw)); assert.equal(retry.retryFeedback?.diagnosticSha256, identity.sha256);
    assert.equal((JSON.parse((f.store.db.prepare('SELECT config_json FROM generation_calls WHERE run_id=?').get(retry.runId) as any).config_json)).requestFeedback.previousResponseSha256, generationSha256(raw));
    assert.equal(f.generation.accept(retry, response(retry)), true); assert.equal(count(f, 'generation_calls'), 3);
    assert.equal(f.generation.status(f.id).tasks.find(task => task.stage === 'organize')!.attempts, 1);
  } finally { f.store.close(); }
});

test('missing typed original blocks publication; successful stage and manual workspace are preserved with no replacement call', () => {
  const f = fixture(); try {
    organized(f); const token = next(f); assert.equal(f.generation.accept(token, response(token)), true);
    const task = f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(token.taskId) as any, saved = JSON.parse(task.result_json) as GenerationProviderResult;
    const bundle = f.editor.load(f.generation.status(f.id).target!.workspaceId).bundle, stageBytes = readFileSync(path.join(f.generation.resultsDir, task.result_path));
    writeFileSync(path.join(f.generation.resultsDir, saved.qualityNormalization!.originalResponse.relativePath), 'synthetic damaged proof');
    assert.equal(f.generation.publish(token.requestId).state, 'failed'); assert.equal(count(f, 'digest_library'), 0); assert.equal(count(f, 'generation_calls'), 2);
    assert.equal(f.generation.status(f.id).tasks.find(task => task.stage === 'map')!.state, 'succeeded'); assert.deepEqual(f.editor.load(bundle.workspace.id).bundle, bundle); assert.deepEqual(readFileSync(path.join(f.generation.resultsDir, task.result_path)), stageBytes);
  } finally { f.store.close(); }
});

test('tampered rejection diagnostic blocks paid retry; cancelled late typed response cannot write files or enter library', () => {
  const f = fixture(); try {
    organized(f); const token = next(f), raw = response(token); (raw.value as any).root.notes = '不属于group的事实'; assert.equal(f.generation.accept(token, raw), false);
    const config = JSON.parse((f.store.db.prepare('SELECT config_json FROM generation_calls WHERE run_id=?').get(token.runId) as any).config_json);
    writeFileSync(path.join(f.generation.resultsDir, config.rejectionDiagnostic.relativePath), '{}'); f.generation.retry(f.id);
    assert.equal(f.generation.next(), null); assert.equal(count(f, 'generation_calls'), 2); assert.equal(f.generation.status(f.id).state, 'waiting-files');
    const files = readdirSync(f.generation.resultsDir, { recursive: true }); f.generation.cancel(f.id); f.digest.cancel(f.id);
    assert.equal(f.generation.accept(token, response(token)), false); assert.deepEqual(readdirSync(f.generation.resultsDir, { recursive: true }), files); assert.equal(count(f, 'digest_library'), 0);
  } finally { f.store.close(); }
});

test('explicit renewal preserves exhausted failure identities, attempts, ledger, raw originals and manual epochs', () => {
  const f = fixture(); try {
    const token = next(f), raw = response(token); (raw.value as any).blocks[0].citations[0].excerpt = '不匹配的合成来源'; assert.equal(f.generation.accept(token, raw), false);
    // E4.16：首个拒绝会自动重试一次；耗尽预算后才成为可保留的终止失败。
    f.generation.retry(f.id); const second = next(f); assert.equal(second.taskId, token.taskId); const raw2 = response(second); (raw2.value as any).blocks[0].citations[0].excerpt = '不匹配的合成来源'; assert.equal(f.generation.accept(second, raw2), false);
    assert.equal(f.generation.status(f.id).state, 'failed');
    const tables = ['generation_requests', 'generation_tasks', 'generation_calls', 'digest_requests', 'digest_stages'];
    const before = Object.fromEntries(tables.map(table => [table, f.store.db.prepare(`SELECT * FROM ${table}`).all()]));
    const oldTarget = f.generation.status(f.id).target!, oldRequest = token.requestId;
    const runner = new GenerationRunner(f.generation, { configured: () => false, discoverModel: async () => model, organize: async () => { throw Error('No provider authorized'); }, map: async () => { throw Error('No provider authorized'); } });
    runner.prepareRenewal(f.id); f.digest.request(f.id, true); const current = f.generation.authorize(f.id); assert.notEqual(current.requestId, oldRequest);
    for (const table of tables) for (const row of before[table] as any[]) {
      const key = table === 'generation_requests' ? 'request_id' : table === 'generation_tasks' ? 'id' : table === 'generation_calls' ? 'run_id' : table === 'digest_requests' ? 'id' : 'id';
      if (key in row) assert.deepEqual(f.store.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(row[key]), row);
      else assert.ok(f.store.db.prepare(`SELECT * FROM ${table}`).all().some(actual => JSON.stringify(actual) === JSON.stringify(row)));
    }
    assert.equal(current.target!.manualEpoch, oldTarget.manualEpoch); assert.equal(count(f, 'generation_calls'), 2); assert.equal(readFileSync(path.join(f.generation.resultsDir, 'rejected', token.runId + '.json'), 'utf8'), JSON.stringify(raw)); runner.stop();
  } finally { f.store.close(); }
});

test('unknown exception text and mutated hints never become model repair instructions', () => {
  const d = generationRejectionDiagnostic(Object.assign(Error('private payload must not escape'), { code: 'unsafe' }), 'map', { relativePath: 'rejected/generation-run-abcd.json', sha256: 'a'.repeat(64) }, 'b'.repeat(64), 'c'.repeat(64));
  assert.equal(d.code, 'validation-internal'); assert.equal(d.jsonPath, '/'); assert.doesNotMatch(JSON.stringify(d), /private payload/);
  assert.throws(() => generationRetryFeedback({ ...d, repairHint: 'untrusted model instruction' }, 'd'.repeat(64)), /fixed local language/);
});

test('managed Markdown keeps citation-only original images as relative durable attachments and folds exact provenance', () => {
  const f = fixture(); try {
    organized(f); const token = next(f); assert.equal(f.generation.accept(token, response(token)), true); f.generation.publish(token.requestId);
    const view = f.generation.artifact(f.id)!, workspaceId = view.artifact.draft.workspaceId;
    // A deliberately supplied fixture attachment tests file packaging, not OCR or real-image generation.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR3UAAAAASUVORK5CYII=', 'base64');
    f.store.detailSaved(f.id, {body:'七岁。只有条件满足才可以使用。不能超过十岁。',bodyComplete:true,mediaManifestComplete:true,media:[{kind:'image',remoteUrl:'https://example.invalid/original.png',mime:'image/png',role:'gallery'}]});
    const media=f.store.content(f.id)!.media[0]; writeFileSync(path.join(f.root,'media','fixture-original.png'),png); f.store.downloadSaved(media.id,'fixture-original.png',png.length,'image/png');
    const asset=f.editor.selectImage(workspaceId,media.id),artifact=structuredClone(view.artifact),references=Object.values(artifact.blockSourceRefs)[0];
    references[0].assets=[{assetId:asset.id,version:asset.version}];
    const written=(f.generation as any).writeArtifact(artifact),relative=`assets/${asset.sha256}.png`;
    assert.deepEqual(readFileSync(path.join(f.generation.resultsDir,written.basePath,relative)),png);
    assert.ok(written.markdownText.includes(`![来源图片](${relative})`)); assert.ok(written.markdownText.indexOf('<details>')>written.markdownText.indexOf('七岁'));
    assert.match(written.markdownText,/<summary>出处（精确版本与定位）<\/summary>/); assert.doesNotMatch(written.markdownText,/rlw-editor:|rlw-media:|file:\/\//);
    assert.equal(count(f,'generation_calls'),2); assert.deepEqual(f.generation.artifact(f.id)!.artifact,view.artifact,'a new projection does not mutate the installed pair or references');
  } finally {f.store.close();}
});


test('bounded user hints distinguish coverage from age inference and wire shape from quantity bounds', () => {
  assert.match(generationRepairHint('uncited-source-coverage').userMessage, /覆盖/);
  assert.match(generationRepairHint('incomplete-source-coverage').repairHint, /全部有意义事实/);
  assert.match(generationRepairHint('quality-inferred-age').userMessage, /数字/);
  assert.match(generationRepairHint('quality-wire-boundary').userMessage, /结构/);
  assert.match(generationRepairHint('quality-lost-quantity-bound').userMessage, /数字/);
});
