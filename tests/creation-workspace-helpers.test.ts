import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creationStageLabel, generationReplacementBarrier, hasReadableCreationDocument, markdownStatus, mayInstallGeneration, sameGenerationTarget } from '../src/renderer/creation-workspace-helpers.js';
import type { GenerationState, GenerationTarget } from '../src/shared/generation-contracts.js';
import type { DigestContentState } from '../src/shared/digest-contracts.js';

const target: GenerationTarget = { workspaceId: 'w', draftDocumentId: 'd', mapDocumentId: 'm', draftRevision: 0, mapRevision: 0, contentSha256: 'a'.repeat(64), manualEpoch: 0, managed: true };
const state: GenerationState = { contentId: 1, requestId: 'request-1', authorized: true, state: 'waiting-configuration', sourceRevisionId: 'scope-1', target, model: null, tasks: [], candidate: null, currentArtifactId: null, canRestorePrevious: false, markdown: { state: 'none' } };
test('E3 missing model and missing credentials remain distinct waiting states', () => {
 assert.equal(creationStageLabel(state), '等待生成配置');
 assert.equal(creationStageLabel({ ...state, state: 'waiting-model' }), '等待可用生成模型');
 assert.equal(creationStageLabel({ ...state, state: 'waiting-model', errorCode: 'input-limit', error: '转录稿约 10.0 万字，超过单次整理上限（约 9.6 万字），未截断' }), '来源过长，暂时不能整理');
 assert.equal(creationStageLabel({ ...state, state: 'queued', tasks: [{ id: 't', stage: 'organize', chunkId: 'c', order: 7, state: 'queued', attempts: 1, reused: false, mayDuplicateCharge: false, errorCode: 'invalid-output' }] }), '正在重试第 8 段（上次结果未通过出处校验）');
 assert.equal(creationStageLabel(null), '还没开始消化');
 assert.equal(creationStageLabel({ ...state, state: 'waiting-content' }), '缺少可整理内容');
});
test('E4.4 request states map to their own labels instead of a blanket in-flight label', () => {
 const digestWith = (requestState: string) => ({ request: { state: requestState }, stages: [] }) as unknown as DigestContentState;
 assert.equal(creationStageLabel(null), '还没开始消化');
 assert.equal(creationStageLabel(null, digestWith('cancelled')), '已取消，可重新消化');
 assert.equal(creationStageLabel(null, digestWith('failed')), '消化失败，可重试');
 assert.equal(creationStageLabel(null, digestWith('result-unknown')), '上次请求结果未知，可重试');
 assert.equal(creationStageLabel(null, digestWith('queued')), '正在建立消化请求');
 // 已取消的必需阶段不再被误判成"识别处理中"
 const cancelledStage = { request: { state: 'cancelled' }, stages: [{ name: 'asr', label: '音频文字稿识别', required: true, state: 'cancelled' }] } as unknown as DigestContentState;
 assert.equal(creationStageLabel(null, cancelledStage), '已取消，可重新消化');
});
test('E3 progress uses genuine extraction counts and active generation phase', () => {
 const digest = { stages: [{ name: 'ocr', label: '图片文字识别', required: true, state: 'running', progress: { succeeded: 2, noText: 1, total: 8 } }] } as unknown as DigestContentState;
 assert.equal(creationStageLabel({ ...state, state: 'waiting-extraction' }, digest), '图片文字识别 3/8 · 处理中');
 assert.equal(creationStageLabel({ ...state, state: 'running', tasks: [{ id: 't', stage: 'map', chunkId: '1', order: 0, state: 'running', attempts: 1, reused: false, mayDuplicateCharge: false }] }), '正在提炼可编辑导图');
});
test('E3 install guard fences collection, request and sticky manual intent', () => {
 assert.equal(mayInstallGeneration(1, 1, 'r1', 'r1', false), true);
 assert.equal(mayInstallGeneration(1, 2, 'r1', 'r1', false), true);
 assert.equal(mayInstallGeneration(1, 2, 'r1', 'r2', true), true);
 assert.equal(mayInstallGeneration(1, 1, 'r2', 'r1', false), false);
 assert.equal(mayInstallGeneration(1, 1, null, 'r1', false), false);
 // An explicitly cleared document or merely pending durable touch still has manual intent.
 assert.equal(mayInstallGeneration(1, 1, 'r1', 'r1', true), false);
});
test('E3 target equality includes both revisions, scope hash and durable manual epoch', () => {
 assert.equal(sameGenerationTarget(target, { ...target }), true);
 for (const patch of [{ workspaceId: 'w2' }, { draftDocumentId: 'd2' }, { mapDocumentId: 'm2' }, { draftRevision: 1 }, { mapRevision: 1 }, { contentSha256: 'b'.repeat(64) }, { manualEpoch: 1 }, { managed: false }]) assert.equal(sameGenerationTarget(target, { ...target, ...patch }), false);
 assert.equal(sameGenerationTarget(null, target), false);
});
test('E3 saved canonical body is never described as an up-to-date failed derived file', () => {
 assert.equal(markdownStatus({ state: 'ready', draftRevision: 3 }), 'Markdown 导出已更新 · 正文版本 3');
 assert.equal(markdownStatus({ state: 'pending', draftRevision: 4 }), '正文已保存 · Markdown 导出待更新');
 assert.equal(markdownStatus({ state: 'failed', draftRevision: 4, error: 'ENOSPC' }), '导出可能不是最新版本');
 assert.equal(markdownStatus({ state: 'none' }), 'Markdown 导出尚未生成');
});
test('E3 explicit adoption releases dirty lease only after successful save and durable protection', async () => {
 let dirty = true, epoch = 0; const order: string[] = [];
 assert.equal(await generationReplacementBarrier({ save: async () => { order.push('save'); return true; }, protect: async () => { order.push('touch'); ++epoch; dirty = true; return true; }, release: async () => { order.push('release'); dirty = false; } }), true);
 assert.deepEqual(order, ['save', 'touch', 'release']); assert.equal(dirty, false); assert.equal(epoch, 1);
 // The durable epoch protects even deliberately empty documents after lease release.
 assert.equal(sameGenerationTarget(target, { ...target, manualEpoch: epoch }), false);
});
test('E3 save/IME failure or lease failure prevents replacement and keeps protection', async () => {
 let releases = 0, touches = 0;
 assert.equal(await generationReplacementBarrier({ save: async () => false, protect: async () => { ++touches; return true; }, release: async () => { ++releases; } }), false);
 assert.equal(touches, 0); assert.equal(releases, 0);
 assert.equal(await generationReplacementBarrier({ save: async () => true, protect: async () => false, release: async () => { ++releases; } }), false);
 assert.equal(releases, 0);
 await assert.rejects(generationReplacementBarrier({ save: async () => true, release: async () => { throw new Error('lease IPC unavailable'); } }), /lease IPC unavailable/);
});


test('E3 saved current pairs stay readable independently of a missing or damaged latest artifact', () => {
 const saved = { ...target, draftRevision: 3, mapRevision: 4 };
 for (const currentArtifactId of [null, 'missing-or-damaged-exact-package']) {
  assert.equal(hasReadableCreationDocument({ ...state, target: saved, currentArtifactId }), true);
  assert.equal(hasReadableCreationDocument({ ...state, target: { ...saved, managed: false, manualEpoch: 8 }, currentArtifactId }), true);
 }
 assert.equal(hasReadableCreationDocument({ ...state, target: null }), false);
});

test('E3 managed revision-zero system placeholders never become generated results via a fallback', () => {
 assert.equal(hasReadableCreationDocument(state), false);
 assert.equal(hasReadableCreationDocument({ ...state, currentArtifactId: 'broken-package' }), false);
 assert.equal(hasReadableCreationDocument({ ...state, target: { ...target, draftRevision: 1 } }), false);
 // Explicitly empty human work is a saved document; text length cannot decide origin.
 assert.equal(hasReadableCreationDocument({ ...state, target: { ...target, managed: false, manualEpoch: 1 } }), true);
});
