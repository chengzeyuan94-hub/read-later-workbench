import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, pointLength, pointSlice, type ResolvedReference, type SourceReference } from '../src/editor-core/model.js';
import type { GeneratedMap, GenerationFrozenInput, OrganizedDocument } from '../src/shared/generation-contracts.js';
import { buildGenerationArtifact, freezeGenerationPlan, generationSha256, mergeGeneratedMaps, mergeOrganizedDocuments, resolveGenerationCitation, validateGeneratedMap, validateGenerationInput, validateOrganizedDocument } from '../src/main/generation-validation.js';
import { GENERATION_MODEL_POLICY, GenerationProviderError, SiliconFlowGenerationProvider } from '../src/main/generation-provider.js';

// Entirely synthetic contracts and HTTP fixtures; none is evidence of real generation quality.
function fixture(texts = ['先看🙂原件，再加10毫升；如果温度至少20℃，不能超过30℃。', '必须保留来源，可能需要人工校对。']) {
  const input: GenerationFrozenInput = { sourceRevisionId: 'source-v1', title: '合成机制资料', units: texts.map((text, index) => ({ id: `unit-${index}`, kind: 'capturedSource', text, reference: { kind: 'capturedSource', sourceId: 'source', sourceRevisionId: 'source-v1', blockId: `block-${index}` }, versionIdentity: `source-v1/block-${index}`, coverage: 'complete', warnings: [] })) };
  const resolver = (ref: SourceReference): ResolvedReference => { if (ref.kind !== 'capturedSource' || ref.sourceId !== 'source' || ref.sourceRevisionId !== 'source-v1') throw new Error('wrong fixture source'); const index = Number(ref.blockId.split('-')[1]), raw = texts[index]; if (raw === undefined) throw new Error('wrong fixture block'); const selectedText = ref.range ? pointSlice(raw, ref.range.start, ref.range.end) : raw; if (ref.range?.excerpt !== undefined && selectedText !== ref.range.excerpt) throw new Error('fixture excerpt mismatch'); return { kind: 'capturedSource', text: raw, selectedText, version: 'source-v1', targetId: ref.blockId, assets: [] }; };
  const document: OrganizedDocument = { schemaVersion: 1, sourceRevisionId: 'source-v1', title: '合成整理结果', lead: '', blocks: input.units.map((unit, index) => ({ id: `body-${index}`, type: 'paragraph', text: unit.text, role: 'fact', citations: [{ unitId: unit.id, start: 0, end: pointLength(unit.text), excerpt: unit.text }] })), coverage: input.units.map(unit => ({ unitId: unit.id, start: 0, end: pointLength(unit.text), disposition: 'included' })) };
  const mapFor = (organized = document): GeneratedMap => ({ schemaVersion: 1, sourceRevisionId: 'source-v1', organizedSha256: generationSha256(organized), rootId: 'root', nodes: [{ id: 'root', parentId: null, children: organized.blocks.map((_, index) => `point-${index}`), title: '合成主题', notes: '', role: 'structure', citations: [] }, ...organized.blocks.map((block, index) => ({ id: `point-${index}`, parentId: 'root', children: [], title: '有依据的观点', notes: block.text, role: 'fact' as const, citations: clone(block.citations) }))] });
  return { input, resolver, document, mapFor };
}
function bad(fn: () => unknown, expected: string) { assert.throws(fn, error => error instanceof Error && (error as { code?: string }).code === expected); }

test('generation exact Unicode citations resolve their own frozen source version without UTF-16/NFC rewriting', () => {
  const f = fixture(['🙂e\u0301 10毫升']);
  const ref = resolveGenerationCitation(f.input, { unitId: 'unit-0', start: 1, end: 3, excerpt: 'e\u0301' }, f.resolver);
  assert.deepEqual(ref.range, { start: 1, end: 3, unit: 'unicode-code-point', excerpt: 'e\u0301' });
  bad(() => resolveGenerationCitation(f.input, { unitId: 'unit-0', start: 2, end: 3, excerpt: 'e\u0301' }, f.resolver), 'citation-excerpt');
  bad(() => resolveGenerationCitation(f.input, { unitId: 'unknown', start: 0, end: 1, excerpt: '🙂' }), 'unknown-source-unit');
  const changed = clone(f.input); changed.units[0].text = '不同版本'; bad(() => validateGenerationInput(changed, f.resolver), 'source-version-text-mismatch');
});

