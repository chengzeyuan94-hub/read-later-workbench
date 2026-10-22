import type { MindMapDocument } from './model.js';

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}
export interface Viewport extends Point { zoom: number }
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 2.5;
export const DRAG_THRESHOLD = 6; // screen pixels, independent of zoom
export const NODE_WIDTH = 194;
export const LAYOUT_GAP_X = 54;
export const LAYOUT_GAP_Y = 26;
const finite = (value: number) => Number.isFinite(value);
export function clampZoom(value: number): number {
  if (!finite(value)) throw new Error('zoom must be finite');
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}
export function worldToScreen(point: Point, viewport: Viewport): Point { return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y }; }
export function screenToWorld(point: Point, viewport: Viewport): Point { return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom }; }
export function zoomAt(viewport: Viewport, requestedZoom: number, anchor: Point): Viewport {
  const zoom = clampZoom(requestedZoom), world = screenToWorld(anchor, viewport);
  return { x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom, zoom };
}
/** Clamp a wheel exponent before exp: large trackpad deltas cannot produce Infinity. */
export function wheelZoomAt(viewport: Viewport, deltaY: number, anchor: Point): Viewport {
  if (!finite(deltaY)) throw new Error('wheel delta must be finite');
  return zoomAt(viewport, viewport.zoom * Math.exp(-Math.max(-4000, Math.min(4000, deltaY)) * 0.005), anchor);
}
export function fitBounds(bounds: Rect, container: Size, padding = 32): Viewport {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, container.width, container.height, padding].every(finite) || bounds.width <= 0 || bounds.height <= 0 || container.width <= 0 || container.height <= 0 || padding < 0) throw new Error('invalid fit dimensions');
  const zoom = clampZoom(Math.min(Math.max(1, container.width - 2 * padding) / bounds.width, Math.max(1, container.height - 2 * padding) / bounds.height, 1));
  return { x: (container.width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (container.height - bounds.height * zoom) / 2 - bounds.y * zoom, zoom };
}
export function centerBounds(viewport: Viewport, target: Rect, container: Size, padding = 32): Viewport {
  fitBounds(target, container, padding); // Validate the same size/bounds contract.
  const fitZoom = clampZoom(Math.min(Math.max(1, container.width - 2 * padding) / target.width, Math.max(1, container.height - 2 * padding) / target.height));
  const zoom = Math.min(viewport.zoom, fitZoom);
  return { x: container.width / 2 - (target.x + target.width / 2) * zoom, y: container.height / 2 - (target.y + target.height / 2) * zoom, zoom };
}
export function resizedViewport(viewport: Viewport, oldSize: Size, nextSize: Size): Viewport {
  return { ...viewport, x: viewport.x + (nextSize.width - oldSize.width) / 2, y: viewport.y + (nextSize.height - oldSize.height) / 2 };
}
export interface TreeLayout { nodes: Record<string, Rect>; bounds: Rect }
/** A whole subtree reserves its actual measured height; siblings never share a fixed row. */
export function layoutTree(map: MindMapDocument, measured: ReadonlyMap<string, Size>): TreeLayout {
  const nodes: Record<string, Rect> = {}, heights = new Map<string, number>(), columns: number[] = [];
  function measure(id: string, depth: number): number {
    const size = measured.get(id) ?? { width: NODE_WIDTH, height: 72 };
    columns[depth] = Math.max(columns[depth] ?? 0, size.width);
    const childrenHeight = map.nodes[id].children.reduce((sum, child, index) => sum + measure(child, depth + 1) + (index ? LAYOUT_GAP_Y : 0), 0);
    const height = Math.max(size.height, childrenHeight); heights.set(id, height); return height;
  }
  measure(map.rootId, 0);
  const columnX = columns.map((_, index) => 24 + columns.slice(0, index).reduce((sum, width) => sum + width + LAYOUT_GAP_X, 0));
  function place(id: string, depth: number, top: number) {
    const node = map.nodes[id], size = measured.get(id) ?? { width: NODE_WIDTH, height: 72 }, total = heights.get(id)!;
    nodes[id] = { x: columnX[depth], y: top + (total - size.height) / 2, ...size };
    const childHeight = node.children.reduce((sum, child, index) => sum + heights.get(child)! + (index ? LAYOUT_GAP_Y : 0), 0);
    let childTop = top + (total - childHeight) / 2;
    for (const child of node.children) { place(child, depth + 1, childTop); childTop += heights.get(child)! + LAYOUT_GAP_Y; }
  }
  place(map.rootId, 0, 24);
  const all = Object.values(nodes), right = Math.max(...all.map(rect => rect.x + rect.width)), bottom = Math.max(...all.map(rect => rect.y + rect.height));
  return { nodes, bounds: { x: 24, y: 24, width: right - 24, height: bottom - 24 } };
}
export type DropKind = 'before' | 'after' | 'child';
export interface DropPreview { targetId: string; kind: DropKind; parentId: string; index: number; allowed: boolean; reason?: string }
export function moveAllowed(map: MindMapDocument, nodeId: string, parentId: string, index: number): { allowed: boolean; reason?: string } {
  const node = map.nodes[nodeId], parent = map.nodes[parentId];
  if (!node || !parent) return { allowed: false, reason: '目标不存在' };
  if (node.parentId === null) return { allowed: false, reason: '根节点不能移动' };
  let ancestor: string | null = parentId;
  while (ancestor !== null) { if (ancestor === nodeId) return { allowed: false, reason: '不能移入自身或后代' }; ancestor = map.nodes[ancestor].parentId; }
  const count = parent.children.length - (node.parentId === parentId ? 1 : 0);
  if (!Number.isSafeInteger(index) || index < 0 || index > count) return { allowed: false, reason: '落点索引越界' };
  if (node.parentId === parentId && parent.children.indexOf(nodeId) === index) return { allowed: false, reason: '当前位置，无需移动' };
  return { allowed: true };
}
/** Drop zones are derived in world coordinates from measured rectangles, not unscaled CSS pixels. */
export function dropAt(map: MindMapDocument, layout: TreeLayout, draggedId: string, point: Point): DropPreview | null {
  const hit = Object.entries(layout.nodes).find(([, rect]) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height);
  if (!hit) return null;
  const [targetId, rect] = hit, target = map.nodes[targetId], ratio = (point.y - rect.y) / rect.height;
  const kind: DropKind = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child';
  if (targetId === draggedId) return { targetId, kind, parentId: targetId, index: -1, allowed: false, reason: '不能放到自身' };
  if (kind !== 'child' && target.parentId === null) return { targetId, kind, parentId: '', index: -1, allowed: false, reason: '不能放到根节点前后' };
  const parentId = kind === 'child' ? targetId : target.parentId!, parent = map.nodes[parentId];
  const withoutSource = parent.children.filter(id => id !== draggedId);
  const index = kind === 'child' ? withoutSource.length : withoutSource.indexOf(targetId) + (kind === 'after' ? 1 : 0);
  return { targetId, kind, parentId, index, ...moveAllowed(map, draggedId, parentId, index) };
}
