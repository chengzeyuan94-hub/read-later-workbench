import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { DigestRepository, migrateE44Schema } from '../src/main/digest-store.js';
import { AsrRepository, migrateAsrSchema } from '../src/main/asr-store.js';
import { AsrRunner } from '../src/main/asr-runner.js';
import { ASR_PROVIDER_CONFIG } from '../src/main/asr-provider.js';
import { GenerationRepository, migrateGenerationSchema } from '../src/main/generation-store.js';
import { BatchDigestCoordinator, type BatchDigestDependencies } from '../src/main/batch-digest.js';
import { processingUsage } from '../src/main/processing-usage.js';
import { shanghaiMonthStart, shanghaiDayStart } from '../src/shared/shanghai-time.js';
import { buildQueueRows, queueBlockReason, digestActiveCount, digestQueueSummary, elapsedText, asrProgressText } from '../src/renderer/digest-queue.js';
import type { DigestContentState } from '../src/shared/digest-contracts.js';
import type { BatchDigestState } from '../src/shared/batch-contracts.js';
import { sha256 } from '../src/main/editor-media.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15 20:00 Asia/Shanghai

function usageDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE asr_calls(run_id TEXT PRIMARY KEY,chunk_id TEXT,submitted INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL);
    CREATE TABLE asr_chunks(id TEXT PRIMARY KEY,prepared_json TEXT NOT NULL);
    CREATE TABLE generation_calls(run_id TEXT PRIMARY KEY,submitted INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL);
    CREATE TABLE batch_digest_submissions(run_id TEXT PRIMARY KEY,request_id TEXT,kind TEXT,duration_ms REAL,submitted_at INTEGER);`);
  return db;
}

test('usage aggregates submitted calls only, split at the Asia/Shanghai month boundary', () => {
  const db = usageDb();
  try {
    const start = shanghaiMonthStart(NOW);
    assert.equal(start, Date.UTC(2026, 8, 30, 16, 0, 0)); // 10/01 00:00 +08:00
    const chunk = (id: string, ms: number) => db.prepare('INSERT INTO asr_chunks VALUES(?,?)').run(id, JSON.stringify({ durationMs: ms }));
    chunk('c-old', 60_000); chunk('c-new-a', 90_000); chunk('c-new-b', 30_000); chunk('c-unsub', 7_200_000);
    const call = db.prepare('INSERT INTO asr_calls VALUES(?,?,?,?)');
    call.run('a-old', 'c-old', 1, start - 60_000);          // September → total only
    call.run('a-new-a', 'c-new-a', 1, start + 60_000);
    call.run('a-new-b', 'c-new-b', 1, NOW - 60_000);
    call.run('a-unsub', 'c-unsub', 0, NOW - 60_000);         // never submitted → free
    const gen = db.prepare('INSERT INTO generation_calls VALUES(?,?,?)');
    gen.run('g-old', 1, start - 3_600_000); gen.run('g-a', 1, NOW - 1000); gen.run('g-b', 1, NOW - 500); gen.run('g-unsub', 0, NOW);
    // Reservation rows must not double count real calls.
    db.prepare('INSERT INTO batch_digest_submissions VALUES(?,?,?,?,?)').run('a-new-a', 'req', 'asr', 90_000, start + 60_000);
    const usage = processingUsage(db, NOW);
    assert.deepEqual(usage.total, { asrMinutes: 3, asrCount: 3, generationCount: 3 });
    assert.deepEqual(usage.month, { asrMinutes: 2, asrCount: 2, generationCount: 2 });
  } finally { db.close(); }
});

test('shanghai day and month boundaries land on +08:00 midnight', () => {
  const day = shanghaiDayStart(NOW), month = shanghaiMonthStart(NOW);
  assert.equal(new Date(day).toISOString(), '2026-10-14T16:00:00.000Z');
  assert.equal(new Date(month).toISOString(), '2026-09-30T16:00:00.000Z');
});

function fixture() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'e413-')), store = new Store(root);
  const items = [{ sourceId: 'e413-video', title: '合成视频收藏', author: 't', url: 'https://www.xiaohongshu.com/explore/e413-video', kind: 'text' as const, folderIds: [] }];
  store.saveSnapshot({ platform: 'xiaohongshu', accountId: 'acc', accountName: '合成', folders: [], complete: true, items }, items.map(item => ({ item, discovery: 'historical' as const })), 1);
  const id = store.find('xiaohongshu', 'acc', 'e413-video')!;
  migrateEditorSchema(store.db, root, { targetVersion: 7 }); const editor = new EditorRepository(store.db, root);
  migrateAsrSchema(store.db, root); const digest = new DigestRepository(store.db, root, editor);
  migrateGenerationSchema(store.db, root); migrateE44Schema(store.db, root);
  const generation = new GenerationRepository(store.db, root, editor, digest);
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const deps: BatchDigestDependencies = {
    getContent: cid => store.content(cid), statusDigest: cid => digest.status(cid),
    requestDigest: (cid, renew) => { digest.request(cid, renew); generation.authorize(cid); return digest.status(cid); },
    retryDigest: cid => { try { digest.retry(cid); if (generation.status(cid).authorized) generation.retry(cid); } catch (error) { console.log('retryDigest failed:', error); throw error; } },
    cancelDigest: cid => { generation.cancel(cid); digest.cancel(cid); },
    kickRunners: () => {}, evidence: (event, fields) => events.push({ event, fields }),
  };
  return { root, store, id, digest, generation, deps, events, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('E4.13 one-shot clears batch-budget blocks once, retries the failed item, and resumes the queue', () => {
  const f = fixture();
  try {
    f.store.detailSaved(f.id, { body: '正文', bodyComplete: true, mediaManifestComplete: true, media: [] });
    const first = new BatchDigestCoordinator(f.store.db, f.deps);
    const run = first.create([f.id]);
    const requestId = run.items[0].requestId!;
    assert.ok(requestId, 'ready content must create a request');
    assert.equal(f.events.length, 1); // first boot already ran the one-shot with nothing to clear
    assert.equal(f.events[0].event, 'batch-budget-unblocked');
    // Simulate a legacy database: old failure row, a request failed by batch-budget.
    f.store.db.prepare("DELETE FROM settings WHERE key='e413BudgetUnblock'").run();
    f.store.db.prepare("INSERT INTO batch_digest_failures VALUES('generation','batch-budget',0,1)").run();
    f.store.db.prepare("UPDATE generation_requests SET state='failed',error_json=? WHERE request_id=?").run(JSON.stringify({ code: 'batch-budget', message: 'budget' }), requestId);
    f.store.db.prepare("UPDATE digest_stages SET state='failed',error='生成失败' WHERE request_id=? AND name='organize'").run(requestId);
    f.store.db.prepare("UPDATE digest_requests SET state='failed' WHERE id=?").run(requestId);
    f.store.db.prepare("UPDATE batch_digest_items SET state='failed',reason='额度用尽' WHERE batch_id=? AND content_id=?").run(run.id, f.id);
    const again = new BatchDigestCoordinator(f.store.db, f.deps);
    again.tick();
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM batch_digest_failures WHERE code='batch-budget'").get() as any).n, 0);
    const flag = f.store.db.prepare("SELECT value FROM settings WHERE key='e413BudgetUnblock'").get() as any;
    assert.equal(flag?.value, 'done');
    assert.equal(f.events.length, 2);
    assert.equal(f.events[1].event, 'batch-budget-unblocked');
    assert.deepEqual(f.events[1].fields, { cleared: 1, retried: 1 });
    const item = again.status(run.id).items[0];
    assert.notEqual(item.state, 'failed');
    assert.notEqual(f.digest.status(f.id).request?.state, 'failed');
    const before = f.events.length;
    again.tick(); again.tick();
    assert.equal(f.events.length, before, 'one-shot must not refire');
  } finally { f.close(); }
});

test('E4.13 ASR minutes and chunk progress persist on the digest stage', async () => {
  const f = fixture();
  try {
    f.store.db.prepare("UPDATE contents SET kind='video' WHERE id=?").run(f.id);
    f.store.detailSaved(f.id, { body: '视频简介', bodyComplete: true, mediaManifestComplete: true, media: [{ kind: 'video', remoteUrl: 'https://example.invalid/v', mime: 'video/mp4', resourceKey: 'video:1', title: 'P1' }] });
    const media = f.store.content(f.id)!.media[0], bytes = Buffer.from('synthetic video');
    writeFileSync(path.join(f.root, 'media', 'v.mp4'), bytes);
    f.store.downloadSaved(media.id, 'v.mp4', bytes.length, media.mime);
    const asr = new AsrRepository(f.store.db, f.root, f.digest, ASR_PROVIDER_CONFIG);
    const realRequest = f.deps.requestDigest;
    f.deps.requestDigest = (cid, renew) => { const value = realRequest(cid, renew); asr.authorize(cid, { preparationConfig: { version: 'synthetic-pcm' } }); return value; };
    const batch = new BatchDigestCoordinator(f.store.db, f.deps);
    batch.create([f.id]);
    const runner = new AsrRunner(asr, {
      async probe(input) { return { sha256: input.expectedSha256, bytes: input.expectedBytes, durationMs: 90_000 }; },
      async prepare(input) {
        return [0, 1].map(order => {
          const body = Buffer.from(`pcm-${order}`), localPath = path.join(input.outputDir, `part-${order}.wav`);
          writeFileSync(localPath, body);
          return { localPath, sha256: sha256(body), bytes: body.length, format: 'wav', order, startMs: order * 45_000, endMs: (order + 1) * 45_000, durationMs: 45_000, configSha256: 'a'.repeat(64) };
        });
      },
    }, { configured: () => true, async transcribe(input) { await input.onUploadStart(); return { text: '合成转录文字', rawResponse: { text: '合成转录文字' } }; } }, ASR_PROVIDER_CONFIG, { networkAllowed: true, batch: batch.hooks('asr') });
    try {
      runner.start();
      const end = Date.now() + 2500;
      let stage: ReturnType<typeof f.digest.status>['stages'][number] | undefined;
      while (Date.now() < end) {
        stage = f.digest.status(f.id).stages.find(s => s.name === 'asr');
        if (stage?.state === 'succeeded') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(stage?.state, 'succeeded');
      assert.deepEqual(stage?.transcription, { doneMs: 90_000, totalMs: 90_000, doneChunks: 2, totalChunks: 2 });
      // The same persisted shape feeds the queue label.
      assert.equal(asrProgressText(stage!.transcription!), '已转 1.5 / 1.5 分钟 · 第 2/2 段');
    } finally { runner.stop(); }
  } finally { f.close(); }
});

const stage = (name: string, state: string, extra: Record<string, unknown> = {}) => ({ name, label: name, state, required: true, attempts: 0, ...extra }) as any;
const digestState = (contentId: number, requestState: string, stages: any[] = [], completedAt: number | null = null): DigestContentState => ({
  contentId,
  request: { id: `req-${contentId}`, contentId, state: requestState as any, generation: 1, requestedAt: NOW - 60_000, updatedAt: NOW - 30_000, completedAt, inputScope: {} as any, targetVersion: null, sourceUpdated: false, synthetic: false, candidate: false },
  stages, library: null, readiness: { ready: false, reasons: [] }, capabilities: { ocr: true, asr: true, organize: true, map: true, markdown: true },
});

test('queue rows cover a single non-batch request and map stage/progress/elapsed', () => {
  const digests = [digestState(7, 'extracting', [stage('asr', 'running', { transcription: { doneMs: 750_000, totalMs: 2_400_000, doneChunks: 3, totalChunks: 8 } })])];
  const rows = buildQueueRows(digests, [], { asrConfigured: true, asrNetworkAllowed: true }, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contentId, 7);
  assert.equal(rows[0].stage, '转录');
  assert.equal(rows[0].progress, '已转 12.5 / 40.0 分钟 · 第 3/8 段');
  assert.equal(rows[0].kind, 'active');
  assert.equal(digestActiveCount(digests), 1); // single non-batch request shows the chip
});

test('queueBlockReason maps every documented waiting state to a concrete reason and fix', () => {
  const cfg = { asrConfigured: true, asrNetworkAllowed: true };
  assert.deepEqual(queueBlockReason({ itemState: 'waiting-download', itemReason: '正文未完整取得', config: cfg, online: true }), { reason: '正文未完整取得', fix: 'open' });
  assert.deepEqual(queueBlockReason({ stageName: 'asr', stageState: 'waiting-configuration', config: cfg, online: true }), { reason: '缺少转录密钥', fix: 'settings-asr' });
  assert.deepEqual(queueBlockReason({ stageName: 'organize', stageState: 'waiting-configuration', config: cfg, online: true }), { reason: '缺少整理密钥', fix: 'settings-generation' });
  assert.deepEqual(queueBlockReason({ stageName: 'asr', stageState: 'waiting-network', config: { ...cfg, asrNetworkAllowed: false }, online: true }), { reason: 'AI 处理未开启', fix: 'enable-network' });
  assert.deepEqual(queueBlockReason({ stageName: 'asr', stageState: 'waiting-network', config: cfg, online: false }), { reason: '当前离线，联网后继续', fix: null });
  assert.deepEqual(queueBlockReason({ itemReason: '平台冷却中，20:30 自动继续', config: cfg, online: true }), { reason: '平台冷却中，20:30 自动继续', fix: null });
  assert.deepEqual(queueBlockReason({ requestState: 'failed', itemReason: '转录服务限流', config: cfg, online: true }), { reason: '失败：转录服务限流', fix: 'retry' });
  assert.equal(queueBlockReason({ requestState: 'extracting', config: cfg, online: true }), null);
});

test('queue rows merge batch items and digest states without duplicates; summary counts today', () => {
  const batches: BatchDigestState[] = [{
    id: 'b1', state: 'running', createdAt: NOW - 60_000, updatedAt: NOW - 10_000,
    items: [
      { contentId: 1, title: '下载中', platform: 'x', requestId: null, state: 'waiting-download', reason: '等待本地媒体完整保存', retryCount: 0, selectedAt: NOW - 50_000, startedAt: null, finishedAt: null, stages: [] },
      { contentId: 2, title: '转录中', platform: 'x', requestId: 'req-2', state: 'processing', retryCount: 0, selectedAt: NOW - 40_000, startedAt: NOW - 30_000, finishedAt: null, stages: [stage('asr', 'running', { transcription: { doneMs: 60_000, totalMs: 120_000, doneChunks: 1, totalChunks: 2 } })] },
      { contentId: 3, title: '已完成', platform: 'x', requestId: 'req-3', state: 'complete', retryCount: 0, selectedAt: NOW, startedAt: NOW, finishedAt: NOW, stages: [] },
    ],
    budget: { asrMinutes: 2, asrPosts: 1, generationPosts: 0 },
    counts: { 'waiting-download': 1, queued: 0, processing: 1, complete: 1, candidate: 0, failed: 0, 'result-unknown': 0, cancelled: 0 },
  }];
  const digests = [
    digestState(2, 'extracting'),
    digestState(9, 'waiting-network'),                     // single request, not in any batch
    digestState(3, 'complete', [], NOW - 60_000),          // done today, excluded from rows
  ];
  const rows = buildQueueRows(digests, batches, { asrConfigured: true, asrNetworkAllowed: true }, true);
  assert.deepEqual(rows.map(row => row.contentId).sort(), [1, 2, 9]);
  assert.equal(rows.find(row => row.contentId === 1)?.stage, '下载');
  assert.equal(rows.find(row => row.contentId === 1)?.fix, 'open');
  const summary = digestQueueSummary(rows, digests, NOW);
  assert.deepEqual(summary, { transcribing: 1, waiting: 2, doneToday: 1 });
  assert.equal(elapsedText(NOW - 5 * 60_000, NOW), '此阶段已 5 分钟');
});
