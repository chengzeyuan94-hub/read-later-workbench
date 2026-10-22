import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CollectionItem, CollectionSnapshot, ContentRecord, DetailResult, Platform, SourceAdapter } from '../src/shared/contracts.js';
import { WorkbenchService, homeSelections, safeError, isAuthenticationError } from '../src/main/service.js';
import { Store } from '../src/main/store.js';
import { mediaResponse } from '../src/main/media.js';

const NOW = Date.parse('2026-10-17T12:00:00+08:00');
const DAY = 86_400_000;
const item = (sourceId: string, folderIds = ['f1']): CollectionItem => ({ sourceId, title: `夹具 ${sourceId}`, author: 'Fixture', kind: 'image', url: `https://fixture.invalid/n/${sourceId}`, folderIds });
const snapshot = (platform: Platform, items: CollectionItem[], complete = true): CollectionSnapshot => ({ platform, accountId: 'fixture-account', accountName: '仅供夹具测试', folders: [{ id: 'f1', title: '一' }, { id: 'f2', title: '二' }], items, complete });
const detail: DetailResult = { body: '夹具正文；不计真实采集验收', bodyComplete: true, media: [{ remoteUrl: 'https://fixture.invalid/image', kind: 'image', mime: 'image/png' }] };
const fetchOK = async () => new Response(Buffer.from([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': '4' } });

async function fixture(adapters: SourceAdapter[], extra: Partial<ConstructorParameters<typeof WorkbenchService>[2]> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rlw-test-'));
  const service = new WorkbenchService(directory, adapters, { connections: () => [], fetch: fetchOK, now: () => NOW, ...extra });
  return { service, directory, cleanup: async () => { service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('first import uses a global 30 quota, transfers surplus, unions folders, records unimported baseline', async () => {
  let x = snapshot('xiaohongshu', Array.from({ length: 25 }, (_, n) => item(`x${n}`)));
  let b = snapshot('bilibili', [item('b1'), item('b1', ['f2']), item('b2')]);
  const f = await fixture([
    { platform: 'xiaohongshu', collect: async () => x, detail: async () => detail },
    { platform: 'bilibili', collect: async () => b, detail: async () => detail },
  ]);
  try {
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 27);
    assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length, 0);
    assert.ok(f.service.state().contents.every(c => c.discovery === 'historical' && c.offline));
    assert.deepEqual(f.service.state().contents.find(c => c.sourceId === 'b1')?.folderIds, ['f1', 'f2']);
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 27);
    assert.ok(f.service.state().syncs.slice(0, 2).every(s => s.saved === 0));
    // A separate larger account has IDs beyond the initial quota; they remain baseline-only.
    x = { ...x, accountId: 'second-account', items: Array.from({ length: 20 }, (_, n) => item(`z${n}`)) };
    await f.service.sync('xiaohongshu'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 30);
    await f.service.sync('xiaohongshu'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 30);
    assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length, 0);
  } finally { await f.cleanup(); }
});

test('B站existing complete account and folder baselines allow newly observed IDs into 48-hour list', async () => {
  let current = snapshot('bilibili', [item('old')], false);
  const f = await fixture([{ platform: 'bilibili', collect: async () => current, detail: async () => detail }]);
  try {
    await f.service.sync(); await f.service.waitForIdle();
    current = snapshot('bilibili', [item('uncertain'), item('old')], false);
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.find(c => c.sourceId === 'uncertain')?.discovery, 'unknown');
    assert.equal(f.service.state().syncs[0].state, 'partial');
    current = snapshot('bilibili', [item('uncertain'), item('old')], true);
    await f.service.sync(); await f.service.waitForIdle();
    current = { ...snapshot('bilibili', [item('real-new'), item('unknown-folder', ['f3']), item('old')]), folders: [{ id: 'f1', title: '一' }, { id: 'f3', title: '新增夹' }] };
    await f.service.sync(); await f.service.waitForIdle();
    assert.deepEqual(f.service.state().recent.filter(c => c.discovery === 'new').map(c => c.sourceId), ['real-new']);
    assert.equal(f.service.state().contents.find(c => c.sourceId === 'unknown-folder')?.discovery, 'unknown');
    assert.equal(f.service.state().contents.find(c => c.sourceId === 'old')?.discovery, 'historical');
  } finally { await f.cleanup(); }
});

test('historical surplus transfers across separate manual sync calls without reclassifying old baseline IDs', async () => {
  const x = snapshot('xiaohongshu', Array.from({ length: 5 }, (_, n) => item(`x${n}`)));
  const b = snapshot('bilibili', Array.from({ length: 40 }, (_, n) => item(`b${n}`)));
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => x, detail: async () => detail }, { platform: 'bilibili', collect: async () => b, detail: async () => detail }]);
  try {
    await f.service.sync('xiaohongshu'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 5);
    await f.service.sync('bilibili'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 30);
    assert.equal(f.service.state().contents.filter(c => c.platform === 'bilibili').length, 25);
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 30);
    assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length, 0);
  } finally { await f.cleanup(); }
  const second = await fixture([{ platform: 'xiaohongshu', collect: async () => ({ ...x, items: Array.from({ length: 40 }, (_, n) => item(`x${n}`)) }), detail: async () => detail }, { platform: 'bilibili', collect: async () => ({ ...b, items: [item('b1')] }), detail: async () => detail }]);
  try {
    await second.service.sync('xiaohongshu'); await second.service.waitForIdle();
    assert.equal(second.service.state().contents.length, 15);
    await second.service.sync('bilibili'); await second.service.waitForIdle();
    assert.equal(second.service.state().contents.length, 16);
    await second.service.sync('xiaohongshu'); await second.service.waitForIdle();
    assert.equal(second.service.state().contents.length, 30);
    assert.equal(second.service.state().recent.filter(c => c.discovery === 'new').length, 0);
    assert.ok(second.service.state().contents.every(c => c.discovery === 'historical'));
  } finally { await second.cleanup(); }
});

