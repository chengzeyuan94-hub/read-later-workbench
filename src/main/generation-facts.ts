/** Comparison-only identities. Source bytes, excerpts, offsets and displayed text never change. */
export const GENERATION_FACT_COMPARISON_POLICY = 'exact-number-unit-v2' as const;
const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const small: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
function integer(value: string): string | undefined {
  if (/^\d+$/.test(value)) return value; // Do not merge padded identifiers (007) with quantities (7).
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(value)) return;
  if (!/[十百千]/.test(value)) return Array.from(value).length === 1 ? String(digit[value]) : undefined;
  let total = 0, pending: number | undefined, last = Infinity;
  for (const c of value) {
    if (digit[c] !== undefined) { if (pending !== undefined && pending !== 0) return; pending = digit[c]; }
    else { const unit = small[c]; if (!unit || unit >= last) return; total += (pending ?? (unit === 10 && total === 0 ? 1 : NaN)) * unit; pending = undefined; last = unit; }
  }
  total += pending ?? 0; if (!Number.isSafeInteger(total) || total < 0 || total > 9999) return;
  // Reject colloquial/ambiguous trailing digits such as 一百二 (could mean 120),
  // rather than silently interpreting them as 102. Standard internal zeroes are explicit.
  const chineseDigits = '零一二三四五六七八九';
  let rendered = '', needsZero = false;
  for (const [power, suffix] of [[1000, '千'], [100, '百'], [10, '十'], [1, '']] as const) {
    const d = Math.floor(total / power) % 10;
    if (d) { if (needsZero) rendered += '零'; rendered += chineseDigits[d] + suffix; needsZero = false; }
    else if (rendered && total % power) needsZero = true;
  }
  if (rendered.startsWith('一十')) rendered = rendered.slice(1);
  const source = value.replaceAll('两', '二').replaceAll('〇', '零').replace(/^一十/u, '十');
  return source === rendered ? String(total) : undefined;
}
function number(value: string): string | undefined {
  const parts = value.split(/[点.]/); if (parts.length > 2) return;
  const whole = integer(parts[0]); if (whole === undefined) return;
  if (parts.length === 1) return whole;
  const fraction = Array.from(parts[1]).map(c => /^\d$/.test(c) ? c : digit[c] === undefined ? '?' : String(digit[c])).join('');
  return /^\d+$/.test(fraction) ? `${whole}.${fraction}` : undefined;
}
const numerals = '[零〇一二两三四五六七八九十百千\\d]+(?:[点.][零〇一二两三四五六七八九\\d]+)?';
const units = '(?:毫克|千克|公斤|毫升|分钟|小时|厘米|毫米|千米|公里|岁|元|克|升|秒|米|倍|次|天|年|月|日|名|个|张|局|牛顿|N|mg|kg|ml|mL|℃|°C|%|％)';
/** Normalize only a syntactically complete quantity/range with its exact explicit unit.
 * No number is inferred from an ambiguous phrase, and no unit/qualifier is invented.
 */
export function generationComparableFacts(value: string): string {
  const compact = value.replace(/\s/gu, '');
  const expression = new RegExp(`(${numerals})(?:([到至~～—–-])(${numerals}))?(${units})`, 'gu');
  return compact.replace(expression, (match, left: string, separator: string | undefined, right: string | undefined, unit: string, offset: number) => {
    // Never normalize inside an alphanumeric/Chinese-numeral identifier or an OCR collision.
    if (offset > 0 && /[A-Za-z0-9零〇一二两三四五六七八九十百千万亿.]/.test(compact[offset - 1])) return match;
    const a = number(left), b = right === undefined ? undefined : number(right); if (a === undefined || right !== undefined && b === undefined) return match;
    return `${a}${separator === undefined ? '' : `~${b}`}${unit}`;
  });
}
/** A complete quantity identity; modifiers remain separate and are checked below. */
export function generationQuantityItems(value: string): string[] {
  const normalized = generationComparableFacts(value);
  return [...new Set(normalized.match(new RegExp(`\\d+(?:[.,]\\d+)*(?:~\\d+(?:[.,]\\d+)*)?(?:${units}|[万亿千百]?元)?`, 'gu')) ?? [])];
}

/** Bound/approximation identities are attached to a complete quantity, not a loose 起/约 character. */
export function generationQualifiedQuantityItems(value: string): string[] {
  const normalized = generationComparableFacts(value);
  const quantity = `\\d+(?:[.,]\\d+)*(?:~\\d+(?:[.,]\\d+)*)?${units}`;
  return [...new Set(normalized.match(new RegExp(`(?:(?:至少|最多|不超过|超过|不足|大约|约|不到|不低于|不高于)${quantity}|${quantity}(?:以上|以下|以内|以外|左右|上下|起))`, 'gu')) ?? [])];
}
