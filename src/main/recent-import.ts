import type { CollectionSnapshot, ContentRecord, MediaRecord, Platform, RecentSyncScope, RecentSyncState } from '../shared/contracts.js';
import type { Store } from './store.js';
import { recentLimit, requireSourceAccount } from './source-collection.js';

export interface RecentImportOptions { batchId: string; limit: number }
type Row = Record<string, any>;
/** Only constructed by the explicitly isolated batch runtime. No source credentials are stored. */
export class RecentImport {
  constructor(private readonly store: Store, readonly options: RecentImportOptions) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(options.batchId)) throw Error('批次身份无效');
    recentLimit(options.limit);
    store.db.exec(`CREATE TABLE IF NOT EXISTS recent_import_scopes (
      batch_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, requested_limit INTEGER NOT NULL,
      target_json TEXT NOT NULL, observed_json TEXT NOT NULL, target_complete INTEGER NOT NULL,
      history_complete INTEGER NOT NULL, reliable INTEGER NOT NULL, reason TEXT NOT NULL,
      paused_reason TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(batch_id,platform));
      CREATE TABLE IF NOT EXISTS recent_import_targets (
      batch_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
      PRIMARY KEY(batch_id,platform,account_id,source_id));
      CREATE TABLE IF NOT EXISTS recent_import_download_pauses (
      batch_id TEXT NOT NULL, content_id INTEGER NOT NULL REFERENCES contents(id), reason TEXT NOT NULL,
      paused_at INTEGER NOT NULL, PRIMARY KEY(batch_id,content_id));
      CREATE TABLE IF NOT EXISTS recent_import_item_retries (
      batch_id TEXT NOT NULL, item_key TEXT NOT NULL, attempts INTEGER NOT NULL,
      next_at INTEGER NOT NULL, PRIMARY KEY(batch_id,item_key));`);
    // E4.8: seed favourite-order ranks from the latest observed snapshot order.
    store.backfillFavoriteOrder(options.batchId);
  }
  private rows(): Row[] { return this.store.db.prepare('SELECT * FROM recent_import_scopes WHERE batch_id=? ORDER BY platform').all(this.options.batchId) as Row[]; }
  expectedAccount(platform: Platform): string | undefined { return this.rows().find(row => row.platform === platform)?.account_id; }
  state(): RecentSyncState & { pausedContentDownloads: NonNullable<RecentSyncState['pausedContentDownloads']> } {
    return { ...this.options, pausedContentDownloads: this.pausedContentDownloads(), scopes: this.rows().map(row => ({ platform:row.platform, accountId:row.account_id,
      targetIds:JSON.parse(row.target_json), observedIds:JSON.parse(row.observed_json), targetComplete:!!row.target_complete,
      historyComplete:!!row.history_complete, reliable:!!row.reliable, reason:row.paused_reason || row.reason,
      startedAt:row.started_at, updatedAt:row.updated_at })) as RecentSyncScope[] };
  }
  /** Caller wraps this together with saveSnapshot in one transaction. E4.7: the
   * target accumulates — every id ever imported stays download-eligible, and a
   * smaller or larger sync range only changes the observed window. */
  select(snapshot: CollectionSnapshot, now: number, requested: number | 'all'): Set<string> {
    if (requested !== 'all' && snapshot.target !== undefined && snapshot.target.limit !== requested) throw Error('来源近期数量与本轮批次不一致');
    requireSourceAccount(snapshot.accountId, this.expectedAccount(snapshot.platform));
    const previous = this.rows().find(row => row.platform === snapshot.platform);
    const observed = snapshot.items.map(item => item.sourceId);
    const seen = new Set<string>(previous ? JSON.parse(previous.target_json) as string[] : []);
    const target: string[] = [...seen];
    for (const id of observed) if (!seen.has(id)) { seen.add(id); target.push(id); }
    const complete = !!previous?.target_complete || !!snapshot.target?.complete;
    this.store.db.prepare(`INSERT INTO recent_import_scopes VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT(batch_id,platform) DO UPDATE SET requested_limit=excluded.requested_limit, target_json=excluded.target_json, observed_json=excluded.observed_json,
      target_complete=excluded.target_complete,history_complete=excluded.history_complete,reliable=excluded.reliable,
      reason=excluded.reason,paused_reason=NULL,updated_at=excluded.updated_at`).run(this.options.batchId,snapshot.platform,
      snapshot.accountId,requested==='all'?-1:requested,JSON.stringify(target),JSON.stringify(observed),+complete,+snapshot.complete,
      +(snapshot.target?.reliable ?? false),snapshot.target?.reason ?? '来源未提供近期目标覆盖证据',previous?.started_at??now,now);
    this.store.db.prepare('DELETE FROM recent_import_targets WHERE batch_id=? AND platform=?').run(this.options.batchId,snapshot.platform);
    const insert=this.store.db.prepare('INSERT INTO recent_import_targets VALUES(?,?,?,?)');
    for(const id of target)insert.run(this.options.batchId,snapshot.platform,snapshot.accountId,id);
    return new Set(target);
  }
  contains(content: ContentRecord | undefined): boolean {
    return !!content && !!this.store.db.prepare('SELECT 1 FROM recent_import_targets WHERE batch_id=? AND platform=? AND account_id=? AND source_id=?')
      .get(this.options.batchId,content.platform,content.accountId,content.sourceId);
  }
  pausedContentDownloads(): { contentId: number; reason: string; pausedAt: number }[] {
    return (this.store.db.prepare('SELECT content_id,reason,paused_at FROM recent_import_download_pauses WHERE batch_id=? ORDER BY content_id').all(this.options.batchId) as Row[])
      .map(row => ({ contentId: row.content_id, reason: row.reason, pausedAt: row.paused_at }));
  }
  isDownloadPaused(contentId: number): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM recent_import_download_pauses WHERE batch_id=? AND content_id=?').get(this.options.batchId,contentId);
  }
  /** A separate dispatch exclusion never rewrites source, content or media state. */
  pauseContentDownload(contentId: number, reason = '此条未纳入自动下载'): void {
    if (!Number.isSafeInteger(contentId) || contentId < 1 || !this.contains(this.store.content(contentId))) throw Error('收藏不在本轮同步目标范围');
    if (reason !== '此条未纳入自动下载') throw Error('单条下载暂停原因无效');
    this.store.db.prepare('INSERT OR IGNORE INTO recent_import_download_pauses VALUES(?,?,?,?)').run(this.options.batchId,contentId,reason,Date.now());
  }
  pausePlatform(platform: Platform, reason: string): void { this.store.db.prepare('UPDATE recent_import_scopes SET paused_reason=? WHERE batch_id=? AND platform=?').run(reason,this.options.batchId,platform); }
  resumePlatforms(): void { this.store.db.prepare('UPDATE recent_import_scopes SET paused_reason=NULL WHERE batch_id=?').run(this.options.batchId); }
  resumePlatform(platform: Platform): void { this.store.db.prepare('UPDATE recent_import_scopes SET paused_reason=NULL WHERE batch_id=? AND platform=?').run(this.options.batchId,platform); }
  pausedScopes(): { platform: Platform; reason: string }[] {
    return (this.store.db.prepare('SELECT platform,paused_reason FROM recent_import_scopes WHERE batch_id=? AND paused_reason IS NOT NULL').all(this.options.batchId) as Row[])
      .map(row => ({ platform: row.platform as Platform, reason: String(row.paused_reason) }));
  }
  /** E4.5 per-item transient backoff; the item becomes eligible again at next_at. */
  retryState(itemKey: string): { attempts: number; nextAt: number } {
    const row = this.store.db.prepare('SELECT attempts,next_at FROM recent_import_item_retries WHERE batch_id=? AND item_key=?').get(this.options.batchId, itemKey) as Row | undefined;
    return { attempts: Number(row?.attempts ?? 0), nextAt: Number(row?.next_at ?? 0) };
  }
  recordRetry(itemKey: string, attempts: number, nextAt: number): void {
    this.store.db.prepare('INSERT INTO recent_import_item_retries VALUES(?,?,?,?) ON CONFLICT(batch_id,item_key) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at').run(this.options.batchId, itemKey, attempts, nextAt);
  }
  clearRetry(itemKey: string): void { this.store.db.prepare('DELETE FROM recent_import_item_retries WHERE batch_id=? AND item_key=?').run(this.options.batchId, itemKey); }
  /** Queued-but-not-started counts for one platform's lane status. */
  queueCounts(platform: Platform, now: number): { details: number; media: number } {
    const details = (this.store.db.prepare(`SELECT COUNT(*) n FROM contents c ${this.eligible} AND c.detail_state='queued' ${this.ready('c.id','detail')}
      AND c.platform=?`).get(this.options.batchId, now, platform) as Row).n;
    const media = (this.store.db.prepare(`SELECT COUNT(*) n FROM media m JOIN contents c ON c.id=m.content_id ${this.eligible}
      AND m.state='queued' AND m.current=1 AND c.detail_state='succeeded' ${this.ready('m.id','media')}
      AND c.platform=?`).get(this.options.batchId, now, platform) as Row).n;
    return { details: Number(details), media: Number(media) };
  }
  private eligible = `JOIN recent_import_targets t ON t.platform=c.platform AND t.account_id=c.account_id AND t.source_id=c.source_id
    JOIN recent_import_scopes s ON s.batch_id=t.batch_id AND s.platform=t.platform
    WHERE t.batch_id=? AND s.paused_reason IS NULL
    AND NOT EXISTS (SELECT 1 FROM recent_import_download_pauses p WHERE p.batch_id=t.batch_id AND p.content_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM content_deletions d WHERE d.content_id=c.id)`;
  /** Item is hidden from lanes until its transient backoff time passes. */
  private ready(idExpr: string, phase: 'detail' | 'media'): string {
    return `AND NOT EXISTS (SELECT 1 FROM recent_import_item_retries r WHERE r.batch_id=t.batch_id AND r.item_key='${phase}:'||${idExpr} AND r.next_at>?)`;
  }
  nextDetail(filter?: { platform?: Platform; exclude?: ReadonlySet<number>; now?: number }): ContentRecord | undefined {
    const params: unknown[] = [this.options.batchId];
    let sql = `SELECT c.id FROM contents c ${this.eligible} AND c.detail_state='queued'`;
    if (filter?.now !== undefined) { sql += ` ${this.ready('c.id','detail')}`; params.push(filter.now); }
    if (filter?.platform) { sql += ` AND c.platform=?`; params.push(filter.platform); }
    if (filter?.exclude?.size) { sql += ` AND c.id NOT IN (${[...filter.exclude].map(() => '?').join(',')})`; params.push(...filter.exclude); }
    const row = this.store.db.prepare(sql + ' ORDER BY c.id LIMIT 1').get(...params) as Row | undefined;
    return row ? this.store.content(row.id) : undefined;
  }
  nextDownload(filter?: { platform?: Platform; preferred?: number; exclude?: ReadonlySet<number>; kinds?: 'image' | 'av'; now?: number }): (MediaRecord & {remoteUrl:string;referer?:string})|undefined {
    const params: unknown[] = [this.options.batchId];
    let sql = `SELECT m.* FROM media m JOIN contents c ON c.id=m.content_id ${this.eligible}
      AND m.state='queued' AND m.current=1 AND c.detail_state='succeeded'`;
    if (filter?.now !== undefined) { sql += ` ${this.ready('m.id','media')}`; params.push(filter.now); }
    if (filter?.platform) { sql += ` AND c.platform=?`; params.push(filter.platform); }
    if (filter?.kinds) { sql += filter.kinds === 'image' ? ` AND m.kind='image'` : ` AND m.kind!='image'`; }
    if (filter?.exclude?.size) { sql += ` AND m.id NOT IN (${[...filter.exclude].map(() => '?').join(',')})`; params.push(...filter.exclude); }
    sql += ' ORDER BY CASE WHEN m.content_id=? THEN 0 ELSE 1 END,m.media_order,m.id LIMIT 1';
    params.push(filter?.preferred ?? -1);
    const row = this.store.db.prepare(sql).get(...params) as Row | undefined;
    return row?{...this.store.media(row.id)!,remoteUrl:row.remote_url,referer:row.referer??undefined}:undefined;
  }
}
