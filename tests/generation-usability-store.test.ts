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

const model: GenerationModelSelection = { provider: 'deepseek', model: 'synthetic-zero-http', discoveredAt: 1, accountModelsSha256: 'a'.repeat(64), publishedContextTokens: 65536, providerOutputLimitTokens: null, inputBudgetUtf8Bytes: 32000, maxOutputTokens: 16384, applicationContextBudgetTokens: 65536, responseFormat: 'json_object', promptVersion: 'read-create-usability-v3', configurationSha256: 'b'.repeat(64), capabilitySources: ['synthetic only, no provider'] };
function fixture() {
  const base = path.resolve('.acceptance-data/editor-e3-real'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'usability-store-')), store = new Store(root);
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
  const citation = { unitId: unit.id, start: wrongCoordinates ? 100 : 0, end: wrongCoordinates ? 3700 : length, excerpt: wrongCoordinates ? '合理润色的AI文本，不是原识别' : unit.text };
  const value: unknown = token.stage === 'organize' ? {
    schemaVersion: 1, sourceRevisionId: token.input.sourceRevisionId, title: '使用说明', lead: '', blocks: [{ id: 'body', type: 'paragraph', text: unit.text, role: 'fact', citations: [citation] }], coverage: [{ unitId: unit.id, start: citation.start, end: citation.end, disposition: 'included' }],
  } : {
    schemaVersion: 2, sourceRevisionId: token.input.sourceRevisionId, organizedSha256: generationSha256(token.organized), root: { kind: 'group', topic: '使用说明', children: [{ kind: 'claim', title: '使用条件', explanation: unit.text, citations: [citation], children: [] }] },
  };
  return { value, rawResponse: { object: 'synthetic-zero-http', choices: [{ message: { content: JSON.stringify(value) } }] }, model: model.model, configurationSha256: model.configurationSha256, promptVersion: model.promptVersion };
}
function organized(f: F) { const token = next(f); assert.equal(token.stage, 'organize'); assert.equal(f.generation.accept(token, response(token)), true); return token; }


test('v3 new request saves a real pair with explicit coarse proof, automatic first install and durable re-open without extra calls',()=>{
 const f=fixture();try{
  const organize=next(f),raw=response(organize,true),original=JSON.stringify(raw);assert.equal(f.generation.accept(organize,raw),true);
  const task=f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(organize.taskId) as any,saved=JSON.parse(task.result_json) as GenerationProviderResult;
  assert.equal(saved.coordinateNormalization!.policyVersion,'source-association-usability-v1');assert.equal((saved.value as OrganizedDocument).blocks[0].citations[0].granularity,'source-unit');
  assert.equal(readFileSync(path.join(f.generation.resultsDir,saved.coordinateNormalization!.originalResponse.relativePath),'utf8'),original);
  const map=next(f);assert.equal(map.stage,'map');assert.equal(f.generation.accept(map,response(map,true)),true);assert.equal(f.generation.publish(map.requestId).state,'succeeded');assert.equal(count(f,'digest_library'),1);
  const view=f.generation.artifact(f.id)!;assert.ok(view.installed);assert.equal(f.generation.candidate(f.id),null);assert.match(view.artifact.review.reason,/AI 整理稿，可编辑校对/);assert.ok(view.markdownText.includes('七岁'));
  const reopened=new GenerationRepository(f.store.db,f.root,new EditorRepository(f.store.db,f.root),f.digest);assert.deepEqual(reopened.artifact(f.id),view);assert.equal(reopened.next(),null);assert.equal(count(f,'generation_calls'),2);
 }finally{f.store.close();}
});

test('new source proof remains bounded to the frozen source and its corruption blocks downstream publication without losing manual data',()=>{
 const f=fixture();try{
  const token=next(f),raw=response(token,true);assert.equal(f.generation.accept(token,raw),true);
  const task=f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(token.taskId) as any,saved=JSON.parse(task.result_json),target=f.generation.status(f.id).target!,before=f.editor.load(target.workspaceId).bundle;
  writeFileSync(path.join(f.generation.resultsDir,saved.coordinateNormalization.originalResponse.relativePath),'synthetic proof corruption');assert.equal(f.generation.next(),null);assert.equal(count(f,'generation_calls'),1);assert.equal(count(f,'digest_library'),0);assert.deepEqual(f.editor.load(target.workspaceId).bundle,before);
 }finally{f.store.close();}
});

test('unknown source rejects before publication; explicit retry reuses same input and cancel rejects late data without files or library writes',()=>{
 const f=fixture();try{
  const token=next(f),raw=response(token);(raw.value as any).blocks[0].citations[0].unitId='foreign-source';assert.equal(f.generation.accept(token,raw),false);assert.equal(count(f,'digest_library'),0);
  f.generation.retry(f.id);const retry=next(f);assert.equal(retry.requestId,token.requestId);assert.equal(retry.inputSha256,token.inputSha256);assert.equal(retry.retryFeedback!.jsonPath,'/blocks/0/citations/0');assert.equal(retry.retryFeedback!.code,'unknown-source-unit');
  f.generation.cancel(f.id);f.digest.cancel(f.id);const before=readdirSync(f.generation.resultsDir,{recursive:true});assert.equal(f.generation.accept(retry,response(retry)),false);assert.deepEqual(readdirSync(f.generation.resultsDir,{recursive:true}),before);assert.equal(count(f,'digest_library'),0);
 }finally{f.store.close();}
});