test('same-source manual sync calls coalesce, and offline/pause recovery performs one shared check', async () => {
  let calls = 0;
  let unblock!: () => void;
  let gate: Promise<void> | undefined = new Promise(resolve => { unblock = resolve; });
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => { calls++; await gate; return snapshot('xiaohongshu', [item('one')]); }, detail: async () => detail }]);
  try {
    const one = f.service.sync('xiaohongshu');
    const two = f.service.sync('xiaohongshu');
    const all = f.service.sync();
    assert.equal(calls, 1);
    unblock(); gate = undefined;
    await Promise.all([one, two, all]); await f.service.waitForIdle();
    assert.equal(calls, 1);
    f.service.setOnline(false); f.service.pause();
    await f.service.sync();
    assert.equal(calls, 1);
    f.service.setOnline(true); assert.equal(calls, 1);
    f.service.resume(); await f.service.waitForIdle();
    assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});

test('partial source lists never prove a shortage for historical quota transfer', async () => {
  let complete = false;
  const f = await fixture([
    { platform: 'xiaohongshu', collect: async () => ({ ...snapshot('xiaohongshu', [item('x1'), item('x2')], complete), warning: '仅滚动取得 2 条，数量上限；https://private.invalid/?token=SECRET token=SECRET' }), detail: async () => detail },
    { platform: 'bilibili', collect: async () => snapshot('bilibili', Array.from({ length: 40 }, (_, n) => item(`b${n}`))), detail: async () => detail },
  ]);
  try {
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 17);
    assert.equal(f.service.state().contents.filter(c => c.platform === 'bilibili').length, 15);
    const partial = f.service.state().syncs.find(s => s.platform === 'xiaohongshu')!;
    assert.match(partial.message, /数量上限/); assert.ok(!partial.message.includes('SECRET'));
    await f.service.sync('bilibili'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 17);
    complete = true;
    await f.service.sync('xiaohongshu'); await f.service.sync('bilibili'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 30);
    assert.equal(f.service.state().recent.filter(c => c.discovery === 'new').length, 0);
  } finally { await f.cleanup(); }
});

