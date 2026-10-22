import type { GenerationChunk, GenerationCoordinateAudit, GenerationCoordinateRepair, GenerationFrozenInput, GenerationStage } from '../shared/generation-contracts.js';
import { generationSha256, validateGenerationChunk, validateGenerationInput } from './generation-validation.js';

export const GENERATION_COORDINATE_POLICY = 'exact-excerpt-unique-codepoint-v1' as const;
const MAX_RESPONSE_BYTES = 8 * 1024 ** 2, MAX_REFERENCES = 20_000, MAX_SEARCH_POINTS = 16_000_000;
export class GenerationCoordinateError extends Error {
  constructor(readonly code: string) { super(`生成引用坐标无法唯一核对（${code}）`); this.name = 'GenerationCoordinateError'; }
}
type RecordValue = Record<string, any>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw new GenerationCoordinateError(code); }
const identity = (item: { unitId: string; start: number; end: number }) => JSON.stringify([item.unitId, item.start, item.end]);

/** Exact local coordinate derivation only. This does not clean or alter text,
 * add a source, decide semantic support, or replace the strict validator.
 */
export function normalizeGenerationCoordinates(input: GenerationFrozenInput, stage: GenerationStage, value: unknown, chunk?: GenerationChunk): { value: unknown; audit?: GenerationCoordinateAudit } {
  validateGenerationInput(input); if (chunk) validateGenerationChunk(input, chunk);
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_RESPONSE_BYTES) fail('response-limit');
  const output = structuredClone(value);
  if (!record(output)) return { value: output };
  const source = new Map(input.units.map(unit => [unit.id, unit]));
  const points = new Map<string, string[]>(), patterns = new Map<string, string[]>(), matches = new Map<string, { start: number; end: number }>();
  const repairs: GenerationCoordinateRepair[] = [], repairedRanges = new Map<string, GenerationCoordinateRepair[]>();
  let references = 0, searchPoints = 0;
  const sourcePoints = (unitId: string) => { if (!points.has(unitId)) points.set(unitId, Array.from(source.get(unitId)!.text)); return points.get(unitId)!; };
  const patternPoints = (excerpt: string) => { if (!patterns.has(excerpt)) patterns.set(excerpt, Array.from(excerpt)); return patterns.get(excerpt)!; };
  const array = (value: unknown): any[] => { if (!Array.isArray(value)) return []; if (value.length > 8000) fail('array-limit'); return value; };
  function uniqueMatch(unitId: string, excerpt: string): { start: number; end: number } {
    const key = JSON.stringify([unitId, excerpt]), cached = matches.get(key); if (cached) return cached;
    const text = sourcePoints(unitId), pattern = patternPoints(excerpt), slices = chunk ? chunk.slices.filter(slice => slice.unitId === unitId) : [{ start: 0, end: text.length }];
    const applicable = slices.filter(slice => slice.end - slice.start >= pattern.length);
    if (!applicable.length) fail('no-authorized-match');
    searchPoints += pattern.length + applicable.reduce((sum, slice) => sum + slice.end - slice.start, 0);
    if (searchPoints > MAX_SEARCH_POINTS) fail('search-limit');
    // KMP compares Unicode code points, preserving overlap and avoiding UTF-16
    // half-surrogate matches, NFC/space rewriting, or quadratic substring scans.
    const prefix = new Int32Array(pattern.length);
    for (let i = 1, j = 0; i < pattern.length; i++) { while (j && pattern[i] !== pattern[j]) j = prefix[j - 1]; if (pattern[i] === pattern[j]) j++; prefix[i] = j; }
    let found: { start: number; end: number } | undefined;
    for (const slice of applicable) for (let i = slice.start, j = 0; i < slice.end; i++) {
      while (j && text[i] !== pattern[j]) j = prefix[j - 1]; if (text[i] === pattern[j]) j++;
      if (j === pattern.length) { if (found) fail('ambiguous-excerpt'); found = { start: i + 1 - pattern.length, end: i + 1 }; j = prefix[j - 1]; }
    }
    if (!found) fail('excerpt-not-found'); matches.set(key, found); return found;
  }
  function citation(item: unknown, path: string): void {
    if (++references > MAX_REFERENCES) fail('reference-limit');
    if (!record(item) || typeof item.unitId !== 'string' || !source.has(item.unitId)) fail('unknown-source-unit');
    if (typeof item.excerpt !== 'string' || !item.excerpt.length) fail('empty-excerpt');
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) fail('coordinate-type');
    const chars = sourcePoints(item.unitId), pattern = patternPoints(item.excerpt);
    // A valid location remains exactly where it was, even when the same words
    // occur elsewhere. Chunk authorization is still checked by strict validation.
    if (item.start >= 0 && item.end > item.start && item.end <= chars.length && item.end - item.start === pattern.length && chars.slice(item.start, item.end).join('') === item.excerpt) return;
    const before = { unitId: item.unitId, start: item.start, end: item.end }, found = uniqueMatch(item.unitId, item.excerpt);
    item.start = found.start; item.end = found.end;
    const repair: GenerationCoordinateRepair = { kind: 'citation', path, before, after: { unitId: item.unitId, ...found }, excerptSha256: generationSha256(item.excerpt) };
    repairs.push(repair); const key = identity(before), entries = repairedRanges.get(key) ?? []; entries.push(repair); repairedRanges.set(key, entries);
  }
  function citations(items: unknown, base: string): void { for (const [index, item] of array(items).entries()) citation(item, `${base}/${index}`); }
  if (stage === 'organize') {
    citations(output.leadCitations, '/leadCitations');
    for (const [index, block] of array(output.blocks).entries()) if (record(block)) citations(block.citations, `/blocks/${index}/citations`);
    for (const [index, item] of array(output.coverage).entries()) if (record(item) && item.duplicateOf !== undefined) citation(item.duplicateOf, `/coverage/${index}/duplicateOf`);
    for (const [index, item] of array(output.coverage).entries()) {
      if (!record(item) || typeof item.unitId !== 'string' || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) continue;
      const entries = repairedRanges.get(identity({ unitId: item.unitId, start: item.start, end: item.end }));
      // Coverage has no excerpt and must never be guessed or stretched. Only a
      // one-to-one original tuple links it to a separately proved exact citation.
      if (entries?.length !== 1) continue;
      const linked = entries[0], before = { unitId: item.unitId, start: item.start, end: item.end };
      item.start = linked.after.start; item.end = linked.after.end;
      repairs.push({ kind: 'coverage', path: `/coverage/${index}`, before, after: { ...linked.after }, excerptSha256: linked.excerptSha256, citationPath: linked.path });
    }
  } else if (stage === 'map') {
    for (const [index, node] of array(output.nodes).entries()) if (record(node)) citations(node.citations, `/nodes/${index}/citations`);
  } else fail('stage');
  return repairs.length ? { value: output, audit: { policyVersion: GENERATION_COORDINATE_POLICY, sourceSha256: generationSha256(input), originalValueSha256: generationSha256(value), canonicalValueSha256: generationSha256(output), repairs } } : { value: output };
}

/** Verification never adopts or writes a recomputed value. It proves that a
 * stored canonical value is precisely this policy's derivation of its original.
 */
export function verifyGenerationCoordinateAudit(input: GenerationFrozenInput, stage: GenerationStage, value: unknown, originalValue: unknown, audit: GenerationCoordinateAudit, chunk?: GenerationChunk): void {
  if (audit?.policyVersion !== GENERATION_COORDINATE_POLICY) fail('proof-policy');
  const expected = normalizeGenerationCoordinates(input, stage, originalValue, chunk);
  if (!expected.audit || generationSha256(expected.audit) !== generationSha256(audit) || generationSha256(expected.value) !== generationSha256(value)) fail('proof-derivation');
}
