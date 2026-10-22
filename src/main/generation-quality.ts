import type { GeneratedMap, GenerationFrozenInput, GenerationQualityAudit, GenerationStage, OrganizedDocument } from '../shared/generation-contracts.js';
import { generationSha256, GenerationValidationError } from './generation-validation.js';
import { generationComparableFacts, generationQualifiedQuantityItems, generationQuantityItems } from './generation-facts.js';

export const GENERATION_QUALITY_POLICY = 'typed-map-source-fidelity-v3' as const;
export const GENERATION_QUALITY_PROMPT_VERSION = 'read-create-quality-v2' as const;
function fail(code: string, path: string, repairHint: string): never { throw new GenerationValidationError(code, path, repairHint); }
function record(value: unknown, path: string): asserts value is Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('quality-wire-object', path, '只使用协议列明的 JSON 对象。'); }
function keys(value: object, allowed: readonly string[], path: string): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail('quality-wire-field', path, '不要把事实说明放在主题分组中；有事实的内容应作为 claim 节点并引用。'); }
function text(value: unknown, max: number, path: string, empty = false): asserts value is string { if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('quality-wire-text', path, '按字段长度和文本类型输出，不增加其他字段。'); }
/** New wire only. Old flat maps are never silently repaired by changing roles or dropping notes. */
export function normalizeGenerationQuality(stage: GenerationStage, input: GenerationFrozenInput, original: unknown, organized?: OrganizedDocument): { value: unknown; audit?: GenerationQualityAudit } {
  if (stage === 'organize') return { value: original };
  record(original, '/'); keys(original, ['schemaVersion', 'sourceRevisionId', 'organizedSha256', 'root'], '/');
  if (original.schemaVersion !== 2 || original.sourceRevisionId !== input.sourceRevisionId || !organized || original.organizedSha256 !== generationSha256(organized)) fail('quality-wire-version', '/', '导图必须使用 schemaVersion 2 及本次输入的来源版本、整理摘要。');
  const nodes: GeneratedMap['nodes'] = [], nodeMappings: GenerationQualityAudit['nodeMappings'] = [];
  const visit = (node: unknown, path: string, parentId: string | null, depth: number): string => {
    record(node, path); if (depth > 32 || nodes.length >= 1000) fail('quality-wire-boundary', path, '保持有用层级并控制在协议节点数和深度内。');
    if (node.kind !== 'group' && node.kind !== 'claim') fail('quality-wire-kind', `${path}/kind`, '主题用 group，事实观点用 claim；不要混用。');
    keys(node, node.kind === 'group' ? ['kind', 'topic', 'children'] : ['kind', 'title', 'explanation', 'citations', 'children'], path);
    const id = `qnode-${nodes.length}`, group = node.kind === 'group';
    text(group ? node.topic : node.title, 160, `${path}/${group ? 'topic' : 'title'}`);
    if (!group) { text(node.explanation, 8000, `${path}/explanation`, true); if (!Array.isArray(node.citations)) fail('quality-wire-citations', `${path}/citations`, '事实节点必须给本次整理稿中已有的精确来源引用。'); }
    if (!Array.isArray(node.children)) fail('quality-wire-children', `${path}/children`, '每个节点都提供 children 数组，叶节点使用 []。');
    nodes.push({ id, parentId, children: [], title: group ? node.topic : node.title, notes: group ? '' : node.explanation, role: group ? 'structure' : 'fact', citations: group ? [] : structuredClone(node.citations) });
    nodeMappings.push({ path, id, kind: node.kind });
    const entry = nodes.at(-1)!; entry.children = node.children.map((child: unknown, index: number) => visit(child, `${path}/children/${index}`, id, depth + 1));
    return id;
  };
  record(original.root, '/root'); if (original.root.kind !== 'group') fail('quality-wire-root', '/root/kind', '根为无事实说明的 group；具体观点放入有引用的 claim。');
  const rootId = visit(original.root, '/root', null, 0);
  const value: GeneratedMap = { schemaVersion: 1, sourceRevisionId: input.sourceRevisionId, organizedSha256: generationSha256(organized), rootId, nodes };
  return { value, audit: { policyVersion: GENERATION_QUALITY_POLICY, sourceSha256: generationSha256(input), originalValueSha256: generationSha256(original), canonicalValueSha256: generationSha256(value), nodeMappings } };
}
export function verifyGenerationQualityAudit(stage: GenerationStage, input: GenerationFrozenInput, original: unknown, canonical: unknown, audit: GenerationQualityAudit, organized?: OrganizedDocument): void {
  const expected = normalizeGenerationQuality(stage, input, original, organized);
  if (!expected.audit || generationSha256(expected.audit) !== generationSha256(audit) || generationSha256(expected.value) !== generationSha256(canonical)) fail('quality-proof-mismatch', '/', '原始响应与机械派生证明不一致；恢复确切原文件，不可改写引用或事实。');
}
const strongStructure = /一定|必然|完全|所有|任何|始终|绝不|不可能|无关|不会|不能|无需|无须|没有|必定|等于|相同|相等|[=<>]|\d|[零〇一二两三四五六七八九十百千]+(?:岁|元|米|秒|倍|次|N|牛顿)/u;
const conditional = /如果|假设|只有|除非|若|当.{1,40}时|在.{1,40}情况下/u;
const epistemic = /可能|大约|也许|据称|推测/u;
const negative = /不能|不可|不得|不要|没有|不是|不应|不会|不超过|不低于|不高于|无需|无须|非商用/gu;
function anchors(text: string): Set<string> {
  const compact = generationComparableFacts(text).replace(/原正文|截图|图片|视频|讲解|作者|来源|认为|我们|这个|然后|这里|有一个|如果|假设|只有|除非|可能|大约|也许|据称|推测|〔[^〕]*〕/gu, '').replace(/[^\p{L}\p{N}.~%]/gu, '');
  const chars = Array.from(compact), grams = new Set<string>(); for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i] + chars[i + 1]); return grams;
}
/** Localize risk checks to the best lexically supported sentence(s), rather than
 * applying every condition from a full-unit citation to an unrelated local claim.
 * This is a deterministic known-risk screen, not semantic sentence alignment.
 */
