import test from 'node:test';
import assert from 'node:assert/strict';
import { generationComparableFacts } from '../src/main/generation-facts.js';
import { normalizeGenerationQuality, validateGenerationQuality, verifyGenerationQualityAudit } from '../src/main/generation-quality.js';
import { generationSha256, GenerationValidationError, validateGeneratedMap, validateOrganizedDocument } from '../src/main/generation-validation.js';
import type { GeneratedMap, GenerationFrozenInput, OrganizedDocument } from '../src/shared/generation-contracts.js';
import { GENERATION_QUALITY_ORGANIZE_PROMPT, GENERATION_QUALITY_MAP_PROMPT } from '../src/main/generation-quality-prompts.js';
// All material is fabricated, no service, credentials or private collection is read.
function fixture(text: string, kind: 'capturedSource'|'ocr'|'transcript' = 'capturedSource') {
  const input: GenerationFrozenInput = { sourceRevisionId: 'test-version', title: '合成主题', units: [{ id: 'u', kind, text, reference: kind === 'ocr' ? { kind, resultId: 'ocr-result', revision: 1, blockId: 'b' } : kind === 'transcript' ? { kind, transcriptId: 'asr-result', revision: 1, segmentId: 'b' } : { kind, sourceId: 'test-source', sourceRevisionId: 'test-version', blockId: 'b' }, versionIdentity: 'test-version/b', coverage: 'complete', warnings: [] }] };
  const citation = { unitId: 'u', start: 0, end: Array.from(text).length, excerpt: text };
  const organized: OrganizedDocument = { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, title: '资料讨论', lead: '', leadCitations: [], blocks: [{ id: 'b', type: 'paragraph', text, role: 'fact', citations: [citation] }], coverage: [{ unitId: 'u', start: 0, end: citation.end, disposition: 'included' }] };
  const wire = { schemaVersion: 2, sourceRevisionId: input.sourceRevisionId, organizedSha256: generationSha256(organized), root: { kind: 'group', topic: '资料讨论', children: [{ kind: 'claim', title: '来源的说法', explanation: text, citations: [citation], children: [] }] } };
  return { input, organized, wire };
}
function bad(fn:()=>unknown, code: string, path?: string) { assert.throws(fn, (error:any) => error instanceof GenerationValidationError && error.code === code && (!path || error.path === path)); }

test('typed map retains all fact fields and citations, constructs mechanical preorder identities, and rejects factual group notes instead of dropping them', () => {
  const f = fixture('作者说：如果路面相同，距离可能接近。'), before = generationSha256(f.wire);
  const result = normalizeGenerationQuality('map', f.input, f.wire, f.organized), map = result.value as GeneratedMap;
  assert.equal(generationSha256(f.wire), before); assert.deepEqual(map.nodes.map(n=>n.id), ['qnode-0','qnode-1']); assert.deepEqual(map.nodes[0].children, ['qnode-1']);
  assert.equal(map.nodes[0].notes, ''); assert.equal(map.nodes[1].notes, f.wire.root.children[0].explanation); assert.deepEqual(map.nodes[1].citations, [f.organized.blocks[0].citations[0]]);
  validateGeneratedMap(map, f.input, f.organized, { qualityPolicy: true }); validateGenerationQuality('map', map, f.input, f.organized);
  verifyGenerationQualityAudit('map', f.input, f.wire, map, result.audit!, f.organized);
  const corrupted = structuredClone(map); corrupted.nodes[1].notes += '额外事实'; bad(()=>verifyGenerationQualityAudit('map', f.input, f.wire, corrupted, result.audit!, f.organized), 'quality-proof-mismatch');
  const hidden = structuredClone(f.wire) as any; hidden.root.notes = '这里藏有条件和事实'; bad(()=>normalizeGenerationQuality('map', f.input, hidden, f.organized), 'quality-wire-field', '/root');
  bad(()=>normalizeGenerationQuality('map', f.input, map, f.organized), 'quality-wire-field');
});