test('generation chunk manifest covers every exact source code point, preserves order and refuses over-budget tails', () => {
  const f = fixture(['甲'.repeat(4500) + '\n末尾必须保留', '乙'.repeat(4300)]), plan = freezeGenerationPlan(f.input);
  assert.equal(plan.chunks.length, 3); assert.equal(plan.maxAttemptsPerStagePerChunk, 2);
  for (const unit of f.input.units) { const parts = plan.chunks.flatMap(chunk => chunk.slices).filter(slice => slice.unitId === unit.id); assert.equal(parts[0].start, 0); assert.equal(parts.at(-1)!.end, pointLength(unit.text)); for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end); assert.equal(parts.map(part => pointSlice(unit.text, part.start, part.end)).join(''), unit.text); }
  bad(() => freezeGenerationPlan(f.input, { maxChunks: 2 }), 'input-limit');
  const partial = clone(f.input); partial.units[0].coverage = 'partial'; bad(() => freezeGenerationPlan(partial), 'source-incomplete');
});

test('generation rejects false coverage, wrong excerpts, missing facts and dangerous extra output fields', () => {
  const f = fixture(); validateOrganizedDocument(f.document, f.input, { resolve: f.resolver });
  const cases: [string, (value: OrganizedDocument) => void][] = [
    ['incomplete-source-coverage', value => { value.coverage.pop(); }],
    ['citation-excerpt', value => { value.blocks[0].citations[0].excerpt = '编造原文'; }],
    ['missing-factual-citation', value => { value.blocks[0].citations = []; }],
    ['unsupported-critical-fact', value => { value.blocks[0].text += '额外添加999公斤。'; }],
    ['omitted-critical-source', value => { value.blocks[0].text = value.blocks[0].text.replace('不能', '可以'); }],
    ['unknown-output-field', value => { (value.blocks[0] as any).path = '/private/forbidden'; }],
  ];
  for (const [expected, mutate] of cases) { const value = clone(f.document); mutate(value); bad(() => validateOrganizedDocument(value, f.input), expected); }
  const plain = fixture(['原始正文主体应保留。']), falseRange = clone(plain.document); falseRange.blocks[0].citations[0] = { unitId: 'unit-0', start: 0, end: 1, excerpt: '原' }; bad(() => validateOrganizedDocument(falseRange, plain.input), 'uncited-source-coverage');
  const source = fixture(['清晰正文内容需要完整保留。'.repeat(30)]), summary = clone(source.document); summary.blocks[0].text = '简短摘要。'; bad(() => validateOrganizedDocument(summary, source.input), 'summary-instead-of-manuscript');
  const collision = clone(f.document); collision.blocks[0].type = 'quote'; collision.blocks[1].id = collision.blocks[0].id + '-text'; bad(() => validateOrganizedDocument(collision, f.input), 'invalid-draft-tree');
});

test('generation never globally deduplicates identical utterances at different positions', () => {
  const f = fixture(['重复讲话。', '重复讲话。']), value = clone(f.document); value.blocks.pop(); value.coverage[1] = { unitId: 'unit-1', start: 0, end: 5, disposition: 'duplicate', duplicateOf: { unitId: 'unit-0', start: 0, end: 5, excerpt: '重复讲话。' } };
  bad(() => validateOrganizedDocument(value, f.input), 'duplicate-proof');
});

