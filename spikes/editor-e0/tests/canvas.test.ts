import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureBundle } from '../fixtures.js';
import { scaleFixture } from '../scale-fixture.js';
import { MAX_ZOOM, MIN_ZOOM, centerBounds, clampZoom, dropAt, fitBounds, layoutTree, moveAllowed, resizedViewport, screenToWorld, wheelZoomAt, worldToScreen, zoomAt } from '../renderer/canvas.js';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
test('world/screen inverse and anchored zoom remain stable across repeated non-100% transformations', () => {
  let viewport = { x: -248, y: 133, zoom: 0.45 }, point = { x: 701.25, y: -220.5 }, anchor = { x: 347.3, y: 201.1 };
  assert.deepEqual(screenToWorld(worldToScreen(point, viewport), viewport), point);
  const world = screenToWorld(anchor, viewport);
  for (let i = 0; i < 250; i++) { viewport = zoomAt(viewport, viewport.zoom * (i % 2 ? 1 / 1.1 : 1.1), anchor); const result = worldToScreen(world, viewport); close(result.x, anchor.x); close(result.y, anchor.y); }
  close(viewport.zoom, 0.45);
});
test('zoom bounds reject nonfinite input and never reach zero', () => {
  assert.equal(clampZoom(0), MIN_ZOOM); assert.equal(clampZoom(100), MAX_ZOOM);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => clampZoom(value));
  for (const delta of [-100000, 100000, -1e300, 1e300]) { const viewport = wheelZoomAt({ x: 12, y: -22, zoom: 1 }, delta, { x: 400, y: 300 }); assert.ok(Object.values(viewport).every(Number.isFinite)); assert.equal(viewport.zoom, delta < 0 ? MAX_ZOOM : MIN_ZOOM); }
});
test('fit and selected centering use container dimensions and real measured bounds', () => {
  const bounds = { x: 54, y: 91, width: 1260, height: 810 };
  for (const container of [{ width: 1000, height: 700 }, { width: 500, height: 420 }]) {
    const viewport = fitBounds(bounds, container), top = worldToScreen(bounds, viewport), bottom = worldToScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, viewport);
    assert.ok(top.x >= 31.999 && top.y >= 31.999); assert.ok(bottom.x <= container.width - 31.999 && bottom.y <= container.height - 31.999);
    const centered = centerBounds({ x: -9999, y: 4000, zoom: 2 }, bounds, container);
    const center = worldToScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, centered);
    close(center.x, container.width / 2); close(center.y, container.height / 2);
  }
  assert.throws(() => fitBounds(bounds, { width: 0, height: 200 }));
  assert.equal(centerBounds({ x: 1, y: 2, zoom: 2 }, { x: 900, y: 600, width: 194, height: 60 }, { width: 700, height: 600 }).zoom, 2);
  for (const height of [5000, 30000]) { const tall = { x: 24, y: 24, width: 1000, height }, container = { width: 700, height: 600 }, fitted = fitBounds(tall, container); const bottom = worldToScreen({ x: tall.x + tall.width, y: tall.y + tall.height }, fitted); assert.ok(bottom.y <= container.height - 31.999); }
});
test('resize preserves the world coordinate at the container center', () => {
  const old = { width: 800, height: 600 }, next = { width: 1200, height: 450 }, viewport = { x: -420, y: 32, zoom: 0.7 };
  assert.deepEqual(screenToWorld({ x: old.width / 2, y: old.height / 2 }, viewport), screenToWorld({ x: next.width / 2, y: next.height / 2 }, resizedViewport(viewport, old, next)));
});
test('measured tree reserves tall wrapped title/image nodes without sibling overlap', () => {
  const map = createFixtureBundle().map, measured = new Map(Object.keys(map.nodes).map((id, index) => [id, { width: 194, height: index % 2 ? 183 : 52 }]));
  const layout = layoutTree(map, measured), rects = Object.values(layout.nodes);
  assert.equal(rects.length, 12);
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) { const one = rects[a], two = rects[b]; assert.ok(one.x + one.width <= two.x || two.x + two.width <= one.x || one.y + one.height <= two.y || two.y + two.height <= one.y); }
  for (const [id, rect] of Object.entries(layout.nodes)) assert.equal(rect.height, measured.get(id)!.height);
});
test('100/300-node measured samples remain complete and fit within canvas without clipping', () => {
  for (const count of [100, 300]) {
    const map = scaleFixture(createFixtureBundle(), count).map;
    const measured = new Map(Object.values(map.nodes).map(node => [node.id, { width: 194, height: node.title[0].text.length > 30 ? 220 : node.image ? 118 : 52 }]));
    const layout = layoutTree(map, measured), rects = Object.values(layout.nodes);
    assert.equal(rects.length, count);
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) { const one = rects[a], two = rects[b]; assert.ok(one.x + one.width <= two.x || two.x + two.width <= one.x || one.y + one.height <= two.y || two.y + two.height <= one.y); }
    const size = { width: 650, height: 600 }, viewport = fitBounds(layout.bounds, size), bottom = worldToScreen({ x: layout.bounds.x + layout.bounds.width, y: layout.bounds.y + layout.bounds.height }, viewport);
    assert.ok(bottom.x <= size.width - 31.999); assert.ok(bottom.y <= size.height - 31.999);
  }
});
test('drop zones use final-index semantics and reject root/self/descendant/no-op', () => {
  const map = createFixtureBundle().map, layout = layoutTree(map, new Map()), target = layout.nodes['e0-a-n4'];
  const at = (ratio: number, source = 'e0-a-n2') => dropAt(map, layout, source, { x: target.x + 20, y: target.y + target.height * ratio });
  assert.deepEqual(at(0.1), { targetId: 'e0-a-n4', kind: 'before', parentId: 'e0-a-n1', index: 1, allowed: true });
  assert.equal(at(0.9)?.index, 2); assert.equal(at(0.5)?.parentId, 'e0-a-n4'); assert.equal(at(0.5)?.kind, 'child');
  assert.equal(moveAllowed(map, map.rootId, 'e0-a-n2', 0).allowed, false);
  assert.equal(moveAllowed(map, 'e0-a-n2', 'e0-a-n11', 0).allowed, false);
  assert.equal(moveAllowed(map, 'e0-a-n2', 'e0-a-n2', 0).allowed, false);
  assert.equal(moveAllowed(map, 'e0-a-n2', map.rootId, 0).allowed, false);
  assert.equal(moveAllowed(map, 'e0-a-n2', map.rootId, 100).allowed, false);
  assert.equal(dropAt(map, layout, 'e0-a-n2', { x: -9999, y: 0 }), null);
  assert.equal(dropAt(map, layout, 'e0-a-n4', { x: target.x + 20, y: target.y + target.height * 0.9 })?.allowed, false);
});
