export interface KnowledgeCardSource { platform: string; author: string; title: string }
export interface KnowledgeCardPayload {
  /** No.<contentId>-<nodeIndex> */
  number: string;
  viewpoint: string;
  points: string[];
  /** Total non-empty direct-child points; points carries at most the first 4. */
  pointsTotal: number;
  /** Parent node text; empty for the root. */
  parent: string;
  source: KnowledgeCardSource;
  /** Card creation date, already formatted. */
  date: string;
}
export type KnowledgeCardTarget = 'save' | 'copy';

const TEXT_LIMIT = 20 * 1024;
const FIELD_LIMIT = 4000;
const invalid = (): never => { throw new Error('知识卡片内容无效'); };
const field = (value: unknown, max = FIELD_LIMIT): string => {
  if (typeof value !== 'string' || value.length > max) invalid();
  return value as string;
};

export function validateKnowledgeCardPayload(value: unknown): KnowledgeCardPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowed = new Set(['number', 'viewpoint', 'points', 'pointsTotal', 'parent', 'source', 'date']);
  for (const key of Object.keys(value as object)) if (!allowed.has(key)) invalid();
  const raw = value as Record<string, unknown>;
  const totalValue = raw.pointsTotal;
  if (typeof totalValue !== 'number' || !Number.isSafeInteger(totalValue) || totalValue < 0) invalid();
  const pointsTotal = totalValue as number;
  if (!Array.isArray(raw.points) || raw.points.length > 8 || (raw.points as unknown[]).length > pointsTotal) invalid();
  const points = (raw.points as unknown[]).map((point: unknown) => field(point));
  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)) invalid();
  for (const key of Object.keys(raw.source as object)) if (!['platform', 'author', 'title'].includes(key)) invalid();
  const sourceRaw = raw.source as Record<string, unknown>;
  const card: KnowledgeCardPayload = {
    number: field(raw.number, 80),
    viewpoint: field(raw.viewpoint),
    points,
    pointsTotal,
    parent: field(raw.parent, 600),
    source: { platform: field(sourceRaw.platform, 80), author: field(sourceRaw.author, 300), title: field(sourceRaw.title, 600) },
    date: field(raw.date, 40),
  };
  const text = card.number + card.viewpoint + card.parent + card.date + card.source.platform + card.source.author + card.source.title + card.points.join('');
  if (text.length > TEXT_LIMIT) invalid();
  return card;
}