test('neutral group titles cannot carry strong conclusions and fact claims keep uncertainty and conditional attribution', () => {
  const f=fixture('作者认为：如果路面相同，距离可能接近。'), map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;
  map.nodes[0].title='所有刹车距离完全相同'; bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-structural-claim','/nodes/0');
  map.nodes[0].title='制动讨论';map.nodes[1].notes='作者认为距离可能接近。';bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-lost-condition');
  map.nodes[1].notes='作者认为：如果路面相同，距离接近。';bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-lost-uncertainty');
});

test('comparison-only exact Chinese quantity equivalents preserve the source excerpt and never infer an absent age unit', () => {
  for (const [source, output] of [['七岁','7岁'],['七到十岁','7–10岁'],['二十五毫克','25毫克'],['一百二十三元','123元'],['七点五厘米','7.5厘米']]) {
    assert.equal(generationComparableFacts(source), generationComparableFacts(output.replace('–','-')));
    const f=fixture(`适用${source}。`),doc=structuredClone(f.organized);doc.blocks[0].text=`适用${output.replace('–','-')}。`;validateOrganizedDocument(doc,f.input,{qualityPolicy:true});assert.equal(doc.blocks[0].citations[0].excerpt,f.input.units[0].text);
  }
  assert.equal(generationComparableFacts('一百二元'), '一百二元'); assert.notEqual(generationComparableFacts('一二岁'), generationComparableFacts('12岁'));
  const f=fixture('目标是七到十的小说，原识别文字待校对。'),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;
  map.nodes[1].notes='目标是7-10岁儿童。';bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-inferred-age');bad(()=>validateGeneratedMap(map,f.input,f.organized,{qualityPolicy:true}),'unsupported-critical-fact');
});

test('unit, interval, approximation, starting price, negation and bounds are not erased by numeric comparison', () => {
  for (const [source, output] of [['七岁','7天'],['七到十岁','7到11岁'],['大约七岁','7岁'],['七元起','7元'],['至少七岁','7岁以下'],['不超过七岁','超过7岁'],['不是七岁','是7岁']]) {
    const f=fixture(`作者说${source}。`),doc=structuredClone(f.organized);doc.blocks[0].text=`作者说${output}。`;assert.throws(()=>validateOrganizedDocument(doc,f.input,{qualityPolicy:true}),GenerationValidationError,`${source} => ${output}`);
  }
  // Generic look-alike OCR must not be normalized into a different number.
  const f=fixture('图片标注50ON。','ocr'),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;map.nodes[1].notes='图片标注500N。';bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-ocr-suspect-rewritten');
});

test('cleaning may remove meaningless speech repetition and restore sentences without changing exact source evidence', () => {
  const f=fixture('嗯，然后然后，我们先打开地图，然后选择城市。只有演示版本可以使用，不是商用。','transcript'),doc=structuredClone(f.organized);
  doc.blocks[0].text='先打开地图，再选择城市。只有演示版本可以使用，不是商用。';validateOrganizedDocument(doc,f.input,{qualityPolicy:true});validateGenerationQuality('organize',doc,f.input);
  assert.equal(doc.blocks[0].citations[0].excerpt,f.input.units[0].text);
  doc.blocks[0].text='打开地图，选择城市。商用版本可以使用。';assert.throws(()=>validateOrganizedDocument(doc,f.input,{qualityPolicy:true}),GenerationValidationError);
});

test('new numeric comparison is gated: an ordinary legacy retry retains its original exact character rule', () => {
  const f=fixture('适用七岁。'),doc=structuredClone(f.organized);doc.blocks[0].text='适用7岁。';bad(()=>validateOrganizedDocument(doc,f.input),'unsupported-critical-fact');validateOrganizedDocument(doc,f.input,{qualityPolicy:true});
});