function relevantSentences(cited: string, output: string): string[] {
  const parts = cited.split(/[。！？!?；;\n｜]+/u).filter(part => part.trim()), target = anchors(output);
  if (parts.length <= 1) return parts;
  const scored = parts.map(part => { const source = anchors(part), common = [...source].filter(item => target.has(item)).length; return { part, common, score: source.size && target.size ? common / Math.min(source.size, target.size) : 0 }; });
  const best = Math.max(...scored.map(item => item.score));
  return scored.filter(item => item.common >= 2 && item.score >= Math.max(.2, best * .7)).map(item => item.part);
}
function attributionBindings(text: string): { subject: string; stance: string }[] {
  const result: { subject: string; stance: string }[] = [];
  for (const match of text.matchAll(/(原正文|截图(?:作者)?[甲乙丙丁A-Za-z]?|作者[甲乙丙丁A-Za-z]?|[甲乙丙丁])[^，。；!?]{0,8}?(反对|赞同|支持|否认|主张)/gu)) result.push({ subject: match[1], stance: match[2] });
  return result;
}
/** A bounded risk screen, not a claim of general semantic or ASR correctness. */
export function validateGenerationQuality(stage: GenerationStage, value: unknown, input: GenerationFrozenInput, organized?: OrganizedDocument): void {
  record(value, '/');
  if (stage === 'organize' && typeof value.title === 'string' && strongStructure.test(value.title)) fail('quality-structural-claim', '/title', '文章总标题保持中性；具体条件、数字或结论放在有引用的事实正文。');
  const entries: { text: string; role: string; citations: any[]; path: string }[] = stage === 'organize'
    ? (value.blocks ?? []).map((block: any, i: number) => ({ text: block.text, role: block.role, citations: block.citations, path: `/blocks/${i}` }))
    : (value.nodes ?? []).map((node: any, i: number) => ({ text: node.title + '。' + node.notes, role: node.role, citations: node.citations, path: `/nodes/${i}` }));
  for (const item of entries) {
    if (typeof item.text !== 'string') continue;
    if (item.role === 'structure') { if (strongStructure.test(item.text)) fail('quality-structural-claim', item.path, '分组只写中性主题；有数字、条件或结论的标题改为有引用的事实节点，保留完整条件和说明。'); continue; }
    const cited = (Array.isArray(item.citations) ? item.citations : []).map(c => typeof c?.excerpt === 'string' ? c.excerpt : '').join('｜');
    const relevant = relevantSentences(cited, item.text), relevantText = relevant.join('｜');
    if (conditional.test(relevantText) && !conditional.test(item.text)) fail('quality-lost-condition', item.path, '相关原句存在前提条件，正文或节点说明中保留该条件，不能改成普遍断言。');
    if (epistemic.test(relevantText) && !epistemic.test(item.text)) fail('quality-lost-uncertainty', item.path, '保留相关原句的可能、近似或推测限定，不将其改为确定事实。');
    const outputNegatives = new Set(item.text.match(negative) ?? []);
    if ((relevantText.match(negative) ?? []).some(marker => !outputNegatives.has(marker))) fail('quality-lost-negation', item.path, '保留相关原句的否定与限制，不改成肯定或相反上下界。');
    const sourceBindings = attributionBindings(cited), outputBindings = attributionBindings(item.text);
    for (const binding of outputBindings) {
      const known = sourceBindings.filter(source => source.subject === binding.subject);
      if (known.length && !known.some(source => source.stance === binding.stance)) fail('quality-attribution-reversed', item.path, '不能交换作者、原正文或截图的立场；保留各自归因和分歧。');
    }
    const kinds = new Set((Array.isArray(item.citations) ? item.citations : []).map(c => input.units.find(u => u.id === c?.unitId)?.kind));
    if (/原正文(?:称|认为|表示|主张|反对|赞同)/u.test(item.text) && !kinds.has('capturedSource') || /(?:截图|图片)(?:中|作者)?(?:称|认为|表示|主张|反对|赞同)/u.test(item.text) && !kinds.has('ocr')) fail('quality-attribution-source-kind', item.path, '原正文和图片的说法应引用各自来源，不能互换。');
    if (/(?:我|作者|说话者).{0,12}(?:唯一想到|只想到)|唯一想到/u.test(cited) && /唯一(?:可能|方法|办法|方案|原因|途径|结论)/u.test(item.text) && !/唯一想到|只想到/u.test(item.text)) fail('quality-strengthened-possibility', item.path, '个人目前想到的做法不能改成唯一可能；保留个人归因和认知范围。');
    const ocrUnits = (Array.isArray(item.citations) ? item.citations : []).filter(c => input.units.find(u => u.id === c?.unitId)?.kind === 'ocr');
    for (const c of ocrUnits) {
      const relevantOcr = relevantSentences(typeof c.excerpt === 'string' ? c.excerpt : '', item.text).join('｜');
      const suspects = relevantOcr.match(/\d+[A-Z]{2,}\d*/gu) ?? [];
      for (const suspect of suspects) if (!item.text.includes(suspect)) fail('quality-ocr-suspect-rewritten', item.path, '保留可疑识别词原样并标注“原识别文字，待校对”，不得自信补字或改数字。');
    }
    const outputQuantities = new Set(generationQuantityItems(item.text));
    for (const quantity of generationQualifiedQuantityItems(relevantText)) {
      // A map may select a different fact from a long source, but a quantity it
      // actually repeats may not shed that quantity's original bound/approximation.
      if (generationQuantityItems(quantity).some(atom => outputQuantities.has(atom)) && !generationQualifiedQuantityItems(item.text).includes(quantity)) fail('quality-lost-quantity-bound', item.path, '与数值相关的近似、起价、范围上限或下限不能省略或反转。');
    }
    const sourceQuantities = new Set(generationQuantityItems(cited));
    for (const age of generationQuantityItems(item.text).filter(atom => atom.endsWith('岁'))) if (!sourceQuantities.has(age)) fail('quality-inferred-age', item.path, '没有明确年龄单位的含混转录不能推断成年龄；保留原表达并标注待校对。');
  }
  if (stage === 'map' && organized && value.organizedSha256 !== generationSha256(organized)) fail('quality-organized-version', '/', '图稿必须绑定同一整理版本。');
}
