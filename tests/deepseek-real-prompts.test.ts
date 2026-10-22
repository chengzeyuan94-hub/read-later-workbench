import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekGenerationProvider } from '../src/main/deepseek-generation-provider.js';
import { GENERATION_USABILITY_MAP_PROMPT, GENERATION_USABILITY_ORGANIZE_PROMPT } from '../src/main/generation-usability-prompts.js';
import { GENERATION_MODEL_POLICY, GenerationProviderError, SiliconFlowGenerationProvider } from '../src/main/generation-provider.js';
import { freezeGenerationPlan, generationSha256 } from '../src/main/generation-validation.js';
import type { GenerationFrozenInput, OrganizedDocument } from '../src/shared/generation-contracts.js';

// Wire-contract mechanisms use synthetic text/responses and an injected fetch.
// No real key, model service, database, local collection or engine is accessed.
const key = 'unit-prompts-only-credential';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const models = () => json({ object: 'list', data: [{ id: 'deepseek-flash' }] });
const input: GenerationFrozenInput = { sourceRevisionId: 'synthetic-source', title: '转述的疑词，待校对', units: [{ id: 'u', kind: 'capturedSource', text: '作者说：只有满足条件才可使用25mg，不能超过30天。', reference: { kind: 'capturedSource', sourceId: 'synthetic-source', sourceRevisionId: 'synthetic-source', blockId: 'body' }, versionIdentity: 'synthetic-source/body', coverage: 'complete', warnings: [] }] };
const citation = { unitId: 'u', start: 0, end: Array.from(input.units[0].text).length, excerpt: input.units[0].text };
const organized: OrganizedDocument = { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, title: '作者有条件的说法', lead: '', leadCitations: [], blocks: [{ id: 'body', type: 'paragraph', role: 'fact', text: input.units[0].text, citations: [citation] }], coverage: [{ unitId: 'u', start: citation.start, end: citation.end, disposition: 'included' }] };

test('legacy SiliconFlow configuration SHA stays exactly equal to the independently frozen pre-refinement identity', async () => {
  let gets = 0;
  const provider = new SiliconFlowGenerationProvider({ networkAllowed: true, apiKey: () => key, fetchImpl: (async (url, init) => {
    gets++; assert.equal(init?.method, 'GET'); assert.equal(url, 'https://api.siliconflow.cn/v1/models?sub_type=chat');
    return json({ object: 'list', data: [{ id: GENERATION_MODEL_POLICY.candidates[0].id }] });
  }) as typeof fetch });
  const model = await provider.discoverModel();
  // Recorded before this change and in the prior independently accepted review.
  assert.equal(model.configurationSha256, 'df7e2f21a99e790507a6d4d7280de9bb0717eb9b62bedb72ad89646518e01395');
  assert.equal(gets, 1);
});

test('DeepSeek new usability wire preserves image prose, permits video corrections and uses a new frozen identity', async () => {
  const bodies: Record<string, any>[] = [];
  const provider = new DeepSeekGenerationProvider({ networkAllowed: true, apiKey: () => key, fetchImpl: (async (_url, init) => {
    if (init?.method === 'GET') return models();
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return json({ object: 'chat.completion', model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ syntheticWireOnly: true }) } }] });
  }) as typeof fetch });
  const model = await provider.discoverModel(), chunk = freezeGenerationPlan(input).chunks[0];
  assert.notEqual(model.configurationSha256, 'fe05dfebe74a36b43b60aed1d0712b8b17f1b95136c6ed775f7d1e22be18a51c');
  await provider.organize({ input, chunk, model, onSubmit: () => {} });
  await provider.map({ input, organized, chunk, model, onSubmit: () => {} });
  assert.equal(bodies.length, 2);
  assert.equal(model.promptVersion, 'read-create-usability-v3');
  assert.equal(bodies[0].messages[0].content, GENERATION_USABILITY_ORGANIZE_PROMPT);
  assert.equal(bodies[1].messages[0].content, GENERATION_USABILITY_MAP_PROMPT);
  assert.match(GENERATION_USABILITY_ORGANIZE_PROMPT, /图文/); assert.match(GENERATION_USABILITY_ORGANIZE_PROMPT, /合理纠错/);
  assert.match(GENERATION_USABILITY_ORGANIZE_PROMPT, /断句/);
  assert.match(GENERATION_USABILITY_MAP_PROMPT, /schemaVersion=2/);
  assert.match(GENERATION_USABILITY_MAP_PROMPT, /kind\/topic\/children/);
  assert.match(GENERATION_USABILITY_MAP_PROMPT, /不编造来源/);
  for (const body of bodies) {
    assert.match(body.messages[0].content, /否定/); assert.match(body.messages[0].content, /条件/); assert.match(body.messages[0].content, /归因/); assert.match(body.messages[0].content, /校对|纠错/);
    assert.equal(body.model, model.model); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(JSON.stringify(body).includes(key), false);
  }
});

