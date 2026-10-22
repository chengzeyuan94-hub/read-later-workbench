import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, plainText, type ResolvedReference, type SourceReference } from '../src/editor-core/model.js';
import type { GeneratedMap, GenerationChunk, GenerationCitation, GenerationCoverage, GenerationFrozenInput, GenerationSourceUnit, OrganizedDocument } from '../src/shared/generation-contracts.js';
import { buildGenerationArtifact, freezeGenerationPlan, generationSha256, mergeOrganizedDocuments, validateOrganizedDocument } from '../src/main/generation-validation.js';

// Synthetic mechanism fixtures only. No HTTP, credentials, real sources, or legacy evidence writes.
const BODY = '保留第一段案例。保留第二段步骤。';
const length = (text: string) => Array.from(text).length;
const slice = (text: string, start: number, end: number) => Array.from(text).slice(start, end).join('');
function source(id: string, kind: GenerationSourceUnit['kind'], text = BODY): GenerationSourceUnit {
  const reference: SourceReference = kind === 'capturedSource' ? { kind, sourceId: 'synthetic-source', sourceRevisionId: 'captured-v1', blockId: id }
    : kind === 'ocr' ? { kind, resultId: `ocr-${id}`, revision: 1, blockId: id }
    : { kind, transcriptId: `asr-${id}`, revision: 1, segmentId: id, mediaId: 'synthetic-media', partId: 'synthetic-part' };
  return { id, kind, text, reference, versionIdentity: `${kind}/${id}/v1`, coverage: 'complete', warnings: [] };
}
const inputFor = (...units: GenerationSourceUnit[]): GenerationFrozenInput => ({ sourceRevisionId: 'duplicate-source-v1', title: '合成去重资料', units });
const citation = (unit: GenerationSourceUnit, start = 0, end = length(unit.text)): GenerationCitation => ({ unitId: unit.id, start, end, excerpt: slice(unit.text, start, end) });
const included = (unit: GenerationSourceUnit, start = 0, end = length(unit.text)): GenerationCoverage => ({ unitId: unit.id, start, end, disposition: 'included' });
const duplicate = (unit: GenerationSourceUnit, target: GenerationSourceUnit): GenerationCoverage => ({ unitId: unit.id, start: 0, end: length(unit.text), disposition: 'duplicate', duplicateOf: citation(target) });
const paragraph = (unit: GenerationSourceUnit, id = `body-${unit.id}`, start = 0, end = length(unit.text)): OrganizedDocument['blocks'][number] => ({ id, type: 'paragraph', role: 'fact', text: slice(unit.text, start, end), citations: [citation(unit, start, end)] });
const documentFor = (input: GenerationFrozenInput, blocks: OrganizedDocument['blocks'], coverage: GenerationCoverage[]): OrganizedDocument => ({ schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, title: '合成整理稿', lead: '', leadCitations: [], blocks, coverage });
function resolver(input: GenerationFrozenInput) {
  return (ref: SourceReference): ResolvedReference => {
    const unit = input.units.find(unit => JSON.stringify(unit.reference) === JSON.stringify({ ...ref, range: undefined }));
    if (!unit) throw new Error('fixture exact identity mismatch');
    const selectedText = ref.range ? slice(unit.text, ref.range.start, ref.range.end) : unit.text;
    return { kind: ref.kind, text: unit.text, selectedText, version: unit.versionIdentity, targetId: unit.id, assets: [] };
  };
}
function mapFor(document: OrganizedDocument): GeneratedMap {
  return { schemaVersion: 1, sourceRevisionId: document.sourceRevisionId, organizedSha256: generationSha256(document), rootId: 'root', nodes: [
    { id: 'root', parentId: null, children: ['point'], title: '合成主题', notes: '', role: 'structure', citations: [] },
    { id: 'point', parentId: 'root', children: [], title: '有依据的内容', notes: '', role: 'fact', citations: clone(document.blocks[0].citations) },
  ] };
}
function artifact(input: GenerationFrozenInput, document: OrganizedDocument) {
  return buildGenerationArtifact(input, document, mapFor(document), { workspaceId: 'synthetic-workspace', draftDocumentId: 'synthetic-draft', mapDocumentId: 'synthetic-map', resolve: resolver(input) });
}
function rejects(fn: () => unknown, code: string) { assert.throws(fn, error => error instanceof Error && (error as { code?: string }).code === code); }