test('retry refreshes expired signed media URLs and replaces stale task without duplicating saved originals', async () => {
  let details = 0;
  const fetched: string[] = [];
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => snapshot('xiaohongshu', [item('signed')]), detail: async () => {
    details++;
    return { ...detail, media: [{ kind: 'image', remoteUrl: `https://fixture.invalid/image?signature=${details === 1 ? 'expired' : 'fresh'}` }] };
  } }], { fetch: async url => { fetched.push(url); if (url.includes('expired')) return new Response(null, { status: 403 }); return fetchOK(); } });
  try {
    await f.service.sync(); await f.service.waitForIdle();
    let saved = f.service.state().contents[0];
    const mediaId = saved.media[0].id;
    assert.equal(saved.bodyComplete, true); assert.equal(saved.media[0].state, 'failed');
    f.service.retry(saved.id); await f.service.waitForIdle();
    saved = f.service.state().contents[0];
    assert.equal(details, 2); assert.equal(saved.media.length, 1); assert.equal(saved.media[0].id, mediaId);
    assert.equal(saved.offline, true); assert.ok(fetched[1].includes('fresh'));
    // Refreshing an already saved object keeps its original local media and ID.
    f.service.retry(saved.id); await f.service.waitForIdle();
    assert.equal(f.service.state().contents[0].media.length, 1);
    assert.equal(fetched.length, 2);
  } finally { await f.cleanup(); }
});

test('detail interrupted by offline state returns to queue and resumes without manual retry', async () => {
  let attempts = 0;
  let reject!: (error: Error) => void;
  const gate = new Promise<DetailResult>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => snapshot('xiaohongshu', [item('interrupted')]), detail: async () => { attempts++; return attempts === 1 ? gate : detail; } }]);
  try {
    f.service.autoSync(false);
    await f.service.sync();
    assert.equal(f.service.state().contents[0].detailState, 'running');
    f.service.setOnline(false); reject(new Error('Network offline during body request'));
    await f.service.waitForIdle();
    assert.equal(f.service.state().contents[0].detailState, 'queued');
    assert.equal(f.service.state().contents[0].detailError, null);
    f.service.setOnline(true); await f.service.waitForIdle();
    assert.equal(attempts, 2);
    assert.equal(f.service.state().contents[0].offline, true);
  } finally { await f.cleanup(); }
});

test('metadata persists before detail, partial download failure is retryable, digest/review persist after restart', async () => {
  let rejectDownload = true;
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  const adapters: SourceAdapter[] = [{ platform: 'bilibili', collect: async () => snapshot('bilibili', [{ ...item('v1'), kind: 'video' }]), detail: async () => { await detailGate; return { ...detail, media: [{ remoteUrl: 'https://fixture.invalid/video', kind: 'video' }] }; } }];
  const f = await fixture(adapters, { fetch: async () => { if (rejectDownload) throw new Error('Network failure https://secret.invalid/?token=DO_NOT_PERSIST'); return new Response(Buffer.from('fixture-video'), { headers: { 'Content-Type': 'video/mp4' } }); } });
  try {
    await f.service.sync();
    const content = f.service.state().contents[0];
    assert.equal(content.title, '夹具 v1');
    assert.equal(content.offline, false);
    assert.ok(['queued', 'running'].includes(content.detailState));
    releaseDetail(); await f.service.waitForIdle();
    let saved = f.service.state().contents[0];
    assert.equal(saved.detailState, 'succeeded');
    assert.equal(saved.media[0].state, 'failed');
    assert.equal(saved.offline, false);
    assert.ok(!JSON.stringify(saved).includes('DO_NOT_PERSIST'));
    rejectDownload = false;
    f.service.retry(saved.id); await f.service.waitForIdle();
    saved = f.service.state().contents[0];
    assert.equal(saved.offline, true);
    assert.equal(await readFile(path.join(f.directory, 'media', saved.media[0].localPath!), 'utf8'), 'fixture-video');
    assert.equal((await readdir(path.join(f.directory, 'media'))).filter(n => n.endsWith('.part')).length, 0);
    // Seed a historical pre-pipeline mark; this is migration data, not a new request.
    f.service.store.digest(saved.id, true, NOW); f.service.review(saved.id);
    f.service.close();
    const restarted = new WorkbenchService(f.directory, adapters, { editorEnabled: true, connections: () => [], now: () => NOW, fetch: async () => { throw new Error('Network explicitly blocked'); } });
    restarted.setOnline(false);
    try {
      const persisted = restarted.state().contents[0];
      assert.equal(persisted.digestedAt, NOW);
      assert.equal(persisted.lastReviewedAt, NOW);
      assert.equal(persisted.offline, true);
      assert.equal(restarted.state().reviews.length, 1);
      const response = await mediaResponse(new Request('rlw-media://local/1'), path.join(f.directory, 'media'), persisted.media[0]);
      assert.equal(await response.text(), 'fixture-video');
      restarted.digest(persisted.id, false);
      assert.equal(restarted.state().contents[0].digestedAt, NOW, 'removing library membership preserves historical time');
      assert.equal(restarted.state().digestStates![0].library!.active, false);
      assert.equal(restarted.state().digestStates![0].request, null, 'migration and removal do not authorize engines');
      assert.equal(restarted.state().reviews.length, 0);
    } finally { restarted.close(); }
  } finally { await f.cleanup(); }
});

