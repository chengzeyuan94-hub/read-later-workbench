import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureBundle } from '../fixtures.js';
import { scaleFixture } from '../scale-fixture.js';

test('bounded scale samples preserve original identities, references, assets and input source', () => {
  const base = createFixtureBundle();
  for (const count of [12, 100, 300]) {
    const sample = scaleFixture(base, count);
    assert.equal(Object.keys(sample.map.nodes).length, count);
    for (const node of Object.values(base.map.nodes)) {
      assert.equal(sample.map.nodes[node.id].id, node.id);
      assert.deepEqual(sample.map.nodes[node.id].sourceRefs, node.sourceRefs);
    }
    assert.deepEqual(sample.assets, base.assets);
    assert.deepEqual(sample.transcripts, base.transcripts);
    assert.deepEqual(sample.sources, base.sources);
    assert.ok(sample.map.nodes['e0-a-n9'].title[0].text.includes('\n'));
  }
  assert.equal(Object.keys(base.map.nodes).length, 12);
  assert.throws(() => scaleFixture(base, 0));
  assert.throws(() => scaleFixture(base, 301));
});
