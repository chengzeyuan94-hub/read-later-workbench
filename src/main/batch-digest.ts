import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ContentRecord } from '../shared/contracts.js';
import type { DigestContentState } from '../shared/digest-contracts.js';
import type { BatchBudget, BatchDigestItem, BatchDigestState, BatchItemState, BatchProcessingKind, BatchRunnerHooks } from '../shared/batch-contracts.js';

type Row = Record<string, any>;
const MAX_ITEMS = 35;
const TERMINAL_ITEM_STATES = ['complete', 'candidate', 'failed', 'result-unknown', 'cancelled'];
export interface BatchDigestDependencies {
  getContent(contentId: number): ContentRecord | undefined;
  statusDigest(contentId: number): DigestContentState;
  /** Use the same complete request/authorization path as the product's button. */
  requestDigest(contentId: number, renewScope: boolean): DigestContentState;
  retryDigest(contentId: number): void;
  cancelDigest(contentId: number): void;
  kickRunners(): void;
  /** Optional evidence sink for the one-shot budget unblock. */
  evidence?(event: string, fields: Record<string, unknown>): void;
}
export class BatchDispatchError extends Error {
  readonly submitted = false;
  constructor(readonly code: 'batch-paused' | 'batch-unauthorized') { super(code); }
}

/** A coordinator owns batch scheduling only. E4.13 removed the experiment
 * budget caps and the lifetime item cap: submissions are recorded for usage
 * reporting, never enforced. The 1–35 sanity bound applies per create call. */