test('restart recovers running detail/download tasks and marks interrupted sync honestly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-recovery-'));
  const initial = new Store(dir);
  initial.saveSnapshot(snapshot('xiaohongshu', [item('a'), item('b')]), [{ item: item('a'), discovery: 'historical' }, { item: item('b'), discovery: 'historical' }], NOW);
  const [a, b] = initial.contents();
  initial.detailSaved(a.id, detail); initial.detailRunning(b.id);
  const media = initial.nextDownload()!;
  initial.downloadRunning(media.id); initial.startSync('xiaohongshu', NOW);
  await writeFile(path.join(dir, 'media', `${media.id}.part`), 'half');
  initial.close();
  const service = new WorkbenchService(dir, [{ platform: 'xiaohongshu', collect: async () => snapshot('xiaohongshu', []), detail: async () => detail }], { connections: () => [], fetch: fetchOK, now: () => NOW });
  try {
    await service.waitForIdle();
    assert.ok(service.state().contents.every(c => c.offline));
    assert.equal(service.state().syncs[0].state, 'failed');
    assert.match(service.state().syncs[0].message, /中断/);
    assert.equal((await readdir(path.join(dir, 'media'))).some(n => n.endsWith('.part')), false);
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('home uses first discovery, enforces the 7-day window and caps and review order', () => {
  const base = { ...item('x'), id: 1, platform: 'xiaohongshu', accountId: 'fixture', firstDiscoveredAt: NOW, discovery: 'new', body: '', bodyComplete: true, subtitle: '', detailState: 'succeeded', detailError: null, digestedAt: null, lastReviewedAt: null, offline: false, media: [] } as ContentRecord;
  const list: ContentRecord[] = Array.from({ length: 8 }, (_, n) => ({ ...base, id: n + 1, firstDiscoveredAt: NOW - n * 1000, publishedAt: NOW - 400 * DAY }));
  list.push({ ...base, id: 20, firstDiscoveredAt: NOW - 2 * DAY - 1 }, { ...base, id: 21, discovery: 'historical' }, { ...base, id: 22, discovery: 'unknown' }, { ...base, id: 23, firstDiscoveredAt: NOW + 1 }, { ...base, id: 24, firstDiscoveredAt: NOW - 8 * DAY });
  const home = homeSelections(list, NOW);
  // E4.4 §3.4: recent covers every undigested item discovered in the last 7 days,
  // labelled by discovery rather than restricted to confirmed new.
  assert.deepEqual(home.recent.map(c => c.id), [22, 21, 1, 2, 3, 4, 5, 6, 7, 8, 20]);
  const digested = Array.from({ length: 25 }, (_, n) => ({ ...base, id: n + 30, digestedAt: NOW - DAY, lastReviewedAt: n === 0 ? null : NOW - n * 1000 }));
  digested.push({ ...base, id: 100, digestedAt: NOW - 14 * DAY - 1 });
  const reviews = homeSelections(digested, NOW).reviews;
  assert.equal(reviews.length, 20); assert.equal(reviews[0].id, 30); assert.equal(reviews[1].id, 54);
  assert.equal(homeSelections([], NOW).recent.length, 0);
});

test('local media supports seeking/head and rejects traversal, symlink escapes, malformed ranges', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-media-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'rlw-outside-'));
  await writeFile(path.join(dir, 'video.mp4'), '0123456789');
  await writeFile(path.join(outside, 'private'), 'outside');
  await symlink(path.join(outside, 'private'), path.join(dir, 'escape'));
  const record = { id: 1, contentId: 1, kind: 'video', state: 'succeeded', localPath: 'video.mp4', mime: 'video/mp4', error: null, bytes: 10 } as const;
  const req = (range?: string, method = 'GET') => new Request('rlw-media://local/1', { method, headers: range ? { Range: range } : undefined });
  try {
    let response = await mediaResponse(req('bytes=2-5'), dir, record);
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await response.text(), '2345');
    response = await mediaResponse(req('bytes=-3'), dir, record); assert.equal(await response.text(), '789');
    response = await mediaResponse(req(undefined, 'HEAD'), dir, record); assert.equal(response.headers.get('content-length'), '10'); assert.equal(await response.text(), '');
    for (const range of ['bytes=10-', 'bytes=3-2', 'bytes=0-1,3-4', 'bytes=-0', 'garbage']) assert.equal((await mediaResponse(req(range), dir, record)).status, 416);
    assert.equal((await mediaResponse(req(), dir, { ...record, localPath: '../private' })).status, 403);
    assert.equal((await mediaResponse(req(), dir, { ...record, localPath: 'escape' })).status, 403);
    assert.equal((await mediaResponse(req(), dir, { ...record, state: 'failed' })).status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('login failure is explicit and errors never copy credential-bearing input', async () => {
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => { throw new Error('HTTP 401 https://site.invalid/?token=secret Cookie=private'); }, detail: async () => detail }]);
  try {
    await f.service.sync();
    assert.equal(f.service.state().syncs[0].state, 'failed');
    assert.match(f.service.state().syncs[0].message, /重新登录/);
    assert.ok(!JSON.stringify(f.service.state()).includes('secret'));
    assert.match(safeError(new Error('HTTP 429 secret')), /限流/);
  } finally { await f.cleanup(); }
});