test('an old DeepSeek frozen request is rejected for changed effective prompts before any completion and its identity remains immutable', async () => {
  let gets = 0, posts = 0;
  const provider = new DeepSeekGenerationProvider({ networkAllowed: true, apiKey: () => key, fetchImpl: (async (_url, init) => {
    if (init?.method === 'GET') { gets++; return models(); } posts++; throw Error('no completion allowed');
  }) as typeof fetch });
  const current = await provider.discoverModel();
  const frozen = { ...current, configurationSha256: 'fe05dfebe74a36b43b60aed1d0712b8b17f1b95136c6ed775f7d1e22be18a51c' }, before = generationSha256(frozen);
  await assert.rejects(provider.ensureModel(frozen), error => error instanceof GenerationProviderError && error.code === 'waiting-model' && error.submitted === false);
  assert.equal(generationSha256(frozen), before); assert.equal(provider.status().model, null); assert.equal(gets, 2); assert.equal(posts, 0);
  await assert.rejects(provider.organize({ input, chunk: freezeGenerationPlan(input).chunks[0], model: frozen, onSubmit: () => { throw Error('must not reach submission'); } }), error => error instanceof GenerationProviderError && error.code === 'waiting-model' && error.submitted === false);
  assert.equal(posts, 0); assert.equal(gets, 2);
});

test('v3 map sends a compact saved-manuscript projection within its actual HTTP budget while retaining the exact canonical organized SHA',async()=>{
 const transcriptText='这是一段用于验证载荷预算的完整转录。'.repeat(250),largeInput:GenerationFrozenInput={...input,units:[{...input.units[0],text:transcriptText}]};
 const coarse={unitId:'u',start:0,end:Array.from(transcriptText).length,excerpt:transcriptText,granularity:'source-unit' as const};
 const manuscript:OrganizedDocument={schemaVersion:1,sourceRevisionId:largeInput.sourceRevisionId,title:'完整正文投影机制',lead:'',leadCitations:[],blocks:Array.from({length:20},(_,i)=>({id:`paragraph-${i}`,type:'paragraph' as const,role:'fact' as const,text:`第${i+1}段可编辑正文，用于验证引用投影不重复发送整条转录。`,citations:[{...coarse}]})),coverage:[{unitId:'u',start:0,end:coarse.end,disposition:'included'}]};
 const frozenSha=generationSha256(manuscript),before=JSON.stringify(manuscript);assert.ok(Buffer.byteLength(before)>32_000,'canonical durable references intentionally exceed the wire budget');
 let posts=0,submitted=0;const provider=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>key,fetchImpl:(async(_url,init)=>{
  if(init?.method==='GET')return models();posts++;const body=JSON.parse(String(init?.body)),wire=JSON.parse(body.messages[1].content);
  assert.ok(Buffer.byteLength(JSON.stringify(body.messages))<=32_000);assert.equal(wire.organizedSha256,frozenSha);assert.deepEqual(wire.organized.blocks.map((b:any)=>b.text),manuscript.blocks.map(b=>b.text));assert.deepEqual(wire.organized.blocks.map((b:any)=>b.citations),manuscript.blocks.map(()=>[{unitId:'u'}]));assert.deepEqual(wire.organized.coverage,[]);assert.equal(JSON.stringify(wire).includes(transcriptText),false);
  return json({object:'chat.completion',model:'deepseek-flash',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({syntheticProjectionOnly:true})}}]});
 })as typeof fetch});
 const model=await provider.discoverModel();await provider.map({input:largeInput,organized:manuscript,model,chunk:freezeGenerationPlan(largeInput,{maxChunkCodePoints:8000,maxChunkUtf8Bytes:24000}).chunks[0],onSubmit:()=>{submitted++;}});
 assert.equal(submitted,1);assert.equal(posts,1);assert.equal(generationSha256(manuscript),frozenSha);assert.equal(JSON.stringify(manuscript),before);
});
