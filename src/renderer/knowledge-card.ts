import { plainText, type MindMapDocument } from '../editor-core/model';
import type { KnowledgeCardPayload } from '../shared/knowledge-card';
import { platformShortName } from './ui-terms';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;
/** Usable text width of the viewpoint block in px (card padding and border subtracted). */
const VIEWPOINT_TEXT_WIDTH = 880;
const VIEWPOINT_SIZES = [56, 52, 48, 44, 40, 36, 34];
const VIEWPOINT_MAX_LINES = 6;
/** Pixel font is for short labels only; longer Chinese text falls back to sans. */
const PIXEL_CHAR_LIMIT = 24;
const POINT_LIMIT = 4;

const wideChar = /[㐀-鿿豈-﫿＀-￯　-〿—‘’“”…·]/;
/** Approximate rendered width in CJK character units (latin ≈ 0.55). */
const textWidth = (text: string): number => {
  let width = 0;
  for (const char of text) width += wideChar.test(char) ? 1 : 0.55;
  return width;
};

const charsPerLine = (size: number): number => Math.max(4, Math.floor(VIEWPOINT_TEXT_WIDTH / size));

export function estimateLines(text: string, size: number): number {
  const perLine = charsPerLine(size);
  return text.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(textWidth(line) / perLine)), 0);
}

export interface ViewpointLayout { family: 'pixel' | 'sans'; size: number; lines: number; truncated: boolean; display: string }
export function viewpointLayout(text: string): ViewpointLayout {
  const clean = text.trim();
  const family = Array.from(clean).length <= PIXEL_CHAR_LIMIT ? 'pixel' : 'sans';
  for (const size of VIEWPOINT_SIZES) {
    const lines = estimateLines(clean, size);
    if (lines <= VIEWPOINT_MAX_LINES) return { family, size, lines, truncated: false, display: clean };
  }
  const size = VIEWPOINT_SIZES[VIEWPOINT_SIZES.length - 1];
  const budget = charsPerLine(size) * VIEWPOINT_MAX_LINES - 1;
  let kept = '';
  let width = 0;
  for (const char of clean) {
    const next = width + (wideChar.test(char) ? 1 : 0.55);
    if (next > budget) break;
    width = next;
    kept += char;
  }
  return { family, size, lines: VIEWPOINT_MAX_LINES, truncated: true, display: `${kept.trimEnd()}…` };
}

/** One-line text: collapse whitespace, truncate with a visible ellipsis. */
export function fitLine(text: string, max = 42): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/** Depth-first position of the node in the map tree (0 = root). Stable for a saved tree. */
export function nodeIndex(map: MindMapDocument, nodeId: string): number {
  let index = 0;
  let found = -1;
  const walk = (id: string) => {
    if (id === nodeId) found = index;
    index += 1;
    for (const child of map.nodes[id]?.children ?? []) walk(child);
  };
  if (map.nodes[map.rootId]) walk(map.rootId);
  if (found < 0) found = Object.keys(map.nodes).indexOf(nodeId);
  return Math.max(0, found);
}

export const cardNumber = (contentId: number, index: number): string => `No.${contentId}-${String(index).padStart(2, '0')}`;

export function cardDate(now: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}.${value('month')}.${value('day')}`;
}

export function buildKnowledgeCard(map: MindMapDocument, nodeId: string, content: { id: number; platform: string; author?: string | null; title?: string | null }, now: number): KnowledgeCardPayload {
  const node = map.nodes[nodeId];
  if (!node) throw new Error('知识卡片节点不存在');
  const childTexts = node.children
    .map(childId => map.nodes[childId])
    .filter((child): child is NonNullable<typeof child> => !!child)
    .map(child => plainText(child.title).trim())
    .filter(text => text.length > 0);
  const parent = node.parentId && map.nodes[node.parentId] ? plainText(map.nodes[node.parentId].title).trim() : '';
  return {
    number: cardNumber(content.id, nodeIndex(map, nodeId)),
    viewpoint: plainText(node.title).trim(),
    points: childTexts.slice(0, POINT_LIMIT),
    pointsTotal: childTexts.length,
    parent,
    source: { platform: platformShortName(content.platform), author: (content.author ?? '').trim(), title: fitLine(content.title ?? '') },
    date: cardDate(now),
  };
}

/** Decorative receipt-strip bars derived deterministically from the card number. */
export function cardBarcode(seed: string): number[] {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  const bars: number[] = [];
  let state = (hash >>> 0) || 1;
  for (let index = 0; index < 26; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    bars.push(1 + (state % 3));
  }
  return bars;
}
