/** E4.13：Asia/Shanghai 的日历边界。上海自 1991 年起固定 UTC+8，无夏令时；
 * 用固定的 +8 偏移即可得到正确的自然月／自然日分界。 */
const OFFSET_MS = 8 * 3_600_000;

export function shanghaiMonthStart(now: number): number {
  const shifted = new Date(now + OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - OFFSET_MS;
}

export function shanghaiDayStart(now: number): number {
  const shifted = new Date(now + OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - OFFSET_MS;
}