test('generation map validation rejects cycles/ownership errors and cross-version pairs; final artifact binds body SHA/revision and exact references', () => {
  const f = fixture(); f.document.lead = '保留原件与来源。'; f.document.leadCitations = [clone(f.document.blocks[0].citations[0])]; const map = f.mapFor(); validateGeneratedMap(map, f.input, f.document, { resolve: f.resolver });
  const stale = clone(map); stale.organizedSha256 = 'a'.repeat(64); bad(() => validateGeneratedMap(stale, f.input, f.document), 'map-organized-version');
  const cycle = clone(map); cycle.nodes[1].children = ['root']; bad(() => validateGeneratedMap(cycle, f.input, f.document), 'invalid-map-tree');
  const duplicate = clone(map); duplicate.nodes.push(clone(duplicate.nodes[1])); bad(() => validateGeneratedMap(duplicate, f.input, f.document), 'duplicate-map-node');
  const artifact = buildGenerationArtifact(f.input, f.document, map, { workspaceId: 'workspace', draftDocumentId: 'draft', mapDocumentId: 'map', draftRevision: 7, resolve: f.resolver });
  assert.equal(artifact.draft.revision, 7); assert.equal(artifact.draftSha256, generationSha256(artifact.draft)); assert.equal(artifact.blockSourceRefs['body-0'][0].range!.excerpt, f.input.units[0].text); assert.equal(artifact.review.state, 'required'); assert.equal(artifact.map.nodes['point-0'].sourceRefs[0].kind, 'capturedSource');
  assert.equal(artifact.draft.blocks[0].runs[0].text, f.document.lead); assert.equal(artifact.blockSourceRefs[artifact.draft.blocks[0].id][0].range!.excerpt, f.input.units[0].text);
});

test('generation deterministic chunk merging requires complete parts and verifies each map organized SHA before namespace merging', () => {
  const f = fixture(['甲'.repeat(30), '乙'.repeat(30)]), plan = freezeGenerationPlan(f.input, { maxChunkCodePoints: 30 });
  const documents = plan.chunks.map(chunk => ({ ...clone(f.document), blocks: f.document.blocks.filter(block => chunk.slices.some(slice => slice.unitId === block.citations[0].unitId)), coverage: f.document.coverage.filter(item => chunk.slices.some(slice => slice.unitId === item.unitId)) }));
  const merged = mergeOrganizedDocuments(documents, f.input, plan), maps = documents.map(document => f.mapFor(document)), result = mergeGeneratedMaps(maps, f.input, merged, documents);
  assert.equal(merged.blocks.length, 2); assert.equal(result.nodes.length, 5); assert.equal(result.organizedSha256, generationSha256(merged)); assert.equal(new Set(result.nodes.map(node => node.id)).size, result.nodes.length);
  const wrong = clone(maps); wrong[1].organizedSha256 = 'a'.repeat(64); bad(() => mergeGeneratedMaps(wrong, f.input, merged, documents), 'map-organized-version');
});

test('generation merges 17-24 chunk maps under the raised ceiling and keeps the 1000-node merged cap', () => {
  for (const n of [17, 20, 24]) {
    const f = fixture(Array.from({ length: n }, () => '字'.repeat(4000))), plan = freezeGenerationPlan(f.input);
    assert.equal(plan.chunks.length, n);
    const documents = plan.chunks.map(chunk => ({ schemaVersion: 1 as const, sourceRevisionId: f.input.sourceRevisionId, title: '分块', lead: '', blocks: chunk.slices.map((slice, index) => { const unit = f.input.units.find(unit => unit.id === slice.unitId)!, text = pointSlice(unit.text, slice.start, slice.end); return { id: `b-${index}`, type: 'paragraph' as const, text, role: 'fact' as const, citations: [{ unitId: unit.id, start: slice.start, end: slice.end, excerpt: text }] }; }), coverage: chunk.slices.map(slice => ({ unitId: slice.unitId, start: slice.start, end: slice.end, disposition: 'included' as const })) }));
    const merged = mergeOrganizedDocuments(documents, f.input, plan), maps = documents.map(document => f.mapFor(document)), result = mergeGeneratedMaps(maps, f.input, merged, documents);
    assert.equal(result.nodes.length, 1 + n * 2);
    if (n === 24) {
      bad(() => mergeGeneratedMaps(maps.concat([maps[0]]), f.input, merged), 'merge-map-count');
      const dense = maps.map(map => { const copy = clone(map); for (let i = 0; i < 42; i++) { copy.nodes.push({ id: `extra-${i}`, parentId: 'root', children: [], title: `分支${i}`, notes: '', role: 'structure', citations: [] }); copy.nodes[0].children.push(`extra-${i}`); } return copy; });
      bad(() => mergeGeneratedMaps(dense, f.input, merged, documents), 'map-count');
    }
  }
});

