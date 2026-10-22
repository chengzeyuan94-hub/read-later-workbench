import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureBundle } from '../fixtures.js';
import { clone, type SaveRequest, type SaveResult, type WorkspaceBundle } from '../model.js';
import { SaveCoordinator } from '../renderer/save-coordinator.js';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const saved = (requests: SaveRequest[]): SaveResult[] => requests.map(request => ({ status: 'saved', workspaceId: request.workspaceId, documentId: request.documentId, sessionId: request.sessionId, requestId: request.requestId, committedRevision: request.expectedRevision + 1 }));
function modify(coordinator: SaveCoordinator, text: string) { const bundle = clone(coordinator.active!.bundle); bundle.draft.blocks[0].runs = [{ text }]; coordinator.replace(bundle.draft, bundle.map); }

test('save in flight cannot clear later typing; follow-up uses durable revision', async () => {
  const pending = deferred<SaveResult[]>(); let first: SaveRequest[] = []; let followup: SaveRequest[] = [];
  const coordinator = new SaveCoordinator({ load: async () => createFixtureBundle(), saveAtomic: async requests => { if (!first.length) { first = requests; return pending.promise; } followup = requests; return saved(requests); } });
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'first'); const save = coordinator.save(); modify(coordinator, 'second'); pending.resolve(saved(first)); assert.equal(await save, true);
  assert.equal(coordinator.active!.status, 'dirty'); assert.equal(coordinator.active!.bundle.draft.blocks[0].runs[0].text, 'second'); assert.equal(coordinator.active!.bundle.draft.revision, 2);
  await coordinator.save(); assert.equal(followup[0].expectedRevision, 2); assert.equal(coordinator.active!.status, 'saved');
});
test('old save reply only updates its cached session, never the newly active document', async () => {
  const pending = deferred<SaveResult[]>(); let captured: SaveRequest[] = [];
  const coordinator = new SaveCoordinator({ load: async id => createFixtureBundle(id.includes('-b-') ? 'b' : 'a'), saveAtomic: async requests => { captured = requests; return pending.promise; } });
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'A edit'); const operation = coordinator.save(); await coordinator.activate('e0-b-workspace'); modify(coordinator, 'B edit'); pending.resolve(saved(captured)); await operation;
  assert.equal(coordinator.active!.workspaceId, 'e0-b-workspace'); assert.equal(coordinator.active!.bundle.draft.blocks[0].runs[0].text, 'B edit'); assert.equal(coordinator.active!.bundle.draft.revision, 1); assert.equal(coordinator.active!.status, 'dirty');
  await coordinator.activate('e0-a-workspace'); assert.equal(coordinator.active!.bundle.draft.blocks[0].runs[0].text, 'A edit'); assert.equal(coordinator.active!.status, 'saved');
});
test('out-of-order loads and late candidates cannot replace another workspace or newer edits', async () => {
  const a = deferred<WorkspaceBundle>(); const b = deferred<WorkspaceBundle>();
  const coordinator = new SaveCoordinator({ load: id => id.includes('-a-') ? a.promise : b.promise, saveAtomic: async requests => saved(requests) });
  const loadA = coordinator.activate('e0-a-workspace'); const loadB = coordinator.activate('e0-b-workspace'); b.resolve(createFixtureBundle('b')); await loadB; a.resolve(createFixtureBundle('a')); assert.equal(await loadA, null);
  assert.equal(coordinator.active!.workspaceId, 'e0-b-workspace'); const token = coordinator.candidateToken(); modify(coordinator, 'new edit'); let applied = false; assert.equal(coordinator.applyCandidate(token, () => { applied = true; }), false); assert.equal(applied, false);
  const token2 = coordinator.candidateToken(); await coordinator.activate('e0-b-workspace'); assert.equal(coordinator.applyCandidate(token2, () => { applied = true; }), false);
});
test('write failure preserves current draft and baseline; retry submits same durable revision', async () => {
  let fail = true; const revisions: number[] = [];
  const coordinator = new SaveCoordinator({ load: async () => createFixtureBundle(), saveAtomic: async requests => { revisions.push(requests[0].expectedRevision); if (fail) { fail = false; return requests.map(request => ({ status: 'failed', workspaceId: request.workspaceId, documentId: request.documentId, sessionId: request.sessionId, requestId: request.requestId, error: 'controlled disk error' })); } return saved(requests); } });
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'keep me'); assert.equal(await coordinator.save(), false); assert.equal(coordinator.active!.status, 'failed'); assert.equal(coordinator.active!.bundle.draft.revision, 1); assert.equal(coordinator.active!.bundle.draft.blocks[0].runs[0].text, 'keep me');
  assert.equal(await coordinator.save(), true); assert.deepEqual(revisions, [1, 1]); assert.equal(coordinator.active!.status, 'saved');
});
test('conflict and mismatched reply identity remain dirty, never count as confirmation', async () => {
  let mismatch = false;
  const coordinator = new SaveCoordinator({ load: async () => createFixtureBundle(), saveAtomic: async requests => mismatch ? saved(requests).map(result => ({ ...result, sessionId: 'wrong-session' })) : requests.map(request => ({ status: 'conflict', workspaceId: request.workspaceId, documentId: request.documentId, sessionId: request.sessionId, requestId: request.requestId, actualRevision: 9 })) });
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'keep me'); assert.equal(await coordinator.save(), false); assert.equal(coordinator.active!.status, 'conflict'); assert.equal(coordinator.isDirty(), true); mismatch = true; assert.equal(await coordinator.save(), false); assert.equal(coordinator.active!.status, 'failed'); assert.equal(coordinator.active!.bundle.draft.revision, 1);
});
test('normal close saveAll refuses success if typing continued during final request', async () => {
  const pending = deferred<SaveResult[]>(); let captured: SaveRequest[] = [];
  const coordinator = new SaveCoordinator({ load: async () => createFixtureBundle(), saveAtomic: async requests => { captured = requests; return pending.promise; } });
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'first'); const closing = coordinator.saveAll(); modify(coordinator, 'last keys'); pending.resolve(saved(captured)); assert.equal(await closing, false); assert.equal(coordinator.isDirty(), true);
});
test('normal close rechecks earlier session edited while later workspace was saving', async () => {
  const pendingB = deferred<SaveResult[]>(); const beganB = deferred<SaveRequest[]>();
  const coordinator = new SaveCoordinator({ load: async id => createFixtureBundle(id.includes('-b-') ? 'b' : 'a'), saveAtomic: async requests => {
    if (requests[0].workspaceId === 'e0-b-workspace') { beganB.resolve(requests); return pendingB.promise; }
    return saved(requests);
  } });
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'A before close');
  await coordinator.activate('e0-b-workspace'); modify(coordinator, 'B before close');
  const closing = coordinator.saveAll(); const bRequests = await beganB.promise;
  await coordinator.activate('e0-a-workspace'); modify(coordinator, 'A changed while B pending');
  pendingB.resolve(saved(bRequests)); assert.equal(await closing, false);
  assert.equal(coordinator.isDirty(), true); assert.equal(coordinator.active!.bundle.draft.blocks[0].runs[0].text, 'A changed while B pending'); assert.equal(coordinator.active!.status, 'dirty');
});
test('invalid saved acknowledgements reject entire batch without changing either durable revision', async () => {
  for (const invalid of [{ committedRevision: -1 }, { committedRevision: 100 }, { committedRevision: undefined }, { status: 'unknown' }]) {
    const coordinator = new SaveCoordinator({ load: async () => createFixtureBundle(), saveAtomic: async requests => {
      const results = saved(requests); results[1] = { ...results[1], ...invalid } as SaveResult; return results;
    } });
    await coordinator.activate('e0-a-workspace'); modify(coordinator, 'must survive malformed reply');
    assert.equal(await coordinator.save(), false); assert.equal(coordinator.active!.status, 'failed'); assert.equal(coordinator.isDirty(), true);
    assert.equal(coordinator.active!.bundle.workspace.draftRevision, 1); assert.equal(coordinator.active!.bundle.workspace.mapRevision, 1); assert.equal(coordinator.active!.bundle.draft.revision, 1); assert.equal(coordinator.active!.bundle.map.revision, 1); assert.equal(coordinator.active!.savedEdit, 0);
  }
});
test('load bundle runtime shape and requested workspace identity are checked before activation', async () => {
  const coordinator = new SaveCoordinator({ load: async () => createFixtureBundle('b'), saveAtomic: async requests => saved(requests) });
  await assert.rejects(coordinator.activate('e0-a-workspace'), /身份不匹配/); assert.equal(coordinator.active, null); assert.equal(coordinator.sessions.size, 0);
  const malformed = new SaveCoordinator({ load: async () => ({ ...createFixtureBundle(), map: {} }) as WorkspaceBundle, saveAtomic: async requests => saved(requests) });
  await assert.rejects(malformed.activate('e0-a-workspace')); assert.equal(malformed.active, null);
});
test('atomic peer failure before a later map conflict still presents conflict and preserves both durable baselines',async()=>{const coordinator=new SaveCoordinator({load:async()=>createFixtureBundle(),saveAtomic:async requests=>requests.map((request,index)=>{const identity={workspaceId:request.workspaceId,documentId:request.documentId,sessionId:request.sessionId,requestId:request.requestId};return index===1?{status:'conflict',...identity,actualRevision:request.expectedRevision+2}:{status:'failed',...identity,error:'同批文档版本冲突'};})});await coordinator.activate('e0-a-workspace');modify(coordinator,'must keep current edit');const before=clone(coordinator.active!.bundle.workspace);assert.equal(await coordinator.save(),false);assert.equal(coordinator.active!.status,'conflict');assert.match(coordinator.active!.error,/版本冲突/);assert.deepEqual(coordinator.active!.bundle.workspace,before);assert.equal(coordinator.active!.bundle.draft.blocks[0].runs[0].text,'must keep current edit');assert.equal(coordinator.isDirty(),true);});