test('duplicate two-source retention produces the complete body with the exact captured reference', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), input = inputFor(original, ocr);
  const document = documentFor(input, [paragraph(original)], [included(original), duplicate(ocr, original)]), result = artifact(input, document);
  assert.equal(result.draft.blocks.map(block => plainText(block.runs)).join('\n'), BODY);
  assert.deepEqual(result.blockSourceRefs['body-original'], [{ kind: 'capturedSource', sourceId: 'synthetic-source', sourceRevisionId: 'captured-v1', blockId: 'original', range: { start: 0, end: 16, unit: 'unicode-code-point', excerpt: BODY } }]);
  assert.deepEqual(result.organized.coverage, [included(original), duplicate(ocr, original)]);
});

test('duplicate three-source convergence retains ASR identity and all duplicate source identities', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), asr = source('speech', 'transcript'), input = inputFor(original, ocr, asr), before = clone(input);
  const document = documentFor(input, [paragraph(asr)], [duplicate(original, asr), duplicate(ocr, asr), included(asr)]), result = artifact(input, document);
  assert.equal(result.draft.blocks.map(block => plainText(block.runs)).join('\n'), BODY);
  assert.deepEqual(result.organized.coverage.map(item => [item.unitId, item.disposition, item.duplicateOf?.unitId]), [['original', 'duplicate', 'speech'], ['image-text', 'duplicate', 'speech'], ['speech', 'included', undefined]]);
  assert.deepEqual(result.blockSourceRefs['body-speech'][0], { kind: 'transcript', transcriptId: 'asr-speech', revision: 1, segmentId: 'speech', mediaId: 'synthetic-media', partId: 'synthetic-part', range: { start: 0, end: 16, unit: 'unicode-code-point', excerpt: BODY } });
  assert.equal(result.map.nodes.point.sourceRefs[0].kind, 'transcript');
  assert.deepEqual(input, before);
});

test('duplicate retention preserves the exact OCR result and correction identity', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr');
  ocr.reference = { kind: 'ocr', resultId: 'ocr-image-text', revision: 1, correctionRevision: 3, blockId: 'image-text' };
  const input = inputFor(original, ocr), document = documentFor(input, [paragraph(ocr)], [duplicate(original, ocr), included(ocr)]), result = artifact(input, document);
  assert.deepEqual(result.blockSourceRefs['body-image-text'][0], { kind: 'ocr', resultId: 'ocr-image-text', revision: 1, correctionRevision: 3, blockId: 'image-text', range: { start: 0, end: 16, unit: 'unicode-code-point', excerpt: BODY } });
});

test('duplicate chains end in included coverage whose complete body citations may be partitioned', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), asr = source('speech', 'transcript'), input = inputFor(original, ocr, asr);
  const document = documentFor(input, [paragraph(asr, 'first', 0, 8), paragraph(asr, 'second', 8, 16)], [duplicate(original, ocr), duplicate(ocr, asr), included(asr, 0, 8), included(asr, 8, 16)]);
  validateOrganizedDocument(document, input);
  assert.deepEqual(artifact(input, document).draft.blocks.map(block => plainText(block.runs)), ['保留第一段案例。', '保留第二段步骤。']);
});