const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const models = () => jsonResponse({ object: 'list', data: [{ id: GENERATION_MODEL_POLICY.candidates[0].id, object: 'model', created: 0, owned_by: 'fixture' }] });
const completion = (value: unknown, finish = 'stop') => jsonResponse({ object: 'chat.completion', model: GENERATION_MODEL_POLICY.candidates[0].id, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
async function errorCode(promise: Promise<unknown>, expected: string, submitted?: boolean) { await assert.rejects(promise, error => error instanceof GenerationProviderError && error.code === expected && (submitted === undefined || error.submitted === submitted)); }

test('generation configuration/model discovery makes no guesses or source uploads; only exact reviewed account IDs can be selected', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return models(); }) as typeof fetch;
  const missing = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => undefined, fetchImpl: fetcher }); assert.equal(missing.status().model, null); await errorCode(missing.discoverModel(), 'waiting-configuration', false); assert.equal(calls, 0);
  const offline = new SiliconFlowGenerationProvider({ apiKey: () => 'dummy-generation-secret', fetchImpl: fetcher }); await errorCode(offline.discoverModel(), 'waiting-network', false); assert.equal(calls, 0);
  const unsupported = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async () => jsonResponse({ object: 'list', data: [{ id: 'TeleAI/TeleSpeechASR' }] })) as typeof fetch }); await errorCode(unsupported.discoverModel(), 'waiting-model', false); assert.equal(unsupported.status().model, null);
});

test('generation fixed endpoints and single-request JSON mode send only authorized slices after the durable submission fence', async () => {
  const f = fixture(), order: string[] = [], requests: { url: string; method?: string; body?: any }[] = [];
  const provider = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async (url, init) => { requests.push({ url: String(url), method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }); assert.equal(init?.redirect, 'error'); if (init?.method === 'GET') return models(); order.push('POST'); return completion(f.document); }) as typeof fetch });
  const model = await provider.discoverModel(); assert.equal(model.providerOutputLimitTokens, null); assert.equal(model.maxOutputTokens, 16384); assert.equal(requests[0].url, 'https://api.siliconflow.cn/v1/models?sub_type=chat');
  const result = await provider.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model, onSubmit: () => { order.push('durable'); } }); assert.deepEqual(order, ['durable', 'POST']); assert.deepEqual(result.value, f.document);
  const request = requests[1]; assert.equal(request.url, 'https://api.siliconflow.cn/v1/chat/completions'); assert.deepEqual(request.body.response_format, { type: 'json_object' }); assert.equal(request.body.stream, false); assert.equal(request.body.model, model.model); assert.equal(request.body.messages.length, 2);
  const wire = JSON.parse(request.body.messages[1].content); assert.equal(wire.slices.length, 2); assert.equal(wire.slices[0].text, f.input.units[0].text); assert.equal('reference' in wire.slices[0], false); assert.equal(JSON.stringify(request.body).includes('dummy-generation-secret'), false);
});