test('complete quantity identities reject suffix digits, decimal tails, price substrings and a range endpoint presented as the whole range', () => {
  for (const [source, output] of [['十七岁','7岁'],['0.5N','5N'],['120元起','20元起'],['七到十岁','10岁'],['16个城市','6个城市'],['一名玩家','2名玩家']]) {
    const f=fixture(`来源标注${source}。`),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;map.nodes[1].notes=`来源标注${output}。`;
    bad(()=>validateGeneratedMap(map,f.input,f.organized,{qualityPolicy:true}),'unsupported-critical-fact');
  }
  for(const [source, output]of [['一名玩家','1名玩家'],['十六个城市','16个城市'],['两张卡片','2张卡片'],['三局比赛','3局比赛'],['七到十岁','7–10岁']]){
    const f=fixture(`来源标注${source}。`),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;map.nodes[1].notes=`来源标注${output}。`;validateGeneratedMap(map,f.input,f.organized,{qualityPolicy:true});
  }
});

test('known negation, stance/source-role reversals and strengthened personal possibility remain rejected', () => {
  for (const [source,output,code] of [
    ['不是七岁。','是7岁。','quality-lost-negation'],['不能超过七岁。','超过7岁。','quality-lost-negation'],
    ['作者甲反对，截图作者乙赞同。','作者甲赞同，截图作者乙反对。','quality-attribution-reversed'],
    ['我唯一想到的方法是先复核。','唯一可能的方法是先复核。','quality-strengthened-possibility'],
  ]) {
    const f=fixture(source),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;map.nodes[1].notes=output;bad(()=>validateGenerationQuality('map',map,f.input,f.organized),code);
  }
  const f=fixture('截图提出一种做法。','ocr'),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;map.nodes[1].notes='原正文主张这种做法。';bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-attribution-source-kind');
});

test('a local factual claim does not inherit conditions or possible language from unrelated sentences in a whole-unit citation', () => {
  const f=fixture('如果下雨就暂停。项目支持16个城市。可能今后继续扩展。'),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;
  map.nodes[1].notes='项目支持16个城市。';validateGenerationQuality('map',map,f.input,f.organized);validateGeneratedMap(map,f.input,f.organized,{qualityPolicy:true});
});


test('shortened core predicate cannot evade a directly relevant condition by lowering full-sentence overlap', () => {
  const f=fixture('如果路面相同，距离可能接近。另有七个城市可选。'),map=normalizeGenerationQuality('map',f.input,f.wire,f.organized).value as GeneratedMap;
  map.nodes[1].title='来源观点';map.nodes[1].notes='距离接近。';bad(()=>validateGenerationQuality('map',map,f.input,f.organized),'quality-lost-condition');
  map.nodes[1].notes='有7个城市可选。';validateGeneratedMap(map,f.input,f.organized,{qualityPolicy:true});validateGenerationQuality('map',map,f.input,f.organized);
});

test('the literal prompt examples pass the same source, structure and fidelity validators used for responses', () => {
  const organized = JSON.parse(GENERATION_QUALITY_ORGANIZE_PROMPT.split('严格返回：')[1].split('。\n上例')[0]);
  const f = fixture('我觉得，如果路面相同，距离可能接近。');
  f.input.sourceRevisionId = organized.sourceRevisionId; f.input.units[0].id = 'example-unit';
  validateOrganizedDocument(organized, f.input, {qualityPolicy:true}); validateGenerationQuality('organize', organized, f.input);
  const wire = JSON.parse(GENERATION_QUALITY_MAP_PROMPT.split('严格返回格式：')[1].split('。\n上例')[0]);
  assert.equal(wire.organizedSha256, generationSha256(organized));
  const map = normalizeGenerationQuality('map', f.input, wire, organized).value;
  validateGeneratedMap(map, f.input, organized, {qualityPolicy:true}); validateGenerationQuality('map', map, f.input, organized);
});

test('suffix approximation cannot disappear when the same explicit quantity is retained', () => {
  for (const word of ['左右', '上下']) {
    const f = fixture(`力为300N${word}。`), doc = structuredClone(f.organized); doc.blocks[0].text = '力为300N。';
    bad(()=>validateGenerationQuality('organize', doc, f.input), 'quality-lost-quantity-bound');
    const map = normalizeGenerationQuality('map', f.input, f.wire, f.organized).value as GeneratedMap;
    map.nodes[1].notes = '力为300N。'; bad(()=>validateGenerationQuality('map', map, f.input, f.organized), 'quality-lost-quantity-bound');
  }
});