test('PM two-source cycle counterexample is rejected by both the validator and artifact builder', () => {
  // Preserve the sealed PM fixture; recreate its exact synthetic source in memory.
  const body = '清洗时应当保留每个实践案例以及完整操作步骤。'.repeat(10);
  assert.equal(length(body), 220);
  const original = source('captured-body', 'capturedSource', body), ocr = source('ocr-body', 'ocr', body), heading = source('heading', 'capturedSource', '主题'), input = inputFor(original, ocr, heading);
  const document = documentFor(input, [paragraph(heading, 'lost-body')], [duplicate(original, ocr), duplicate(ocr, original), included(heading)]);
  rejects(() => validateOrganizedDocument(document, input, { resolve: resolver(input) }), 'duplicate-cycle');
  rejects(() => artifact(input, document), 'duplicate-cycle');
});

test('duplicate three-way cycles fail even when an overlapping included claim supplies a body citation', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), asr = source('speech', 'transcript'), input = inputFor(original, ocr, asr);
  const document = documentFor(input, [paragraph(asr)], [duplicate(original, ocr), duplicate(ocr, asr), duplicate(asr, original), included(asr)]);
  rejects(() => validateOrganizedDocument(document, input), 'duplicate-cycle');
});

test('duplicate target with only partial included coverage cannot prove retained content', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), input = inputFor(original, ocr);
  const document = documentFor(input, [paragraph(ocr, 'first', 0, 8)], [duplicate(original, ocr), included(ocr, 0, 8)]);
  rejects(() => validateOrganizedDocument(document, input), 'duplicate-retained-source');
});

test('duplicate target included on paper still requires citation coverage of its entire body', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), input = inputFor(original, ocr);
  const document = documentFor(input, [paragraph(ocr)], [duplicate(original, ocr), included(ocr)]);
  document.blocks[0].citations = [citation(ocr, 0, 8), citation(ocr, 9, 16)];
  rejects(() => validateOrganizedDocument(document, input), 'uncited-source-coverage');
});

test('headings and a lead cannot stand in for the retained source body citations', () => {
  const original = source('original', 'capturedSource'), ocr = source('image-text', 'ocr'), heading = source('heading', 'capturedSource', '主题'), input = inputFor(original, ocr, heading);
  for (const location of ['heading', 'lead']) {
    const document = documentFor(input, [paragraph(heading)], [duplicate(original, ocr), included(ocr), included(heading)]);
    if (location === 'heading') document.blocks.push({ id: 'cited-heading', type: 'heading', level: 2, role: 'fact', text: '主题', citations: [citation(ocr)] });
    else { document.lead = BODY; document.leadCitations = [citation(ocr)]; }
    rejects(() => validateOrganizedDocument(document, input), 'uncited-source-coverage');
  }
});

test('ordinary included title sources can still be preserved as headings', () => {
  const original = source('original', 'capturedSource'), heading = source('heading', 'capturedSource', '主题'), input = inputFor(original, heading);
  const document = documentFor(input, [paragraph(original), { id: 'title', type: 'heading', level: 2, role: 'fact', text: '主题', citations: [citation(heading)] }], [included(original), included(heading)]);
  validateOrganizedDocument(document, input);
  assert.deepEqual(artifact(input, document).draft.blocks.map(block => [block.type, plainText(block.runs)]), [['paragraph', BODY], ['heading', '主题']]);
});

test('duplicate equality tolerates whitespace but preserves exact Unicode source excerpts', () => {
  const original = source('original', 'capturedSource', '🙂e\u0301 原件\n第二行'), ocr = source('image-text', 'ocr', '🙂e\u0301原件第二行'), input = inputFor(original, ocr);
  const document = documentFor(input, [paragraph(original)], [included(original), duplicate(ocr, original)]), result = artifact(input, document);
  assert.equal(result.blockSourceRefs['body-original'][0].range!.excerpt, '🙂e\u0301 原件\n第二行');
  const composed = source('composed', 'ocr', '🙂é原件第二行'), changedInput = inputFor(original, composed);
  rejects(() => validateOrganizedDocument(documentFor(changedInput, [paragraph(original)], [included(original), duplicate(composed, original)]), changedInput), 'duplicate-proof');
});

