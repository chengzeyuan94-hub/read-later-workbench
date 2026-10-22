import { generationComparableFacts, generationQuantityItems, generationQualifiedQuantityItems } from './generation-facts.js';
import { createHash } from 'node:crypto';
import { clone, pointLength, pointSlice, validateDraft, validateMap, validateSourceReference, type DraftBlock, type DraftDocument, type MindMapDocument, type ResolvedReference, type SourceReference } from '../editor-core/model.js';
import type { GeneratedMap, GenerationArtifact, GenerationChunk, GenerationCitation, GenerationCoverage, GenerationFrozenInput, GenerationPlan, GenerationSourceSlice, GenerationSourceUnit, OrganizedDocument } from '../shared/generation-contracts.js';

export class GenerationValidationError extends Error { constructor(readonly code: string, readonly path = '/', readonly repairHint?: string) { super(`生成资料未通过本地校验（${code}）；原始资料和人工稿保留。`); this.name = 'GenerationValidationError'; } }
export type GenerationReferenceResolver = (reference: SourceReference) => ResolvedReference;
export interface GenerationValidationOptions { chunk?: GenerationChunk; resolve?: GenerationReferenceResolver; qualityPolicy?: boolean; usabilityPolicy?: boolean }
export const generationSha256 = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function fail(code: string): never { throw new GenerationValidationError(code); }
function object(value: unknown): asserts value is Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object-required'); }
function keys(value: object, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown-output-field'); }
function text(value: unknown, limit: number, empty = false): asserts value is string { if (typeof value !== 'string' || (!empty && !value.trim()) || pointLength(value) > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('text-boundary'); }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) fail('invalid-identity'); }
function range(start: unknown, end: unknown, length: number): void { if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > length) fail('source-range'); }
export function validateGenerationInput(input: GenerationFrozenInput, resolve?: GenerationReferenceResolver): void {
  object(input); keys(input, ['sourceRevisionId', 'title', 'units']); id(input.sourceRevisionId); text(input.title, 1000, true);
  if (!Array.isArray(input.units) || !input.units.length || input.units.length > 2000) fail('missing-source-content');
  const ids = new Set<string>(); let total = 0;
  for (const unit of input.units) {
    object(unit); keys(unit, ['id', 'kind', 'text', 'reference', 'versionIdentity', 'coverage', 'warnings', 'assetRefs']); id(unit.id);
    if (ids.has(unit.id)) fail('duplicate-source-unit'); ids.add(unit.id);
    if (!['capturedSource', 'ocr', 'transcript'].includes(unit.kind) || unit.reference?.kind !== unit.kind) fail('source-kind');
    text(unit.text, 1_000_000); text(unit.versionIdentity, 1000);
    if (unit.coverage !== 'complete') fail('source-incomplete');
    if (!Array.isArray(unit.warnings) || unit.warnings.length > 100 || unit.warnings.some((warning: unknown) => typeof warning !== 'string' || warning.length > 2000)) fail('source-warnings');
    try { validateSourceReference(unit.reference); } catch { fail('source-reference'); }
    if (unit.assetRefs !== undefined && (!Array.isArray(unit.assetRefs) || unit.assetRefs.some((asset: any) => !asset || typeof asset.assetId !== 'string' || typeof asset.version !== 'string'))) fail('source-assets');
    if (resolve) { const actual = resolve(unit.reference); if (actual.selectedText !== unit.text) fail('source-version-text-mismatch'); }
    total += Buffer.byteLength(unit.text); if (total > 2 * 1024 ** 2) fail('input-limit');
  }
}
export function freezeGenerationPlan(input: GenerationFrozenInput, options: { maxChunkCodePoints?: number; maxChunkUtf8Bytes?: number; maxChunks?: number; chunkFits?: (chunk: GenerationChunk) => boolean } = {}): GenerationPlan {
  validateGenerationInput(input);
  const cpLimit = options.maxChunkCodePoints ?? 4000, byteLimit = options.maxChunkUtf8Bytes ?? 12_000, maxChunks = options.maxChunks ?? 24;
  if (![cpLimit, byteLimit, maxChunks].every(Number.isSafeInteger) || cpLimit < 20 || cpLimit > 8000 || byteLimit < 64 || byteLimit > 24_000 || maxChunks < 1 || maxChunks > 24) fail('chunk-budget');
  const chunks: GenerationChunk[] = []; let slices: GenerationSourceSlice[] = [], points = 0, bytes = 0;
  const flush = () => { if (!slices.length) return; const order = chunks.length, payload = { sourceRevisionId: input.sourceRevisionId, order, slices }; chunks.push({ id: `generation-chunk-${order}`, order, inputSha256: generationSha256(payload), slices }); slices = []; points = 0; bytes = 0; if (chunks.length > maxChunks) fail('input-limit'); };
  for (const unit of input.units) {
    const chars = Array.from(unit.text); let start = 0;
    while (start < chars.length) {
      if (points === cpLimit || bytes + Buffer.byteLength(chars[start]) > byteLimit) flush();
      let end = start, addedBytes = 0;
      while (end < chars.length && points + end - start < cpLimit && bytes + addedBytes + Buffer.byteLength(chars[end]) <= byteLimit) { addedBytes += Buffer.byteLength(chars[end]); end++; }
      if (end === start) fail('chunk-budget');
      // Prefer complete paragraph/line boundaries without discarding any preceding or following code point.
      if (end < chars.length && end - start > 100) { const prior = chars.slice(start, end).lastIndexOf('\n'); if (prior >= Math.floor((end - start) * .6)) { end = start + prior + 1; addedBytes = Buffer.byteLength(chars.slice(start, end).join('')); } }
      const piece = chars.slice(start, end).join(''); slices.push({ unitId: unit.id, start, end, sha256: generationSha256(piece) }); points += end - start; bytes += addedBytes; start = end;
    }
  }
  flush();
  if (options.chunkFits) {
    // A provider measures its actual serialized messages, including its prompt
    // and source metadata. Refinement only splits the complete text plan.
    const refined: GenerationChunk[] = []; let pending: GenerationSourceSlice[] = [];
    const make = (pieces: GenerationSourceSlice[]): GenerationChunk => {
      const order = refined.length, payload = { sourceRevisionId: input.sourceRevisionId, order, slices: pieces };
      return { id: `generation-chunk-${order}`, order, inputSha256: generationSha256(payload), slices: pieces };
    };
    const save = () => { if (pending.length) { refined.push(make(pending)); pending = []; if (refined.length > maxChunks) fail('input-limit'); } };
    for (const chunk of chunks) {
      for (const slice of chunk.slices) {
        const unit = input.units.find(value => value.id === slice.unitId)!;
        let start = slice.start;
        while (start < slice.end) {
          const piece = (end: number): GenerationSourceSlice => ({ unitId: slice.unitId, start, end, sha256: generationSha256(pointSlice(unit.text, start, end)) });
          const whole = piece(slice.end);
          if (options.chunkFits(make([...pending, whole]))) { pending.push(whole); start = slice.end; continue; }
          if (pending.length) { save(); continue; }
          let low = start + 1, high = slice.end - 1, fit = start;
          while (low <= high) { const middle = Math.floor((low + high) / 2); if (options.chunkFits(make([piece(middle)]))) { fit = middle; low = middle + 1; } else high = middle - 1; }
          if (fit === start) fail('input-limit');
          pending.push(piece(fit)); start = fit; save();
        }
      }
      save();
    }
    chunks.splice(0, chunks.length, ...refined);
  }
  return { version: 'source-slices-v1', sourceRevisionId: input.sourceRevisionId, sourceSha256: generationSha256(input), chunks, maxAttemptsPerStagePerChunk: 2 };
}
function selectedSlices(input: GenerationFrozenInput, chunk?: GenerationChunk): GenerationSourceSlice[] {
  if (!chunk) return input.units.map(unit => ({ unitId: unit.id, start: 0, end: pointLength(unit.text), sha256: generationSha256(unit.text) }));
  id(chunk.id); if (!Number.isSafeInteger(chunk.order) || chunk.order < 0 || !Array.isArray(chunk.slices) || !chunk.slices.length) fail('chunk-identity');
  if (generationSha256({ sourceRevisionId: input.sourceRevisionId, order: chunk.order, slices: chunk.slices }) !== chunk.inputSha256) fail('chunk-identity');
  for (const slice of chunk.slices) { const unit = input.units.find(candidate => candidate.id === slice.unitId); if (!unit) fail('chunk-source'); range(slice.start, slice.end, pointLength(unit.text)); if (generationSha256(pointSlice(unit.text, slice.start, slice.end)) !== slice.sha256) fail('chunk-source-sha'); }
  return chunk.slices;
}
export function validateGenerationChunk(input: GenerationFrozenInput, chunk: GenerationChunk): void {
  validateGenerationInput(input); const slices = selectedSlices(input, chunk); let lastUnit = -1, lastEnd = -1;
  for (const slice of slices) { const index = input.units.findIndex(unit => unit.id === slice.unitId); if (index < lastUnit || index === lastUnit && slice.start < lastEnd) fail('chunk-source-order'); lastUnit = index; lastEnd = slice.end; }
}
function unitFor(input: GenerationFrozenInput, citation: GenerationCitation, slices: GenerationSourceSlice[]): GenerationSourceUnit {
  object(citation); keys(citation, ['unitId', 'start', 'end', 'excerpt', 'granularity']);
  if(citation.granularity!==undefined&&!['source-unit','frozen-slice'].includes(citation.granularity))fail('citation-granularity'); id(citation.unitId);
  const unit = input.units.find(candidate => candidate.id === citation.unitId); if (!unit) fail('unknown-source-unit');
  range(citation.start, citation.end, pointLength(unit.text));
  if (!slices.some(slice => slice.unitId === unit.id && citation.start >= slice.start && citation.end <= slice.end)) fail('citation-outside-chunk');
  if (citation.excerpt !== pointSlice(unit.text, citation.start, citation.end)) fail('citation-excerpt');
  return unit;
}
export function resolveGenerationCitation(input: GenerationFrozenInput, citation: GenerationCitation, resolve?: GenerationReferenceResolver, chunk?: GenerationChunk): SourceReference {
  const unit = unitFor(input, citation, selectedSlices(input, chunk)), ref = clone(unit.reference), base = ref.range?.start ?? 0;
  if(citation.granularity)ref.granularity=citation.granularity;
  ref.range = { start: base + citation.start, end: base + citation.end, unit: 'unicode-code-point', excerpt: citation.excerpt };
  try { validateSourceReference(ref); } catch { fail('resolved-citation-format'); }
  if (resolve && resolve(ref).selectedText !== citation.excerpt) fail('resolved-citation-version');
  return ref;
}
function checkCitations(value: unknown, input: GenerationFrozenInput, options: GenerationValidationOptions, required: boolean): asserts value is GenerationCitation[] {
  if (!Array.isArray(value) || value.length > 100 || required && !value.length) fail('missing-factual-citation');
  for (const citation of value) resolveGenerationCitation(input, citation, options.resolve, options.chunk);
}
function union(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  for (const item of ranges.map(value => ({ ...value })).sort((a, b) => a.start - b.start || a.end - b.end)) { const last = result.at(-1); if (last && item.start <= last.end) last.end = Math.max(last.end, item.end); else result.push(item); }
  return result;
}
/** A citation pair may cover the formatting between them without changing
 * either exact reference. This never extends an endpoint or applies to the
 * separate retained-body proof used by duplicate chains.
 */
