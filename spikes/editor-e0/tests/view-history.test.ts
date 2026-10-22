import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorState, execute } from '../commands.js';
import { createFixtureBundle } from '../fixtures.js';

test('viewport fast path shares content/history; view changes retain redo and persistence revisions', () => {
  let state = createEditorState(createFixtureBundle());
  state = execute(state,{type:'rename',nodeId:state.map.rootId,title:[{text:'renamed'}]}).state;
  state = execute(state,{type:'undo'}).state;
  const before = state;
  const result = execute(state,{type:'viewport',x:-500,y:270,zoom:0.65});
  assert.equal(result.changed,false);
  state = result.state;
  for (const key of ['map','draft','history'] as const) assert.equal(state[key],before[key]);
  assert.equal(state.dirty,before.dirty);
  assert.equal(state.history.future.length,1);
  state = execute(state,{type:'redo'}).state;
  assert.deepEqual(state.view.viewport,{x:-500,y:270,zoom:0.65});
  assert.equal(state.map.revision,1);
  assert.equal(state.draft.revision,1);
  state = execute(state,{type:'undo'}).state;
  assert.deepEqual(state.view.viewport,{x:-500,y:270,zoom:0.65});
  for(const zoom of [NaN,Infinity,0,-1]) {
    const rejected = execute(state,{type:'viewport',x:0,y:0,zoom});
    assert.ok(rejected.error);assert.equal(rejected.state,state);
  }
});