test('generation truncation, malformed JSON, HTTP faults and timeouts preserve submitted identity and never auto-retry', async () => {
  const f = fixture();
  for (const [factory, expected] of [[() => completion(f.document, 'length'), 'truncated'], [() => jsonResponse({ object: 'chat.completion', model: GENERATION_MODEL_POLICY.candidates[0].id, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{broken' } }] }), 'invalid-response'], [() => jsonResponse({ secret: 'private service error must not echo' }, 401), 'unauthorized'], [() => jsonResponse({}, 429), 'rate-limit'], [() => jsonResponse({}, 503), 'provider-error']] as const) {
    let posts = 0; const provider = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async (_url, init) => init?.method === 'GET' ? models() : (posts++, factory())) as typeof fetch }), model = await provider.discoverModel();
    await errorCode(provider.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model, onSubmit: () => {} }), expected, true); assert.equal(posts, 1);
  }
  const timeout = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', timeoutMs: 20, fetchImpl: (async (_url, init) => init?.method === 'GET' ? models() : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private detail'))))) as typeof fetch }), model = await timeout.discoverModel();
  await errorCode(timeout.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model, onSubmit: () => {} }), 'result-unknown', true);
});

test('generation rejects decoded credential echoes at both JSON layers, changed credentials and secrets in outbound source text', async () => {
  const f = fixture(), key = 'dummy-generation-secret'; let current = key, posts = 0;
  const provider = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => current, fetchImpl: (async (_url, init) => { if (init?.method === 'GET') return models(); posts++; const content = JSON.stringify({ text: key }).replaceAll(key, '\\u0064' + key.slice(1)); return jsonResponse({ object: 'chat.completion', model: GENERATION_MODEL_POLICY.candidates[0].id, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }); }) as typeof fetch });
  const model = await provider.discoverModel(); await errorCode(provider.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model, onSubmit: () => {} }), 'credential-echo', true); assert.equal(posts, 1);
  const dangerous = fixture([key]); await errorCode(provider.organize({ input: dangerous.input, chunk: freezeGenerationPlan(dangerous.input).chunks[0], model, onSubmit: () => {} }), 'credential-echo', false); assert.equal(posts, 1);
  current = 'changed-dummy-secret'; assert.equal(provider.status().model, null); await errorCode(provider.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model, onSubmit: () => {} }), 'waiting-model', false); assert.equal(posts, 1);
});

test('generation model-list responses cannot bind to a credential changed in flight; a cancelled submission fence sends no POST', async () => {
  let key = 'first-dummy-key', release!: (response: Response) => void;
  const changing = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => key, fetchImpl: (async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch });
  const pending = changing.discoverModel(); await new Promise(resolve => setImmediate(resolve)); key = 'second-dummy-key'; release(models()); await errorCode(pending, 'waiting-model', false); assert.equal(changing.status().model, null);
  const f = fixture(); let posts = 0; const provider = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async (_url, init) => init?.method === 'GET' ? models() : (posts++, completion(f.document))) as typeof fetch }), model = await provider.discoverModel(), controller = new AbortController();
  await errorCode(provider.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model, signal: controller.signal, onSubmit: () => { controller.abort(); } }), 'cancelled', false); assert.equal(posts, 0);
});

test('generation restart rechecks a frozen model with GET only, preserves its identity and reuses the successful check before paid work', async () => {
  const original = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async () => models()) as typeof fetch }), frozen = await original.discoverModel(), f = fixture();
  let gets = 0, posts = 0;
  const restarted = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async (_url, init) => { if (init?.method === 'GET') { gets++; return models(); } posts++; return completion(f.document); }) as typeof fetch });
  assert.equal(restarted.status().model, null); assert.deepEqual(await restarted.ensureModel(frozen), frozen); assert.equal(gets, 1); assert.equal(posts, 0); assert.deepEqual(await restarted.ensureModel(frozen), frozen); assert.equal(gets, 1); assert.equal(restarted.status().lastVerification?.model, frozen.model);
  await restarted.organize({ input: f.input, chunk: freezeGenerationPlan(f.input).chunks[0], model: frozen, onSubmit: () => {} }); assert.equal(gets, 1); assert.equal(posts, 1);
  const incompatible = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => 'dummy-generation-secret', fetchImpl: (async () => models()) as typeof fetch }); await errorCode(incompatible.ensureModel({ ...frozen, maxOutputTokens: 4096 }), 'waiting-model', false); assert.equal(incompatible.status().model, null);
});
