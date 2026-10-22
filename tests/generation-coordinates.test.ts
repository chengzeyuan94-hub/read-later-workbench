import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGenerationCoordinates, verifyGenerationCoordinateAudit, GenerationCoordinateError, GENERATION_COORDINATE_POLICY } from '../src/main/generation-coordinates.js';
import { freezeGenerationPlan, generationSha256, validateOrganizedDocument, validateGeneratedMap } from '../src/main/generation-validation.js';
import type { GeneratedMap, GenerationFrozenInput, GenerationSourceUnit, OrganizedDocument } from '../src/shared/generation-contracts.js';
const length = (text: string) => Array.from(text).length;
const source = (id: string, text: string, kind: GenerationSourceUnit['kind'] = 'capturedSource'): GenerationSourceUnit => ({ id, kind, text, reference: kind === 'capturedSource' ? { kind, sourceId: id, sourceRevisionId: 'source-v1', blockId: id } : { kind: 'ocr', resultId: id, revision: 1, blockId: id }, versionIdentity: `${id}/v1`, coverage: 'complete', warnings: [] });
const inputFor = (...units: GenerationSourceUnit[]): GenerationFrozenInput => ({ sourceRevisionId: 'source-v1', title: '坐标合成机制', units });
function document(input: GenerationFrozenInput, start = 900, end = -8): OrganizedDocument {
  const unit = input.units[0];
  return { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, title: '原文', lead: '', blocks: [{ id: 'body', type: 'paragraph', role: 'fact', text: unit.text, citations: [{ unitId: unit.id, start, end, excerpt: unit.text }] }], coverage: [{ unitId: unit.id, start, end, disposition: 'included' }] };
}
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof GenerationCoordinateError && error.code === code);

test('unique exact excerpts reconstruct Unicode code-point coordinates and one-to-one coverage without touching the source or raw parsed value', () => {
  const input = inputFor(source('u', '🙂e\u0301 原文：25mg，不能超过30天。')), original = document(input), before = JSON.stringify({ input, original });
  const normalized = normalizeGenerationCoordinates(input, 'organize', original, freezeGenerationPlan(input).chunks[0]);
  validateOrganizedDocument(normalized.value, input);
  const value = normalized.value as OrganizedDocument, audit = normalized.audit!;
  assert.deepEqual(value.blocks[0].citations[0], { unitId: 'u', start: 0, end: length(input.units[0].text), excerpt: input.units[0].text });
  assert.deepEqual(value.coverage[0], { unitId: 'u', start: 0, end: length(input.units[0].text), disposition: 'included' });
  assert.equal(audit.policyVersion, GENERATION_COORDINATE_POLICY); assert.equal(audit.sourceSha256, generationSha256(input));
  assert.equal(audit.originalValueSha256, generationSha256(original)); assert.equal(audit.canonicalValueSha256, generationSha256(value));
  assert.equal(audit.repairs.length, 2); assert.equal(audit.repairs[1].citationPath, '/blocks/0/citations/0');
  assert.equal(audit.repairs[0].excerptSha256, generationSha256(input.units[0].text));
  assert.equal(JSON.stringify({ input, original }), before);
  // Independent, hand-counted nonzero offsets: 😀0 甲1 乙2 ，3 后4 段5 🙂6 完7 。8.
  const shiftedInput = inputFor(source('u', '😀甲乙，后段🙂完。')), shifted = document(shiftedInput);
  shifted.blocks[0].citations[0].excerpt = '后段🙂完';
  const positioned = normalizeGenerationCoordinates(shiftedInput, 'organize', shifted).value as OrganizedDocument;
  assert.deepEqual(positioned.blocks[0].citations[0], { unitId: 'u', start: 4, end: 8, excerpt: '后段🙂完' });
});

test('already-valid repeated text retains its exact occurrence; invalid repeated or overlapping excerpts are ambiguous', () => {
  const input = inputFor(source('u', '相同。其他。相同。')), valid: GeneratedMap = { schemaVersion: 1, sourceRevisionId: 'source-v1', organizedSha256: 'a'.repeat(64), rootId: 'r', nodes: [{ id: 'r', parentId: null, children: [], title: '原位置', notes: '', role: 'fact', citations: [{ unitId: 'u', start: 6, end: 9, excerpt: '相同。' }] }] };
  const unchanged = normalizeGenerationCoordinates(input, 'map', valid); assert.deepEqual(unchanged.value, valid); assert.equal(unchanged.audit, undefined);
  valid.nodes[0].citations[0].start = 90; valid.nodes[0].citations[0].end = 2;
  rejects(() => normalizeGenerationCoordinates(input, 'map', valid), 'ambiguous-excerpt');
  const overlap = inputFor(source('u', 'aaaa')), value = document(overlap); value.blocks[0].citations[0].excerpt = 'aaa';
  rejects(() => normalizeGenerationCoordinates(overlap, 'organize', value), 'ambiguous-excerpt');
});

test('coordinates never normalize spelling, whitespace, combining characters, identities or other units', () => {
  const input = inputFor(source('u', 'e\u0301 25mg，不能使用。'), source('other', '仅另一个单元含有此句。'));
  for (const excerpt of ['é 25mg，不能使用。', 'e\u0301 25 mg，不能使用。', 'e\u0301 26mg，不能使用。', '仅另一个单元含有此句。']) {
    const value = document(input); value.blocks[0].citations[0].excerpt = excerpt;
    assert.throws(() => normalizeGenerationCoordinates(input, 'organize', value), error => error instanceof GenerationCoordinateError && ['excerpt-not-found', 'no-authorized-match'].includes(error.code));
  }
  const unknown = document(input); unknown.blocks[0].citations[0].unitId = 'invented'; rejects(() => normalizeGenerationCoordinates(input, 'organize', unknown), 'unknown-source-unit');
  const empty = document(input); empty.blocks[0].citations[0].excerpt = ''; rejects(() => normalizeGenerationCoordinates(input, 'organize', empty), 'empty-excerpt');
});