function unionFormattingGaps(ranges: { start: number; end: number }[], source: string): { start: number; end: number }[] {
  const points = Array.from(source), result: { start: number; end: number }[] = [];
  for (const item of union(ranges)) {
    const last = result.at(-1);
    if (last && /^[ \t\r\n]+$/.test(points.slice(last.end, item.start).join(''))) last.end = item.end;
    else result.push({ ...item });
  }
  return result;
}
const comparable = (value: string): string => value.replace(/\s/gu, '');
export function generationCriticalItems(value: string): string[] {
  const normalized = comparable(value);
  return [...new Set([...(normalized.match(/\d+(?:[.,]\d+)*(?:%|％|毫克|mg|kg|公斤|千克|克|毫升|ml|mL|升|分钟|小时|秒|厘米|毫米|米|℃|°C|[万亿千百]?元|岁|倍|次|天|年|月|日)?/gu) ?? []), ...(normalized.match(/不能|不可|不得|不要|没有|不是|不应|不超过|至少|最多|必须|仅限|只有|除非|如果|若|可能|大约|不|未|无/gu) ?? [])])];
}
export function generationQualityCriticalItems(value: string): string[] {
  const normalized = generationComparableFacts(value);
  return [...new Set([...generationQuantityItems(normalized), ...generationQualifiedQuantityItems(normalized), ...(normalized.match(/不能|不可|不得|不要|没有|不是|不应|不超过|至少|最多|必须|仅限|只有|除非|如果|假设|若|可能|大约|一定|必然|完全|所有|任何|始终|绝不|不可能|无关|唯一|不|未|无/gu) ?? [])])];
}
function preserveCritical(textValue: string, cited: string, qualityPolicy = false): void {
  if (qualityPolicy) { const source = new Set(generationQualityCriticalItems(cited)); if (generationQualityCriticalItems(textValue).some(item => !source.has(item))) fail('unsupported-critical-fact'); }
  else { const source = comparable(cited); if (generationCriticalItems(textValue).some(item => !source.includes(item))) fail('unsupported-critical-fact'); }
}
function checkCoverage(coverage: GenerationCoverage[], input: GenerationFrozenInput, slices: GenerationSourceSlice[], blocks: OrganizedDocument['blocks'], lead: string, qualityPolicy = false): void {
  if (!Array.isArray(coverage) || coverage.length > 8000) fail('coverage-format');
  const includedText: string[] = [];
  const allSlices = input.units.map(source => ({ unitId: source.id, start: 0, end: pointLength(source.text), sha256: '' }));
  const byUnit = new Map<string, number[]>(), bodyCitations = new Map<string, { start: number; end: number }[]>(), allCitations = new Map<string, { start: number; end: number }[]>();
  for (const block of blocks) for (const citation of block.citations) {
    const all = allCitations.get(citation.unitId) ?? []; all.push(citation); allCitations.set(citation.unitId, all);
    if (block.role === 'fact' && block.type !== 'heading' && block.type !== 'image') { const body = bodyCitations.get(citation.unitId) ?? []; body.push(citation); bodyCitations.set(citation.unitId, body); }
  }
  for (const [unitId, citations] of allCitations) allCitations.set(unitId, unionFormattingGaps(citations, input.units.find(unit => unit.id === unitId)!.text));
  for (const [unitId, citations] of bodyCitations) bodyCitations.set(unitId, union(citations));
  for (const item of coverage) {
    object(item); keys(item, ['unitId', 'start', 'end', 'disposition', 'duplicateOf']);
    const unit = input.units.find(candidate => candidate.id === item.unitId); if (!unit) fail('coverage-source'); range(item.start, item.end, pointLength(unit.text));
    if (!slices.some(slice => slice.unitId === item.unitId && item.start >= slice.start && item.end <= slice.end)) fail('coverage-outside-chunk');
    if (item.disposition === 'duplicate') { if (!item.duplicateOf) fail('duplicate-proof'); const target = unitFor(input, item.duplicateOf, allSlices); if (target.kind === unit.kind || item.start !== 0 || item.end !== pointLength(unit.text) || item.duplicateOf.start !== 0 || item.duplicateOf.end !== pointLength(target.text) || comparable(item.duplicateOf.excerpt) !== comparable(pointSlice(unit.text, item.start, item.end))) fail('duplicate-proof'); }
    else if (item.disposition === 'included' && !item.duplicateOf) includedText.push(pointSlice(unit.text, item.start, item.end));
    else fail('coverage-disposition');
    if (item.disposition === 'included') {
      if (!(allCitations.get(item.unitId) ?? []).some(citation => citation.start <= item.start && citation.end >= item.end)) fail('uncited-source-coverage');
      const ownOutput = (qualityPolicy ? generationComparableFacts : comparable)(blocks.filter(block => block.citations.some(citation => citation.unitId === item.unitId && citation.end > item.start && citation.start < item.end)).map(block => block.text).join('\n')); if ((qualityPolicy ? generationQualityCriticalItems(pointSlice(unit.text, item.start, item.end)).some(token => !new Set(generationQualityCriticalItems(ownOutput)).has(token)) : generationCriticalItems(pointSlice(unit.text, item.start, item.end)).some(token => !ownOutput.includes(token)))) fail('omitted-critical-source');
    }
  }
  coverage.forEach((item, index) => { const entries = byUnit.get(item.unitId) ?? []; entries.push(index); byUnit.set(item.unitId, entries); });
  // Frozen source equality only proves duplication, not retention. Follow every claim through
  // this document's coverage until its complete range reaches included, body-cited entries.
  // A chunk cannot borrow a target from another chunk whose retained output it has not seen.
  const state = new Map<number, 'visiting' | 'complete'>(), retainedKinds = new Map<number, Set<GenerationSourceUnit['kind']>>();
  const retained = (index: number): Set<GenerationSourceUnit['kind']> => {
    if (state.get(index) === 'visiting') fail('duplicate-cycle');
    if (state.get(index) === 'complete') return retainedKinds.get(index)!;
    state.set(index, 'visiting');
    const item = coverage[index], unit = input.units.find(source => source.id === item.unitId)!, kinds = new Set<GenerationSourceUnit['kind']>();
    if (item.disposition === 'included') {
      if (!(bodyCitations.get(item.unitId) ?? []).some(citation => citation.start <= item.start && citation.end >= item.end)) fail('uncited-source-coverage');
      kinds.add(unit.kind);
    }
    else {
      const target = item.duplicateOf!, targets = byUnit.get(target.unitId) ?? [];
      if (!union(targets.map(targetIndex => coverage[targetIndex])).some(part => part.start <= target.start && part.end >= target.end)) fail('duplicate-retained-source');
      for (const targetIndex of targets) for (const kind of retained(targetIndex)) kinds.add(kind);
      // Cross-kind chains must not become a back door for deleting a separate original
      // utterance of the same kind merely because its text happens to match.
      if (kinds.has(unit.kind)) fail('duplicate-proof');
    }
    state.set(index, 'complete'); retainedKinds.set(index, kinds); return kinds;
  };
  coverage.forEach((item, index) => { if (item.disposition === 'duplicate') retained(index); });
  for (const slice of slices) {
    const actual = union(coverage.filter(item => item.unitId === slice.unitId && item.start >= slice.start && item.end <= slice.end));
    if (actual.length !== 1 || actual[0].start !== slice.start || actual[0].end !== slice.end) fail('incomplete-source-coverage');
  }
  const sourceText = includedText.join('｜'), body = blocks.filter(block => block.type !== 'heading' && block.type !== 'image').map(block => block.text).join('｜');
  const output = (qualityPolicy ? generationComparableFacts : comparable)(body + '\n' + lead);
  if (qualityPolicy ? generationQualityCriticalItems(sourceText).some(item => !new Set(generationQualityCriticalItems(output)).has(item)) : generationCriticalItems(sourceText).some(item => !output.includes(item))) fail('omitted-critical-source');
  // A conservative anti-summary guard, not evidence that semantic completeness or factuality is proven.
  if (pointLength(comparable(sourceText)) >= 160 && pointLength(comparable(body)) < pointLength(comparable(sourceText)) * .55) fail('summary-instead-of-manuscript');
}
/** New product policy validates source associations, not model-reported semantic/character coverage. */
function checkUsabilityAssociations(coverage: GenerationCoverage[], input: GenerationFrozenInput, slices: GenerationSourceSlice[], blocks: OrganizedDocument['blocks']): void {
  if(!Array.isArray(coverage)||coverage.length>8000)fail('coverage-format');
  const citations=blocks.flatMap(block=>block.citations);
  for(const item of coverage){
    object(item); keys(item,['unitId','start','end','disposition']);
    const unit=input.units.find(unit=>unit.id===item.unitId);if(!unit)fail('coverage-source');range(item.start,item.end,pointLength(unit.text));
    if(item.disposition!=='included'||!slices.some(slice=>slice.unitId===item.unitId&&item.start>=slice.start&&item.end<=slice.end))fail('coverage-outside-chunk');
    // A local association must be traceable to actual persisted references. It is
    // deliberately not evidence that every word in this range appears in the manuscript.
    if(!union(citations.filter(c=>c.unitId===item.unitId)).some(c=>c.start<=item.start&&c.end>=item.end))fail('uncited-source-coverage');
  }
}
export function validateOrganizedDocument(value: unknown, input: GenerationFrozenInput, options: GenerationValidationOptions = {}): asserts value is OrganizedDocument {
  validateGenerationInput(input, options.resolve); const slices = selectedSlices(input, options.chunk); object(value); keys(value, ['schemaVersion', 'sourceRevisionId', 'title', 'lead', 'leadCitations', 'blocks', 'coverage']);
  if (value.schemaVersion !== 1 || value.sourceRevisionId !== input.sourceRevisionId) fail('source-version'); text(value.title, 200); text(value.lead, 1200, true);
  checkCitations(value.leadCitations ?? [], input, options, !!value.lead.trim());
  if (value.lead.trim() && !options.usabilityPolicy) preserveCritical(value.lead, (value.leadCitations ?? []).map((citation: GenerationCitation) => citation.excerpt).join('｜'), options.qualityPolicy);
  if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 3000) fail('empty-manuscript');
  const ids = new Set<string>();
  for (const block of value.blocks) {
    object(block); keys(block, ['id', 'type', 'text', 'level', 'role', 'citations', 'assetRef']); id(block.id); if (ids.has(block.id)) fail('duplicate-block'); ids.add(block.id);
    if (!['heading', 'paragraph', 'quote', 'bullet', 'step', 'image'].includes(block.type) || !['fact', 'structure'].includes(block.role)) fail('block-kind');
    text(block.text, block.type === 'heading' ? 200 : 20_000, block.type === 'image');
    if (block.type === 'heading' ? !Number.isSafeInteger(block.level) || block.level < 1 || block.level > 6 : block.level !== undefined) fail('heading-level');
    if (block.role === 'structure' && !['heading', 'image'].includes(block.type)) fail('unsupported-structural-prose');
    checkCitations(block.citations, input, options, block.role === 'fact');
    if (block.type === 'image') { if (block.text || !block.assetRef || !input.units.some(unit => unit.assetRefs?.some(asset => asset.assetId === block.assetRef.assetId && asset.version === block.assetRef.version))) fail('image-ownership'); }
    else if (block.assetRef !== undefined) fail('unexpected-image');
    if (block.role === 'fact' && !options.usabilityPolicy) preserveCritical(block.text, block.citations.map((citation: GenerationCitation) => citation.excerpt).join('｜'), options.qualityPolicy);
  }
  if (!value.blocks.some((block: any) => block.role === 'fact' && block.type !== 'heading' && block.type !== 'image')) fail('empty-manuscript');
  if(options.usabilityPolicy)checkUsabilityAssociations(value.coverage,input,slices,value.blocks);
  else checkCoverage(value.coverage, input, slices, value.blocks, value.lead, options.qualityPolicy);
  try { organizedToDraft(value as OrganizedDocument, 'validation-workspace', 'validation-draft'); } catch { fail('invalid-draft-tree'); }
}
export function organizedToDraft(document: OrganizedDocument, workspaceId: string, documentId: string, revision = 0): DraftDocument {
  const blocks: DraftBlock[] = []; let step = 0;
  if (document.lead.trim()) blocks.push({ id: `generation-lead-${generationSha256(document.lead).slice(0, 12)}`, type: 'paragraph', runs: [{ text: document.lead }] });
  for (const block of document.blocks) {
    if (block.type === 'image') blocks.push({ id: block.id, type: 'image', runs: [], assetRefs: [clone(block.assetRef!)] });
    else if (block.type === 'quote') blocks.push({ id: block.id, type: 'blockquote', runs: [], children: [{ id: `${block.id}-text`, type: 'paragraph', runs: [{ text: block.text }] }] });
    else if (block.type === 'bullet' || block.type === 'step') blocks.push({ id: block.id, type: block.type === 'step' ? 'orderedList' : 'bulletList', ...(block.type === 'step' ? { start: ++step } : {}), runs: [], children: [{ id: `${block.id}-item`, type: 'listItem', runs: [], children: [{ id: `${block.id}-text`, type: 'paragraph', runs: [{ text: block.text }] }] }] });
    else blocks.push({ id: block.id, type: block.type, runs: [{ text: block.text }], ...(block.type === 'heading' ? { level: block.level } : {}) });
    if (block.type !== 'step') step = 0;
  }
  const draft: DraftDocument = { workspaceId, documentId, schemaVersion: 1, revision, blocks }; validateDraft(draft); return draft;
}
export function validateGeneratedMap(value: unknown, input: GenerationFrozenInput, organized: OrganizedDocument, options: GenerationValidationOptions = {}): asserts value is GeneratedMap {
  object(value); keys(value, ['schemaVersion', 'sourceRevisionId', 'organizedSha256', 'rootId', 'nodes']);
  if (value.schemaVersion !== 1 || value.sourceRevisionId !== input.sourceRevisionId || value.organizedSha256 !== generationSha256(organized)) fail('map-organized-version');
  id(value.rootId); if (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 1000) fail('map-count');
  const ids = new Set<string>();
  for (const node of value.nodes) {
    object(node); keys(node, ['id', 'parentId', 'children', 'title', 'notes', 'role', 'citations']); id(node.id); if (ids.has(node.id)) fail('duplicate-map-node'); ids.add(node.id); if (node.parentId !== null) id(node.parentId);
    if (!Array.isArray(node.children) || node.children.length > 1000) fail('map-children'); node.children.forEach(id); text(node.title, 160); text(node.notes, 8000, true);
    if (!['fact', 'structure'].includes(node.role) || node.role === 'structure' && node.notes.trim()) fail('map-role');
    checkCitations(node.citations, input, options, node.role === 'fact');
    if (node.role === 'fact' && !options.usabilityPolicy) preserveCritical(node.title + '｜' + node.notes, node.citations.map((citation: GenerationCitation) => citation.excerpt).join('｜'), options.qualityPolicy);
  }
  if (!value.nodes.some((node: any) => node.role === 'fact')) fail('empty-map');
  try { generatedToMap(value as GeneratedMap, input, 'validation-workspace', 'validation-map', 0, options.resolve, options.chunk); } catch { fail('invalid-map-tree'); }
}
export function generatedToMap(output: GeneratedMap, input: GenerationFrozenInput, workspaceId: string, documentId: string, revision = 0, resolve?: GenerationReferenceResolver, chunk?: GenerationChunk): MindMapDocument {
  const nodes: MindMapDocument['nodes'] = Object.create(null);
  for (const node of output.nodes) { if (Object.hasOwn(nodes, node.id)) fail('duplicate-map-node'); nodes[node.id] = { id: node.id, parentId: node.parentId, children: [...node.children], title: [{ text: node.title }], notes: node.notes, sourceRefs: node.citations.map(citation => resolveGenerationCitation(input, citation, resolve, chunk)) }; }
  const map: MindMapDocument = { workspaceId, documentId, schemaVersion: 1, revision, sheetId: `${documentId}-sheet`, rootId: output.rootId, theme: { id: 'generation-default', name: '收藏阅读工作台' }, nodes }; validateMap(map); return map;
}
export function mergeOrganizedDocuments(documents: OrganizedDocument[], input: GenerationFrozenInput, plan: GenerationPlan, qualityPolicy = false, usabilityPolicy = false): OrganizedDocument {
  if (plan.sourceSha256 !== generationSha256(input) || plan.sourceRevisionId !== input.sourceRevisionId || documents.length !== plan.chunks.length) fail('merge-input-version');
  const blocks: OrganizedDocument['blocks'] = [], coverage: GenerationCoverage[] = [];
  documents.forEach((document, index) => { validateOrganizedDocument(document, input, { chunk: plan.chunks[index], qualityPolicy, usabilityPolicy }); for (const block of document.blocks) blocks.push({ ...clone(block), id: `c${index}-${block.id}` }); coverage.push(...clone(document.coverage)); });
  const first = documents[0], merged: OrganizedDocument = { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, title: first.title, lead: first.lead, leadCitations: clone(first.leadCitations ?? []), blocks, coverage };
  validateOrganizedDocument(merged, input, { qualityPolicy, usabilityPolicy }); return merged;
}
export function mergeGeneratedMaps(maps: GeneratedMap[], input: GenerationFrozenInput, organized: OrganizedDocument, parts?: OrganizedDocument[], qualityPolicy = false, usabilityPolicy = false): GeneratedMap {
  if (!maps.length || maps.length > 24) fail('merge-map-count');
  if (parts ? parts.length !== maps.length : maps.length !== 1) fail('merge-map-parts');
  const rootId = 'generated-merged-root', nodes: GeneratedMap['nodes'] = [{ id: rootId, parentId: null, children: [], title: organized.title, notes: '', role: 'structure', citations: [] }];
  maps.forEach((map, index) => { validateGeneratedMap(map, input, parts?.[index] ?? organized, { qualityPolicy, usabilityPolicy }); const prefix = `c${index}-`; nodes[0].children.push(prefix + map.rootId); for (const node of map.nodes) nodes.push({ ...clone(node), id: prefix + node.id, parentId: node.parentId === null ? rootId : prefix + node.parentId, children: node.children.map(child => prefix + child) }); });
  const output: GeneratedMap = { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, organizedSha256: generationSha256(organized), rootId, nodes }; validateGeneratedMap(output, input, organized, { qualityPolicy, usabilityPolicy }); return output;
}
export function buildGenerationArtifact(input: GenerationFrozenInput, organized: OrganizedDocument, mapOutput: GeneratedMap, options: { workspaceId: string; draftDocumentId: string; mapDocumentId: string; draftRevision?: number; mapRevision?: number; resolve: GenerationReferenceResolver; qualityPolicy?: boolean; usabilityPolicy?: boolean }): GenerationArtifact {
  if (typeof options.resolve !== 'function') fail('reference-resolver-required'); validateOrganizedDocument(organized, input, { resolve: options.resolve, qualityPolicy: options.qualityPolicy, usabilityPolicy: options.usabilityPolicy }); validateGeneratedMap(mapOutput, input, organized, { resolve: options.resolve, qualityPolicy: options.qualityPolicy, usabilityPolicy: options.usabilityPolicy });
  const draft = organizedToDraft(organized, options.workspaceId, options.draftDocumentId, options.draftRevision), map = generatedToMap(mapOutput, input, options.workspaceId, options.mapDocumentId, options.mapRevision, options.resolve), blockSourceRefs: Record<string, SourceReference[]> = Object.create(null);
  if (organized.lead.trim()) blockSourceRefs[`generation-lead-${generationSha256(organized.lead).slice(0, 12)}`] = (organized.leadCitations ?? []).map(citation => resolveGenerationCitation(input, citation, options.resolve));
  for (const block of organized.blocks) { const target = ['quote', 'bullet', 'step'].includes(block.type) ? `${block.id}-text` : block.id; blockSourceRefs[target] = block.citations.map(citation => resolveGenerationCitation(input, citation, options.resolve)); }
  return { sourceRevisionId: input.sourceRevisionId, sourceSha256: generationSha256(input), organizedSha256: generationSha256(organized), organized: clone(organized), generatedMap: clone(mapOutput), draft, draftSha256: generationSha256(draft), map, blockSourceRefs, review: { state: 'required', reason: options.usabilityPolicy?'AI 整理稿，可编辑校对。引用可能定位到整个来源单元；来源关联不代表逐字覆盖或语义正确性已获证明。':'范围、精确出处、结构和关键表达通过机械校验；事实、完整性与语义一致性仍须独立对照审查。', sourceWarnings: input.units.flatMap(unit => unit.warnings) } };
}