test('unconnected peer retains its historical quota until a complete baseline confirms shortage', async () => {
  const f = await fixture([{ platform: 'bilibili', collect: async () => snapshot('bilibili', Array.from({ length: 40 }, (_, n) => item(`b${n}`))), detail: async () => detail }], { connections: () => [{ platform: 'xiaohongshu', state: 'disconnected', method: 'fixture', message: '尚未连接' }, { platform: 'bilibili', state: 'connected', method: 'fixture', message: '已连接' }] });
  try {
    await f.service.sync('bilibili'); await f.service.waitForIdle();
    assert.equal(f.service.state().contents.length, 15);
    assert.equal(f.service.state().contents.filter(c => c.platform === 'bilibili').length, 15);
  } finally { await f.cleanup(); }
});

test('ordinary detail failure and expired media URL never turn a connected account into expired', async () => {
  const f = await fixture([{ platform: 'bilibili', collect: async () => snapshot('bilibili', [item('invalid')]), detail: async () => { throw new Error('B站内容失效或未提供视频标识，已保留本地收藏'); } }], { connections: () => [{ platform: 'bilibili', state: 'connected', method: 'fixture', message: '账号已连接' }] });
  try {
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().connections[0].state, 'connected');
    assert.match(f.service.state().contents[0].detailError!, /内容失效/);
    assert.equal(f.service.state().syncs[0].state, 'succeeded');
    assert.equal(isAuthenticationError(new Error('普通错误，请检查平台登录状态')), false);
    assert.equal(isAuthenticationError(new Error('HTTP 403 signed URL expired')), false);
    assert.equal(isAuthenticationError(new Error('LOGIN_REQUIRED：未登录')), true);
    assert.equal(isAuthenticationError(new Error('HTTP 401')), true);
    assert.equal(isAuthenticationError({ code: -101 }), true);
    assert.match(safeError(new Error('HTTP 403 signed URL expired')), /资源地址已过期/);
  } finally { await f.cleanup(); }
});

test('detail and media alternate so a first saved image precedes the next slow detail while all metadata is durable', async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  let enteredSlow!: () => void;
  const slowStarted = new Promise<void>(resolve => { enteredSlow = resolve; });
  const events: string[] = [];
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => snapshot('xiaohongshu', [item('first'), item('slow-second')]), detail: async content => {
    events.push(`detail:${content.sourceId}`);
    if (content.sourceId === 'slow-second') { enteredSlow(); await slow; }
    return { ...detail, media: [{ kind: 'image', remoteUrl: `https://fixture.invalid/${content.sourceId}.png` }] };
  } }], { fetch: async url => { events.push(`download:${new URL(url).pathname}`); return fetchOK(); } });
  try {
    await f.service.sync();
    await slowStarted;
    assert.equal(f.service.state().contents.length, 2);
    assert.equal(f.service.state().contents.find(c => c.sourceId === 'first')?.offline, true);
    assert.deepEqual(events.slice(0, 3), ['detail:first', 'download:/first.png', 'detail:slow-second']);
    releaseSlow(); await f.service.waitForIdle();
    assert.ok(f.service.state().contents.every(c => c.offline));
  } finally { releaseSlow(); await f.cleanup(); }
});