test('proof verification rejects a canonical fact change or a forged repair even when the attacker updates the claimed canonical SHA', () => {
  const input = inputFor(source('u', '确定原句，不能凭坐标修复添加事实。')), original = document(input), normalized = normalizeGenerationCoordinates(input, 'organize', original);
  verifyGenerationCoordinateAudit(input, 'organize', normalized.value, original, normalized.audit!);
  const altered = structuredClone(normalized.value) as OrganizedDocument; altered.blocks[0].text += ' 无来源的新事实。';
  const proof = { ...structuredClone(normalized.audit!), canonicalValueSha256: generationSha256(altered) };
  rejects(() => verifyGenerationCoordinateAudit(input, 'organize', altered, original, proof), 'proof-derivation');
  const forged = structuredClone(normalized.audit!); forged.repairs[0].after.start = 1;
  rejects(() => verifyGenerationCoordinateAudit(input, 'organize', normalized.value, original, forged), 'proof-derivation');
  const oversized = document(input); oversized.leadCitations = Array.from({ length: 8001 }, () => ({ ...oversized.blocks[0].citations[0] }));
  rejects(() => normalizeGenerationCoordinates(input, 'organize', oversized), 'array-limit');
});

test('search is limited to the frozen chunk; valid out-of-chunk references remain unchanged and are rejected by strict validation', () => {
  const input = inputFor(source('u', '第一段固定原文只有这里。第二段固定原文只在后面。第三段尾声。')), plan = freezeGenerationPlan(input, { maxChunkCodePoints: 20 });
  const value = document(input), late = Array.from(input.units[0].text).slice(plan.chunks[1].slices[0].start).join(''); value.blocks[0].citations[0].excerpt = late;
  rejects(() => normalizeGenerationCoordinates(input, 'organize', value, plan.chunks[0]), 'excerpt-not-found');
  value.blocks[0].citations[0].start = plan.chunks[1].slices[0].start; value.blocks[0].citations[0].end = length(input.units[0].text);
  const normalized = normalizeGenerationCoordinates(input, 'organize', value, plan.chunks[0]); assert.deepEqual((normalized.value as OrganizedDocument).blocks[0].citations, value.blocks[0].citations);
  assert.throws(() => validateOrganizedDocument(normalized.value, input, { chunk: plan.chunks[0] }), (error: any) => error.code === 'citation-outside-chunk');
});

test('coverage cannot be inferred without an exact unique old tuple and does not inherit guesses from multiple citations', () => {
  const input = inputFor(source('u', '完整正文，只有一个唯一原文。'));
  const noLink = document(input); noLink.coverage[0].start = 800;
  const unlinked = normalizeGenerationCoordinates(input, 'organize', noLink); assert.deepEqual((unlinked.value as OrganizedDocument).coverage, noLink.coverage);
  assert.throws(() => validateOrganizedDocument(unlinked.value, input));
  const multiple = document(input); multiple.blocks.push({ ...structuredClone(multiple.blocks[0]), id: 'second' });
  const ambiguous = normalizeGenerationCoordinates(input, 'organize', multiple); assert.deepEqual((ambiguous.value as OrganizedDocument).coverage, multiple.coverage);
  assert.throws(() => validateOrganizedDocument(ambiguous.value, input));
});

test('duplicateOf coordinates can be reconstructed but duplicate cycles and unrelated structure errors remain blocked by existing strict validators', () => {
  const text = '两份完全相同的实际原文。', input = inputFor(source('a', text), source('b', text, 'ocr')), value = document(input, 0, length(text));
  value.coverage.push({ unitId: 'b', start: 0, end: length(text), disposition: 'duplicate', duplicateOf: { unitId: 'a', start: 900, end: -8, excerpt: text } });
  const normalized = normalizeGenerationCoordinates(input, 'organize', value); validateOrganizedDocument(normalized.value, input);
  value.blocks = []; value.coverage[0] = { unitId: 'a', start: 0, end: length(text), disposition: 'duplicate', duplicateOf: { unitId: 'b', start: 900, end: -8, excerpt: text } };
  const cyclic = normalizeGenerationCoordinates(input, 'organize', value); assert.throws(() => validateOrganizedDocument(cyclic.value, input));
  const organized = document(inputFor(source('a', text)), 0, length(text)), map: GeneratedMap = { schemaVersion: 1, sourceRevisionId: 'source-v1', organizedSha256: generationSha256(organized), rootId: 'r', nodes: [{ id: 'r', parentId: null, children: ['f'], title: '结构', notes: '这一段结构说明仍然违规', role: 'structure', citations: [] }, { id: 'f', parentId: 'r', children: [], title: '原文', notes: text, role: 'fact', citations: [{ unitId: 'a', start: 900, end: -8, excerpt: text }] }] };
  const normalizedMap = normalizeGenerationCoordinates(inputFor(source('a', text)), 'map', map); assert.throws(() => validateGeneratedMap(normalizedMap.value, inputFor(source('a', text)), organized), (error: any) => error.code === 'map-role');
});