test('human edits during generation remain current and the new full pair is a previewable candidate until explicit adoption',()=>{
 const f=fixture();try{
  const token=next(f);assert.equal(f.generation.accept(token,response(token,true)),true);
  const target=f.generation.status(f.id).target!,bundle=f.editor.load(target.workspaceId).bundle;
  f.generation.touch(f.id,'synthetic-editor',true);const draft=structuredClone(bundle.draft);draft.blocks=[{id:'manual-p',type:'paragraph',runs:[{text:'这是必须保留的人工稿'}]}];
  const result=f.editor.save([{workspaceId:target.workspaceId,documentId:draft.documentId,sessionId:'synthetic-editor',requestId:'manual-save',expectedRevision:draft.revision,document:draft}]);assert.equal(result[0].status,'saved');f.generation.release(f.id,'synthetic-editor');
  const manual=f.editor.load(target.workspaceId).bundle;assert.equal(manual.draft.blocks[0].runs[0].text,'这是必须保留的人工稿');const map=next(f);assert.equal(f.generation.accept(map,response(map,true)),true);assert.equal(f.generation.publish(map.requestId).state,'succeeded');
  assert.deepEqual(f.editor.load(target.workspaceId).bundle,manual);const candidate=f.generation.candidate(f.id)!;assert.ok(candidate.candidate);assert.equal(candidate.installed,false);assert.ok(candidate.artifact.draft.blocks.some(block=>block.runs.some(run=>run.text===token.input.units[0].text)));assert.equal(count(f,'generation_calls'),2);
  f.generation.adopt(f.id,candidate.id,f.generation.status(f.id).target!);assert.equal(f.generation.candidate(f.id),null);assert.equal(f.generation.artifact(f.id)!.installed,true);assert.equal(count(f,'generation_calls'),2);
 }finally{f.store.close();}
});

test('v3 duplicate clicks remain one request and a map-only retry keeps the successful coarse-source upstream and frozen identities',()=>{
 const f=fixture();try{
  const first=f.generation.status(f.id).requestId!;
  f.digest.request(f.id);assert.equal(f.generation.authorize(f.id).requestId,first);f.digest.request(f.id);assert.equal(f.generation.authorize(f.id).requestId,first);
  assert.equal(count(f,'generation_requests'),1);assert.equal(count(f,'generation_calls'),0);
  const organize=next(f);assert.equal(f.generation.accept(organize,response(organize,true)),true);
  const upstream=f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(organize.taskId) as any,stageBytes=readFileSync(path.join(f.generation.resultsDir,upstream.result_path)),saved=JSON.parse(upstream.result_json) as GenerationProviderResult,proofBytes=readFileSync(path.join(f.generation.resultsDir,saved.coordinateNormalization!.originalResponse.relativePath));
  const frozen=f.store.db.prepare('SELECT input_json,input_sha,model_json FROM generation_requests WHERE request_id=?').get(first);
  const failedMap=next(f),bad=response(failedMap);assert.equal(failedMap.stage,'map');(bad.value as any).root.children[0].citations[0].unitId='not-this-frozen-source';assert.equal(f.generation.accept(failedMap,bad),false);assert.equal(count(f,'digest_library'),0);
  f.generation.retry(f.id);const retry=next(f);assert.equal(retry.requestId,first);assert.equal(retry.stage,'map');assert.equal(retry.taskId,failedMap.taskId);assert.equal(retry.inputSha256,failedMap.inputSha256);assert.deepEqual(retry.model,failedMap.model);
  assert.equal(f.generation.accept(retry,response(retry,true)),true);assert.equal(f.generation.publish(first).state,'succeeded');
  assert.equal(count(f,'generation_calls'),3);assert.equal(f.generation.status(f.id).tasks.find(t=>t.stage==='organize')!.attempts,1);assert.equal(f.generation.status(f.id).tasks.find(t=>t.stage==='map')!.attempts,2);
  assert.deepEqual(f.store.db.prepare('SELECT input_json,input_sha,model_json FROM generation_requests WHERE request_id=?').get(first),frozen);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(organize.taskId),upstream);assert.deepEqual(readFileSync(path.join(f.generation.resultsDir,upstream.result_path)),stageBytes);assert.deepEqual(readFileSync(path.join(f.generation.resultsDir,saved.coordinateNormalization!.originalResponse.relativePath)),proofBytes);
  assert.equal(f.generation.next(),null);assert.equal(count(f,'generation_requests'),1);assert.equal(count(f,'digest_library'),1);
 }finally{f.store.close();}
});

test('a first invalid-output auto-requeues the chunk with bounded feedback; a second rejection fails honestly',()=>{
 const f=fixture();try{
  const token=next(f),raw=response(token);(raw.value as any).blocks[0].citations[0].unitId='foreign-source';
  assert.equal(f.generation.accept(token,raw),false);
  assert.equal(f.generation.status(f.id).state,'queued','首次出处拒绝自动重试，不整体失败');
  const task=f.store.db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(token.taskId) as any;
  assert.equal(task.state,'queued');assert.equal(task.attempts,1);assert.ok(task.not_before>Date.now(),'退避期内');
  assert.equal(JSON.parse(task.error_json).code,'invalid-output');
  f.store.db.prepare('UPDATE generation_tasks SET not_before=0 WHERE id=?').run(token.taskId);
  const retry=next(f);assert.equal(retry.taskId,token.taskId);assert.equal(retry.retryFeedback!.code,'unknown-source-unit');assert.equal(retry.retryFeedback!.jsonPath,'/blocks/0/citations/0');
  const raw2=response(retry);(raw2.value as any).blocks[0].citations[0].unitId='foreign-source';
  assert.equal(f.generation.accept(retry,raw2),false);
  assert.equal(f.generation.status(f.id).state,'failed');assert.equal(f.generation.status(f.id).errorCode,'invalid-output');
  assert.equal(f.digest.status(f.id).request!.state,'failed');
  assert.equal(f.generation.next(),null);assert.equal(count(f,'generation_calls'),2);assert.equal(count(f,'digest_library'),0);
 }finally{f.store.close();}
});