test('idle timeout covers stalled headers and bodies, fails only that task, then continues the queue', async () => {
  for (const phase of ['headers', 'body']) {
    const f = await fixture([{ platform: 'bilibili', collect: async () => snapshot('bilibili', [item('stall')]), detail: async () => ({ ...detail, media: [{ kind: 'image', remoteUrl: 'https://fixture.invalid/stall' }, { kind: 'image', remoteUrl: 'https://fixture.invalid/next' }] }) }], {
      downloadIdleMs: 20,
      connections: () => [{ platform: 'bilibili', state: 'connected', method: 'fixture', message: '已连接' }],
      fetch: async url => {
        if (url.endsWith('/next')) return fetchOK();
        if (phase === 'headers') return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); } }), { headers: { 'Content-Type': 'image/png' } });
      },
    });
    try {
      await f.service.sync(); await f.service.waitForIdle();
      const saved = f.service.state().contents[0];
      assert.equal(saved.media[0].state, 'failed', phase);
      assert.match(saved.media[0].error!, /等待数据超时/);
      assert.equal(saved.media[1].state, 'succeeded', phase);
      assert.equal(f.service.state().connections[0].state, 'connected');
      assert.equal((await readdir(path.join(f.directory, 'media'))).some(name => name.endsWith('.part')), false);
    } finally { await f.cleanup(); }
  }
});

test('active slow downloads reset idle timeout per chunk instead of imposing a total video duration limit', async () => {
  const f = await fixture([{ platform: 'bilibili', collect: async () => snapshot('bilibili', [item('active')]), detail: async () => detail }], {
    downloadIdleMs: 40,
    fetch: async () => {
      let chunks = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 12));
          controller.enqueue(new Uint8Array([++chunks]));
          if (chunks === 6) controller.close();
        },
      }), { headers: { 'Content-Type': 'image/png' } });
    },
  });
  try {
    await f.service.sync(); await f.service.waitForIdle();
    assert.equal(f.service.state().contents[0].media[0].state, 'succeeded');
    assert.equal(f.service.state().contents[0].media[0].bytes, 6);
    assert.equal(f.service.state().contents[0].offline, true);
  } finally { await f.cleanup(); }
});

test('explicit retry waits for active download, then prioritizes its refreshed detail and media before ordinary queue', async () => {
  let releaseActive!: () => void;
  const activeGate = new Promise<void>(resolve => { releaseActive = resolve; });
  let enteredActive!: () => void;
  const activeStarted = new Promise<void>(resolve => { enteredActive = resolve; });
  const events: string[] = [];
  const f = await fixture([{ platform: 'xiaohongshu', collect: async () => snapshot('xiaohongshu', []), detail: async content => {
    events.push(`detail:${content.sourceId}`);
    return { ...detail, media: [{ kind: 'image', remoteUrl: 'https://fixture.invalid/target-fresh' }] };
  } }], { fetch: async url => {
    const resource = new URL(url).pathname.slice(1);
    events.push(`download:${resource}`);
    if (resource === 'blocker') { enteredActive(); await activeGate; }
    return fetchOK();
  } });
  try {
    f.service.autoSync(false); f.service.pause();
    const items = [item('blocker'), item('ordinary'), item('target')];
    f.service.store.saveSnapshot(snapshot('xiaohongshu', items), items.map(item => ({ item, discovery: 'historical' })), NOW);
    for (const input of items) {
      const id = f.service.store.find('xiaohongshu', 'fixture-account', input.sourceId)!;
      f.service.store.detailSaved(id, { ...detail, media: [{ kind: 'image', remoteUrl: `https://fixture.invalid/${input.sourceId}` }] });
      if (input.sourceId === 'target') f.service.store.downloadFailed(f.service.store.content(id)!.media[0].id, '夹具旧地址失败');
    }
    const target = f.service.state().contents.find(c => c.sourceId === 'target')!;
    f.service.resume(); await activeStarted;
    f.service.retry(target.id);
    assert.deepEqual(events, ['download:blocker']);
    releaseActive(); await f.service.waitForIdle();
    assert.deepEqual(events, ['download:blocker', 'detail:target', 'download:target-fresh', 'download:ordinary']);
    assert.ok(f.service.state().contents.every(c => c.offline));
  } finally { releaseActive(); await f.cleanup(); }
});