test('matching original utterances in separate positions remain twice in the body', () => {
  const first = source('first', 'capturedSource', '再次保留原话。'), second = source('second', 'capturedSource', '再次保留原话。'), input = inputFor(first, second);
  const document = documentFor(input, [paragraph(first), paragraph(second)], [included(first), included(second)]);
  assert.deepEqual(artifact(input, document).draft.blocks.map(block => plainText(block.runs)), ['再次保留原话。', '再次保留原话。']);
  rejects(() => validateOrganizedDocument(documentFor(input, [paragraph(second)], [duplicate(first, second), included(second)]), input), 'duplicate-proof');
});

test('a cross-kind chain cannot indirectly erase another original utterance of the same kind', () => {
  const first = source('first', 'capturedSource'), ocr = source('image-text', 'ocr'), second = source('second', 'capturedSource'), input = inputFor(first, ocr, second);
  const document = documentFor(input, [paragraph(second)], [duplicate(first, ocr), duplicate(ocr, second), included(second)]);
  rejects(() => validateOrganizedDocument(document, input), 'duplicate-proof');
});

test('a chunk rejects a duplicate target present only in frozen input; full evidence can prove retention', () => {
  const original = source('original', 'capturedSource', '甲'.repeat(30)), ocr = source('image-text', 'ocr', '甲'.repeat(30)), input = inputFor(original, ocr), plan = freezeGenerationPlan(input, { maxChunkCodePoints: 30 });
  assert.equal(plan.chunks.length, 2);
  const first = documentFor(input, [paragraph(original, 'incidental', 0, 1)], [duplicate(original, ocr)]), second = documentFor(input, [paragraph(ocr)], [included(ocr)]);
  rejects(() => validateOrganizedDocument(first, input, { chunk: plan.chunks[0] }), 'duplicate-retained-source');
  rejects(() => mergeOrganizedDocuments([first, second], input, plan), 'duplicate-retained-source');
  // Full-document validation has the retained body's actual evidence. The runtime chunk path
  // deliberately requires local proof before accepting a chunk, so cannot silently drop it.
  const complete = documentFor(input, [...first.blocks, ...second.blocks], [...first.coverage, ...second.coverage]);
  validateOrganizedDocument(complete, input);
  assert.equal(artifact(input, complete).draft.blocks[1].runs[0].text, '甲'.repeat(30));
  second.coverage = [duplicate(ocr, original)];
  rejects(() => validateOrganizedDocument(documentFor(input, [...first.blocks, ...second.blocks], [...first.coverage, ...second.coverage]), input), 'duplicate-cycle');
});

test('chunk merging retains every source slice and every repeated utterance across boundaries', () => {
  const repeated = '再次保留原话。'.repeat(10), original = source('original', 'capturedSource', repeated), ocr = source('image-text', 'ocr', repeated), input = inputFor(original, ocr), plan = freezeGenerationPlan(input, { maxChunkCodePoints: 30 });
  const parts = plan.chunks.map((chunk: GenerationChunk) => documentFor(input, chunk.slices.map((part, index) => paragraph(input.units.find(unit => unit.id === part.unitId)!, `body-${index}`, part.start, part.end)), chunk.slices.map(part => included(input.units.find(unit => unit.id === part.unitId)!, part.start, part.end))));
  const merged = mergeOrganizedDocuments(parts, input, plan);
  assert.equal(merged.blocks.map(block => block.text).join(''), '再次保留原话。'.repeat(20));
  assert.deepEqual(merged.coverage.map(item => [item.unitId, item.start, item.end, item.disposition]), [
    ['original', 0, 30, 'included'], ['original', 30, 60, 'included'], ['original', 60, 70, 'included'],
    ['image-text', 0, 20, 'included'], ['image-text', 20, 50, 'included'], ['image-text', 50, 70, 'included'],
  ]);
  const missing = clone(parts); missing[4].coverage = [];
  rejects(() => mergeOrganizedDocuments(missing, input, plan), 'incomplete-source-coverage');
});