export class BatchDigestCoordinator {
  private ticking = false;
  /** Pending one-shot until the next tick: settings flag e413BudgetUnblock. */
  private unblockPending: boolean;
  constructor(readonly db: Database.Database, readonly dependencies: BatchDigestDependencies) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_digest_runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_digest_items(batch_id TEXT NOT NULL REFERENCES batch_digest_runs(id),content_id INTEGER NOT NULL,identity_json TEXT NOT NULL,title TEXT NOT NULL,platform TEXT NOT NULL,request_id TEXT UNIQUE,state TEXT NOT NULL,reason TEXT,retry_count INTEGER NOT NULL DEFAULT 0,selected_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,PRIMARY KEY(batch_id,content_id));
      CREATE TABLE IF NOT EXISTS batch_digest_submissions(run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,kind TEXT NOT NULL,duration_ms REAL NOT NULL,submitted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_digest_failures(kind TEXT PRIMARY KEY,code TEXT NOT NULL,count INTEGER NOT NULL,blocked INTEGER NOT NULL DEFAULT 0);
    `);
    // E4.13: pre-existing tables kept content_id UNIQUE, which made a terminal
    // item block any later batch for the same collection forever. Rebuild once.
    const ddl = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='batch_digest_items'").get() as Row | undefined;
    if (ddl && /content_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(String(ddl.sql))) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE batch_digest_items_v2(batch_id TEXT NOT NULL REFERENCES batch_digest_runs(id),content_id INTEGER NOT NULL,identity_json TEXT NOT NULL,title TEXT NOT NULL,platform TEXT NOT NULL,request_id TEXT UNIQUE,state TEXT NOT NULL,reason TEXT,retry_count INTEGER NOT NULL DEFAULT 0,selected_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,PRIMARY KEY(batch_id,content_id));
          INSERT INTO batch_digest_items_v2 SELECT * FROM batch_digest_items;
          DROP TABLE batch_digest_items;
          ALTER TABLE batch_digest_items_v2 RENAME TO batch_digest_items;
        `);
      })();
    }
    const hasSettings = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    this.unblockPending = hasSettings && (this.db.prepare("SELECT value FROM settings WHERE key='e413BudgetUnblock'").get() as Row | undefined)?.value !== 'done';
    // A restart restores progress but does not silently authorize more paid I/O.
    // E4.16: digests the user already started continue after a restart. Runs the
    // old build paused only because of a restart resume; manual pauses stay paused.
    db.prepare("UPDATE batch_digest_runs SET state='running',reason=NULL,updated_at=? WHERE state='paused' AND reason='应用已重启，已完成成果保留；继续后处理剩余任务'").run(Date.now());
  }
  private run(id: string): Row { const row = this.db.prepare('SELECT * FROM batch_digest_runs WHERE id=?').get(id) as Row | undefined; if (!row) throw Error('批次不存在'); return row; }
  private item(batchId: string, contentId: number): Row { const row = this.db.prepare('SELECT * FROM batch_digest_items WHERE batch_id=? AND content_id=?').get(batchId, contentId) as Row | undefined; if (!row) throw Error('收藏不属于本批次'); return row; }
  private identity(content: ContentRecord): string { return JSON.stringify([content.platform, content.accountId, content.sourceId]); }
  private owns(requestId: string): Row | undefined { return this.db.prepare('SELECT i.*,b.state batch_state FROM batch_digest_items i JOIN batch_digest_runs b ON b.id=i.batch_id WHERE i.request_id=?').get(requestId) as Row | undefined; }
  /** Usage charged while items belonged to this batch. Reporting only — the
   * E4.2 experiment caps are gone and these numbers never gate dispatch. */
  private usage(batchId: string): BatchBudget {
    const row = this.db.prepare("SELECT coalesce(sum(CASE WHEN s.kind='asr' THEN s.duration_ms ELSE 0 END),0) ms,coalesce(sum(s.kind='asr'),0) a,coalesce(sum(s.kind='generation'),0) g FROM batch_digest_submissions s JOIN batch_digest_items i ON i.request_id=s.request_id WHERE i.batch_id=?").get(batchId) as Row;
    return { asrMinutes: row.ms / 60_000, asrPosts: row.a, generationPosts: row.g };
  }
  create(contentIds: number[], renew = false): BatchDigestState {
    if (!Array.isArray(contentIds) || !contentIds.length || contentIds.length > MAX_ITEMS || contentIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(contentIds).size !== contentIds.length) throw Error('请选择 1 至 35 条不同收藏');
    const id = `batch-${randomUUID()}`, now = Date.now();
    this.db.transaction(() => {
      const records = contentIds.map(contentId => {
        const content = this.dependencies.getContent(contentId); if (!content) throw Error('收藏不存在');
        // Terminal batch items never block a new batch; an item still in flight does.
        if (this.db.prepare(`SELECT 1 FROM batch_digest_items WHERE content_id=? AND state NOT IN (${TERMINAL_ITEM_STATES.map(() => '?').join(',')})`).get(contentId, ...TERMINAL_ITEM_STATES)) throw Error('收藏正在处理中');
        const prior = this.dependencies.statusDigest(contentId);
        if (!renew && prior.request?.state === 'complete' && !prior.request.synthetic) throw Error('该收藏已有完成成果，不计入本轮新消化');
        return content;
      });
      this.db.prepare("INSERT INTO batch_digest_runs VALUES(?,'running',NULL,?,?)").run(id, now, now);
      for (const content of records) this.db.prepare("INSERT INTO batch_digest_items VALUES(?,?,?,?,?,NULL,'waiting-download',NULL,0,?,NULL,NULL)").run(id, content.id, this.identity(content), content.title, content.platform, now);
    })();
    this.tick(); return this.status(id);
  }
  pause(id: string): BatchDigestState { this.run(id); this.db.prepare("UPDATE batch_digest_runs SET state='paused',reason='已暂停后续处理，当前调用完成后保存',updated_at=? WHERE id=?").run(Date.now(), id); return this.status(id); }
  resume(id: string): BatchDigestState {
    this.run(id);
    // An explicit resume acknowledges a diagnosed circuit breaker, not an
    // unknown call or a failed item's retry. Budget totals remain unchanged.
    this.db.prepare('UPDATE batch_digest_failures SET blocked=0,count=0').run();
    this.db.prepare("UPDATE batch_digest_runs SET state='running',reason=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
    this.tick(); this.dependencies.kickRunners(); return this.status(id);
  }
  cancelItem(batchId: string, contentId: number): BatchDigestState {
    const item = this.item(batchId, contentId);
    if (['complete', 'candidate', 'cancelled', 'result-unknown'].includes(item.state)) return this.status(batchId);
    if (item.request_id) this.dependencies.cancelDigest(contentId);
    this.db.prepare("UPDATE batch_digest_items SET state='cancelled',reason='已取消',finished_at=? WHERE batch_id=? AND content_id=?").run(Date.now(), batchId, contentId);
    this.refresh(); return this.status(batchId);
  }
  retry(batchId: string, contentId: number): BatchDigestState {
    this.refresh(); const item = this.item(batchId, contentId);
    if (item.state === 'result-unknown') throw Error('远端结果未知，不自动重发；保留原调用供核查');
    if (item.state !== 'failed' || !item.request_id || item.retry_count >= 1) throw Error('本条没有可重试步骤，或已用完一次批次重试');
    this.db.transaction(() => { this.dependencies.retryDigest(contentId); this.db.prepare("UPDATE batch_digest_items SET retry_count=retry_count+1,state='queued',reason=NULL,finished_at=NULL WHERE batch_id=? AND content_id=?").run(batchId, contentId); })();
    if (this.run(batchId).state === 'attention') this.db.prepare("UPDATE batch_digest_runs SET state='running',reason=NULL,updated_at=? WHERE id=?").run(Date.now(), batchId);
    this.dependencies.kickRunners(); return this.status(batchId);
  }
  retryItem(batchId: string, contentId: number): BatchDigestState { return this.retry(batchId, contentId); }
  /** Called by the normal application polling/timer. No request is frozen until
   * all current source files are ready; waiting items cost no OCR or provider I/O. */
  /** E4.13 one-shot (settings flag e413BudgetUnblock): remove old batch-budget
   * blocks and requeue the items they failed, so stalled queues resume. Runs on
   * the first tick, when repositories are already wired. */
  private unblockBudgetOnce(): void {
    if (!this.unblockPending) return;
    this.unblockPending = false;
    const has = (name: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const cleared = this.db.prepare("DELETE FROM batch_digest_failures WHERE code='batch-budget'").run().changes;
    const stuck = has('generation_tasks') || has('asr_chunks') ? (this.db.prepare(`
      SELECT i.batch_id, i.content_id FROM batch_digest_items i JOIN batch_digest_runs b ON b.id=i.batch_id
      WHERE i.state IN ('failed','processing','queued') AND i.request_id IS NOT NULL AND b.state!='complete' AND (
        ${has('generation_tasks') ? "EXISTS(SELECT 1 FROM generation_tasks t WHERE t.request_id=i.request_id AND t.state!='succeeded' AND json_extract(t.error_json,'$.code')='batch-budget')" : '0'}
        OR ${has('asr_chunks') ? "EXISTS(SELECT 1 FROM asr_chunks c WHERE c.request_id=i.request_id AND c.state!='succeeded' AND json_extract(c.error_json,'$.code')='batch-budget')" : '0'}
        OR ${has('generation_requests') ? "EXISTS(SELECT 1 FROM generation_requests g WHERE g.request_id=i.request_id AND json_extract(g.error_json,'$.code')='batch-budget')" : '0'}
      )`).all() as Row[]) : [];
    let retried = 0;
    for (const item of stuck) {
      try {
        this.dependencies.retryDigest(item.content_id);
        this.db.prepare("UPDATE batch_digest_items SET state='queued',reason=NULL,finished_at=NULL WHERE batch_id=? AND content_id=?").run(item.batch_id, item.content_id);
        this.db.prepare("UPDATE batch_digest_runs SET state='running',reason=NULL,updated_at=? WHERE id=? AND state='attention'").run(Date.now(), item.batch_id);
        retried++;
      } catch { /* keep the row; the user can still retry explicitly */ }
    }
    this.db.prepare("INSERT INTO settings(key,value) VALUES('e413BudgetUnblock','done') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    this.dependencies.evidence?.('batch-budget-unblocked', { cleared, retried });
    if (retried) this.refresh();
  }
  tick(): void {
    if (this.ticking) return; this.ticking = true; let created = false;
    try {
      this.unblockBudgetOnce();
      this.refresh();
      const rows = this.db.prepare("SELECT i.* FROM batch_digest_items i JOIN batch_digest_runs b ON b.id=i.batch_id WHERE b.state='running' AND i.request_id IS NULL AND i.state='waiting-download' ORDER BY i.selected_at,i.content_id").all() as Row[];
      for (const item of rows) {
        const content = this.dependencies.getContent(item.content_id);
        if (!content || this.identity(content) !== item.identity_json || content.availability === 'unavailable' || content.availability === 'unsupported') { this.failItem(item, '来源不可访问或账号身份改变，未创建消化请求'); continue; }
        if (!content.offline || !content.bodyComplete || content.mediaManifestComplete !== true || content.media.some(media => media.current !== false && (media.state !== 'succeeded' || !media.localPath))) {
          // E4.9: the skip used to be silent — stamp the concrete reason so the
          // batch popover and workspace can say why nothing has started.
          const reason = !content.bodyComplete
            ? (String(content.manifestError ?? '').trim() || '正文未完整取得')
            : '等待本地媒体完整保存';
          this.db.prepare("UPDATE batch_digest_items SET reason=? WHERE batch_id=? AND content_id=? AND request_id IS NULL").run(reason, item.batch_id, item.content_id);
          continue;
        }
        try {
          this.db.transaction(() => {
            const prior = this.dependencies.statusDigest(content.id);
            const result = this.dependencies.requestDigest(content.id, !!prior.request);
            if (!result.request || result.request.synthetic) throw Error('正常消化请求未建立');
            this.db.prepare("UPDATE batch_digest_items SET request_id=?,state='queued',reason=NULL,started_at=? WHERE batch_id=? AND content_id=? AND request_id IS NULL").run(result.request.id, Date.now(), item.batch_id, item.content_id);
          })(); created = true;
        } catch { this.failItem(item, '创建消化请求未完成，来源和旧成果保留'); }
      }
      this.refresh();
    } finally { this.ticking = false; }
    if (created) this.dependencies.kickRunners();
  }
  private failItem(item: Row, reason: string): void { this.db.prepare("UPDATE batch_digest_items SET state='failed',reason=?,finished_at=? WHERE batch_id=? AND content_id=?").run(reason, Date.now(), item.batch_id, item.content_id); }
  private refresh(): void {
    for (const item of this.db.prepare("SELECT * FROM batch_digest_items WHERE request_id IS NOT NULL AND state NOT IN ('complete','candidate','cancelled')").all() as Row[]) {
      const current = this.dependencies.statusDigest(item.content_id), request = current.request;
      if (!request || request.id !== item.request_id) { this.failItem(item, '本条请求已变化，批次不扩大到新请求'); continue; }
      let state: BatchItemState = request.state === 'complete' ? (request.candidate || current.library?.candidate ? 'candidate' : 'complete') : request.state === 'result-unknown' ? 'result-unknown' : request.state === 'failed' ? 'failed' : request.state === 'cancelled' ? 'cancelled' : 'processing';
      const terminal = ['complete','candidate','failed','result-unknown','cancelled'].includes(state);
      const problem = current.stages.find(stage => stage.state === 'result-unknown' && stage.error)
        ?? current.stages.find(stage => stage.state === 'failed' && stage.error)
        ?? current.stages.find(stage => !['succeeded','not-required','cancelled'].includes(stage.state) && stage.error);
      const reason = ['complete','candidate'].includes(state) ? null : problem?.error ?? (state === 'result-unknown' ? '结果未知，不自动重发' : null);
      this.db.prepare('UPDATE batch_digest_items SET state=?,reason=?,finished_at=CASE WHEN ? THEN coalesce(finished_at,?) ELSE NULL END WHERE batch_id=? AND content_id=?').run(state, reason, +terminal, Date.now(), item.batch_id, item.content_id);
    }
    // E4.16: an item that came back to life (automatic retry) reopens its finished-with-attention batch.
    this.db.prepare(`UPDATE batch_digest_runs SET state='running',reason=NULL,updated_at=? WHERE state='attention' AND EXISTS(SELECT 1 FROM batch_digest_items i WHERE i.batch_id=batch_digest_runs.id AND i.state NOT IN ('complete','candidate','failed','result-unknown','cancelled'))`).run(Date.now());
    for (const batch of this.db.prepare("SELECT * FROM batch_digest_runs WHERE state='running'").all() as Row[]) {
      const rows = this.db.prepare('SELECT state FROM batch_digest_items WHERE batch_id=?').all(batch.id) as Row[];
      if (rows.length && rows.every(item => ['complete','candidate','failed','result-unknown','cancelled'].includes(item.state))) {
        const complete = rows.every(item => ['complete','candidate'].includes(item.state));
        this.db.prepare('UPDATE batch_digest_runs SET state=?,reason=?,updated_at=? WHERE id=?').run(complete ? 'complete' : 'attention', complete ? null : '批次已结束，部分条目需要查看原因', Date.now(), batch.id);
      }
    }
  }
  private allowed(kind: BatchProcessingKind, requestId: string, publication = false): boolean {
    const item = this.owns(requestId); if (!item || item.state === 'cancelled') return false;
    if (publication) return true;
    if (['failed','result-unknown','complete','candidate'].includes(item.state)) return false;
    if (item.batch_state !== 'running' || this.db.prepare('SELECT 1 FROM batch_digest_failures WHERE kind=? AND blocked=1').get(kind)) return false;
    // Local receipts/cache may still finish at the limit. The exact paid
    // submission boundary below, not dispatch, enforces the remaining quota.
    return true;
  }
  hooks(kind: BatchProcessingKind): BatchRunnerHooks {
    return {
      allowRequest: requestId => this.allowed(kind, requestId),
      allowPublication: requestId => this.allowed(kind, requestId, true),
      submit: (input, commit) => {
        if (kind === 'ocr') { commit(); return; }
        const old = this.db.prepare('SELECT * FROM batch_digest_submissions WHERE run_id=?').get(input.runId) as Row | undefined;
        if (old) throw new BatchDispatchError('batch-unauthorized');
        const owner = this.owns(input.requestId); if (!owner) throw new BatchDispatchError('batch-unauthorized');
        if (owner.batch_state !== 'running') throw new BatchDispatchError('batch-paused');
        const durationMs = kind === 'asr' ? input.durationMs : 0;
        if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0 || kind === 'asr' && durationMs <= 0) throw new BatchDispatchError('batch-unauthorized');
        // E4.13: no budget ceiling — submissions are recorded for usage only.
        this.db.transaction(() => { this.db.prepare('INSERT INTO batch_digest_submissions VALUES(?,?,?,?,?)').run(input.runId, input.requestId, kind, durationMs, Date.now()); commit(); })();
      },
      settled: (requestId, errorCode) => {
        if (!this.owns(requestId)) return;
        if (!errorCode) this.db.prepare('DELETE FROM batch_digest_failures WHERE kind=? AND blocked=0').run(kind);
        else {
          const previous = this.db.prepare('SELECT * FROM batch_digest_failures WHERE kind=?').get(kind) as Row | undefined;
          const count = previous?.code === errorCode ? previous.count + 1 : 1;
          const blocked = count >= 3 || ['unauthorized','disk','disk-full'].includes(errorCode);
          this.db.prepare('INSERT INTO batch_digest_failures VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET code=excluded.code,count=excluded.count,blocked=MAX(batch_digest_failures.blocked,excluded.blocked)').run(kind, errorCode, count, +blocked);
        }
        this.refresh();
      },
    };
  }
  status(id: string): BatchDigestState {
    this.refresh(); const batch = this.run(id), counts: Record<BatchItemState, number> = {'waiting-download':0,queued:0,processing:0,complete:0,candidate:0,failed:0,'result-unknown':0,cancelled:0};
    const items = (this.db.prepare('SELECT * FROM batch_digest_items WHERE batch_id=? ORDER BY selected_at,content_id').all(id) as Row[]).map(item => {
      const current = item.request_id ? this.dependencies.statusDigest(item.content_id) : null;
      const state = item.state as BatchItemState; counts[state]++;
      // Older completed rows may retain extraction progress text in reason.
      // Suppress it on read as well, so restart does not revive a stale warning.
      return {contentId:item.content_id,title:item.title,platform:item.platform,requestId:item.request_id,state,...(item.reason&&!['complete','candidate'].includes(state)?{reason:item.reason}:{}),retryCount:item.retry_count,selectedAt:item.selected_at,startedAt:item.started_at,finishedAt:item.finished_at,stages:current?.request?.id===item.request_id?(current?.stages??[]):[]} as BatchDigestItem;
    });
    const blocked = (this.db.prepare('SELECT kind,code FROM batch_digest_failures WHERE blocked=1').all() as Row[]).map(row => `${row.kind}: ${row.code}`);
    return {id,state:batch.state,createdAt:batch.created_at,updatedAt:batch.updated_at,...(batch.reason||blocked.length?{reason:batch.reason||`相关队列暂停：${blocked.join('；')}`} : {}),items,budget:this.usage(id),counts};
  }
  list(): BatchDigestState[] { return (this.db.prepare('SELECT id FROM batch_digest_runs ORDER BY created_at DESC').all() as Row[]).map(row => this.status(row.id)); }
}
