import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationFrozenInput, GenerationSourceUnit, OrganizedDocument } from '../src/shared/generation-contracts.js';
import { validateOrganizedDocument } from '../src/main/generation-validation.js';
const prefix = '标题'.repeat(7), body = '这是合成机制的完整来源正文，所有字词均保留。'.repeat(4).slice(0, 63);
const length = (text: string) => Array.from(text).length;
function fixture(gap = ' ', leading = '', trailing = '') {
  const text = leading + prefix + gap + body + trailing, start = length(leading), middle = start + length(prefix) + length(gap), end = middle + length(body);
  const unit: GenerationSourceUnit = { id: 'u', kind: 'capturedSource', text, reference: { kind: 'capturedSource', sourceId: 'source', sourceRevisionId: 'source-v1', blockId: 'body' }, versionIdentity: 'source-v1/body', coverage: 'complete', warnings: [] };
  const input: GenerationFrozenInput = { sourceRevisionId: 'source-v1', title: '合成排版引用间隙', units: [unit] };
  const document: OrganizedDocument = { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, title: prefix, lead: '', blocks: [
    { id: 'heading', type: 'heading', level: 2, role: 'structure', text: prefix, citations: [{ unitId: 'u', start, end: start + length(prefix), excerpt: prefix }] },
    { id: 'body', type: 'paragraph', role: 'fact', text: body, citations: [{ unitId: 'u', start: middle, end, excerpt: body }] },
  ], coverage: [{ unitId: 'u', start: 0, end: length(text), disposition: 'included' }] };
  return { input, document };
}
const rejectsCoverage = (run: () => void) => assert.throws(run, (error: any) => error.code === 'uncited-source-coverage');

test('exact 14cp heading and 63cp body separated by one space cover the 78cp source without mutating any stored citation, source or coverage', () => {
  const f = fixture(), before = JSON.stringify(f);
  assert.equal(length(prefix), 14); assert.equal(length(body), 63); assert.equal(length(f.input.units[0].text), 78);
  assert.deepEqual(f.document.blocks.map(block => [block.citations[0].start, block.citations[0].end]), [[0, 14], [15, 78]]);
  validateOrganizedDocument(f.document, f.input); assert.equal(JSON.stringify(f), before);
  const whitespace = fixture(' \t\r\n '); validateOrganizedDocument(whitespace.document, whitespace.input);
});

test('non-ASCII whitespace, zero-width characters, punctuation, text and numbers cannot be bridged between exact citations', () => {
  for (const gap of ['\u00a0', '\u3000', '\u200b', '\u2060', '，', '中', '1', ' \t中\n']) {
    const f = fixture(gap); rejectsCoverage(() => validateOrganizedDocument(f.document, f.input));
  }
});

test('formatting at either uncited endpoint remains a coverage failure and a nonwhitespace missing source character still fails', () => {
  for (const [leading, trailing] of [[' ', ''], ['', '\n'], ['\t', '\r\n']]) {
    const f = fixture(' ', leading, trailing); rejectsCoverage(() => validateOrganizedDocument(f.document, f.input));
  }
  const f = fixture(); f.document.blocks[1].citations[0].start++; f.document.blocks[1].citations[0].excerpt = body.slice(1);
  rejectsCoverage(() => validateOrganizedDocument(f.document, f.input));
});

test('formatting union does not relax duplicate terminal body coverage, heading-only or lead-only retention', () => {
  const f = fixture(), original: GenerationSourceUnit = { ...structuredClone(f.input.units[0]), id: 'original', kind: 'ocr', reference: { kind: 'ocr', resultId: 'original', revision: 1, blockId: 'body' }, versionIdentity: 'ocr-original-v1' };
  f.input.units.push(original); f.document.coverage.push({ unitId: original.id, start: 0, end: length(original.text), disposition: 'duplicate', duplicateOf: { unitId: 'u', start: 0, end: length(original.text), excerpt: original.text } });
  rejectsCoverage(() => validateOrganizedDocument(f.document, f.input));
  for (const mode of ['heading', 'lead']) {
    const g = fixture(), original = structuredClone(g.input.units[0]); original.id = 'original'; original.kind = 'ocr'; original.reference = { kind: 'ocr', resultId: 'original', revision: 1, blockId: 'body' }; g.input.units.push(original);
    g.document.coverage.push({ unitId: 'original', start: 0, end: length(original.text), disposition: 'duplicate', duplicateOf: { unitId: 'u', start: 0, end: length(original.text), excerpt: original.text } });
    const citation = { unitId: 'u', start: 0, end: length(original.text), excerpt: original.text };
    g.document.blocks[1].citations = [];
    if (mode === 'heading') { g.document.blocks[0].text = original.text; g.document.blocks[0].citations = [citation]; }
    else { g.document.lead = original.text; g.document.leadCitations = [citation]; }
    assert.throws(() => validateOrganizedDocument(g.document, g.input));
  }
});
