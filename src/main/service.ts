import { createWriteStream, readdirSync, rmSync } from 'node:fs';
import { rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CollectionItem, CollectionSnapshot, Connection, ContentRecord, MediaRecord, Platform, SourceAdapter, SyncRange, WorkbenchState, RecentScopeEvidence } from '../shared/contracts.js';
import { Store, type Discovery } from './store.js';
import { RecentImport, type RecentImportOptions } from './recent-import.js';
import { activeDigestRequest, type DigestContentState } from '../shared/digest-contracts.js';
import { processingUsage } from './processing-usage.js';
import { COOLDOWN_LEVEL_MINUTES, COOLDOWN_LEVEL_QUIET_MS, MAX_EXPIRED_REFRESHES, MAX_TRANSIENT_ATTEMPTS, TRANSIENT_BACKOFF_MS, TRANSIENT_STREAK_LIMIT, classifyFailure, cooldownKey, pauseKey, readCooldown, readPause, type CooldownRecord, type FailurePhase, type PauseRecord } from './batch-failure.js';

export interface ServiceOptions {
  /** Explicit isolated batch; disables automatic collection and scopes download dispatch. */
  recentImport?: RecentImportOptions;
  editorEnabled?: boolean;
  ocrEnabled?: boolean;
  /** Only the explicit E2 isolated entry may open schema8 and ASR storage. */
  asrEnabled?: boolean;
  generationEnabled?: boolean;
  editorAssetsDir?: string;
  /** Isolated E1 runs never start source adapters, queues or scheduled checks. */
  backgroundDisabled?: boolean;
  connections: () => Connection[];
  fetch?: (url: string, init?: RequestInit, platform?: Platform) => Promise<Response>;
  /** Injectable clock for deterministic rule tests. */
  now?: () => number;
  /** Abort a transfer only when headers or subsequent bytes stop arriving. */
  downloadIdleMs?: number;
  /** Detail and collect timeouts; test knobs, defaults 90s / 5min. */
  detailTimeoutMs?: number;
  collectTimeoutMs?: number;
  /** Structured diagnostics sink wired by the main process. */
  evidence?: (event: string, fields?: Record<string, unknown>) => void;
}
const HALF_HOUR = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Deliberately excludes adapter response bodies, URLs, and credentials from persisted errors. */
export function isAuthenticationError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } : undefined;
  if (record?.code === 'LOGIN_REQUIRED' || Number(record?.code) === -101 || Number(record?.status) === 401 || Number(record?.statusCode) === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bLOGIN_REQUIRED\b|\bHTTP\s*401\b|(?:^|[^\d])-101(?:[^\d]|$)/i.test(message);
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isAuthenticationError(error)) return '登录失效，请在设置中重新登录后重试';
  if (/429|rate|限流|频繁/i.test(message)) return '平台暂时限流，请稍后重试';
  if (/\bHTTP\s*(?:403|412)\b|访问受限|风控/i.test(message)) return '平台访问受限或资源地址已过期，请稍后重试以刷新地址';
  if (/offline|network|fetch|connect|联网|网络|ENOTFOUND|ECONN/i.test(message)) return '网络连接失败，请恢复网络后重试';
  if (/HTTP\s?\d{3}/i.test(message)) return message.match(/HTTP\s?\d{3}/i)![0] + '：资源获取失败，可重试';
  return safeWarning(message) || '采集或保存失败，请重试';
}

function safeWarning(warning: string | undefined): string {
  if (!warning) return '';
  // Only keep short diagnostic prose; redact URLs and familiar credential forms.
  return warning.replace(/https?:\/\/\S+/gi, '[链接已隐藏]').replace(/\b(?:cookie|set-cookie|token|access_token|refresh_token|xsec_token|authorization|x-s|x-t|password|secret)\b["']?\s*[:=]\s*["']?[^\s,;]+/gi, '[凭证已隐藏]').replace(/[\r\n]/g, ' ').slice(0, 240);
}

/** E4.4 §3.4：首页三组。needsAttention = 需要用户处理的消化/批次状态；halfWritten = 已保存非空工作区的 contentId→更新时间。 */
export function homeSelections(contents: ContentRecord[], now: number, digestStates?: DigestContentState[], sets?: { halfWritten?: ReadonlyMap<number, number>; attention?: ReadonlySet<number> }): Pick<WorkbenchState, 'continueItems' | 'recent' | 'reviews'> {
  const digestByContent = digestStates ? new Map(digestStates.map(s => [s.contentId, s])) : undefined;
  const stateFor = (c: ContentRecord) => digestByContent?.get(c.id);
  const inLibrary = (c: ContentRecord) => digestStates ? !!stateFor(c)?.library?.active : c.digestedAt !== null;
  const processing = (c: ContentRecord) => { const state = stateFor(c); return !!state && activeDigestRequest(state); };
  const enteredAt = (c: ContentRecord) => stateFor(c)?.library?.completedAt ?? stateFor(c)?.library?.enteredAt ?? c.digestedAt ?? 0;
  const reviewedAt = (c: ContentRecord) => digestStates ? stateFor(c)?.library?.lastReviewedAt ?? 0 : c.lastReviewedAt ?? 0;
  const attentionStates = new Set(['failed', 'result-unknown', 'waiting-configuration', 'waiting-model', 'waiting-network', 'waiting-files', 'waiting-content', 'waiting-capability']);
  const needsAttention = (c: ContentRecord) => { const state = stateFor(c)?.request?.state; return (!!state && attentionStates.has(state)) || !!sets?.attention?.has(c.id); };
  const updatedAt = (c: ContentRecord) => stateFor(c)?.request?.updatedAt ?? sets?.halfWritten?.get(c.id) ?? c.firstDiscoveredAt;
  const continueItems = contents.filter(c => processing(c) || needsAttention(c) || (!inLibrary(c) && !processing(c) && sets?.halfWritten?.has(c.id)))
    .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || updatedAt(b) - updatedAt(a) || b.id - a.id).slice(0, 8);
  const used = new Set(continueItems.map(c => c.id));
  const recent = contents.filter(c => !used.has(c.id) && !inLibrary(c) && !processing(c) && c.firstDiscoveredAt <= now && c.firstDiscoveredAt >= now - 7 * DAY)
    .sort((a, b) => b.firstDiscoveredAt - a.firstDiscoveredAt || b.id - a.id).slice(0, 12);
  for (const c of recent) used.add(c.id);
  const reviews = contents.filter(c => !used.has(c.id) && inLibrary(c) && !processing(c) && enteredAt(c) <= now && enteredAt(c) >= now - 14 * DAY)
    .sort((a, b) => reviewedAt(a) - reviewedAt(b) || enteredAt(a) - enteredAt(b) || a.id - b.id).slice(0, 20);
  return { continueItems, recent, reviews };
}

function uniqueItems(items: CollectionItem[]): CollectionItem[] {
  const values = new Map<string, CollectionItem>();
  for (const item of items) {
    const old = values.get(item.sourceId);
    values.set(item.sourceId, old ? { ...old, folderIds: [...new Set([...old.folderIds, ...item.folderIds])] } : { ...item, folderIds: [...new Set(item.folderIds)] });
  }
  return [...values.values()];
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Download aborted')); };
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

export class WorkbenchService {
  readonly store: Store;
  readonly recentImport?: RecentImport;
  private downloadsPaused = false;
  private sourceFailures = new Map<Platform,{message:string;count:number}>();
  private readonly adapters: Map<Platform, SourceAdapter>;
  // E4.5 batch lanes: per-platform fair scheduling with failure classification.
  private readonly laneTasks = new Map<string, { platform: Platform; type: 'detail' | 'media'; id: number; av: boolean; abort: AbortController }>();
  private readonly cooldowns = new Map<Platform, CooldownRecord>();
  private readonly hardPauses = new Map<Platform, PauseRecord>();
  private readonly transientStreaks = new Map<Platform, number>();
  private readonly laneRestUntil = new Map<Platform, number>();
  private laneCursor = 0;
  private lanePumping = false;
  private readonly now: () => number;
  private readonly fetcher: NonNullable<ServiceOptions['fetch']>;
  private readonly busy = new Set<Platform>();
  private readonly syncPromises = new Map<Platform, Promise<void>>();
  private readonly connectionErrors = new Map<Platform, { message: string; at: number }>();
  private online = true;
  private paused = false;
  private closed = false;
  private readonly pendingChecks = new Set<Platform>();
  private lastCheckAt: number | null = null;
  private nextCheckAt: number | null = null;
  private interruptionEpoch = 0;
  private preferMedia = true;
  private preferredContentId: number | undefined;
  private queuePromise: Promise<void> | undefined;
  private downloadAbort: AbortController | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly dataDir: string, adapters: SourceAdapter[], private readonly options: ServiceOptions) {
    this.store = new Store(dataDir, { editorEnabled: options.editorEnabled, ocrEnabled: options.ocrEnabled, asrEnabled: options.asrEnabled, generationEnabled: options.generationEnabled, editorAssetsDir: options.editorAssetsDir });
    if (options.recentImport) {
      this.recentImport = new RecentImport(this.store, options.recentImport);
      this.downloadsPaused=this.store.setting('batchDownloadsPaused','false')==='true';
      // Cooldowns and pauses are keyed by platform in settings, including
      // platforms whose collect never produced a scope row.
      for (const row of this.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'batchCooldown:%' OR key LIKE 'batchPause:%'").all() as { key: string; value: string }[]) {
        const platform = row.key.split(':')[1] as Platform;
        const cooldown = readCooldown(row.key.startsWith('batchCooldown:') ? row.value : '');
        if (cooldown) this.cooldowns.set(platform, cooldown);
        const pause = readPause(row.key.startsWith('batchPause:') ? row.value : '');
        if (pause) this.hardPauses.set(platform, pause);
      }
      // E4.5 startup migration: pre-classification pauses carried no kind
      // marker and mostly came from expired media URLs or short rate-limits.
      // Only explicit auth / account-mismatch pauses survive a restart.
      for (const row of this.recentImport.pausedScopes()) {
        const kind = this.hardPauses.get(row.platform)?.kind;
        if (kind === 'auth' || kind === 'account-changed') continue;
        this.recentImport.resumePlatform(row.platform);
        this.store.setSetting(pauseKey(row.platform), '');
        options.evidence?.('batch-pause-migrated', { platform: row.platform, reason: row.reason });
      }
      // E4.9 one-shot repair: X tweets whose own body was dropped because an
      // embedded quote was unreadable are requeued once under the fixed adapter.
      if (this.store.setting('e49XQuoteRepair', '') !== 'done') {
        const count = this.store.requeueXQuoteBlocked();
        this.store.setSetting('e49XQuoteRepair', 'done');
        options.evidence?.('x-quote-body-repair', { count });
      }
      // E4.12 one-shot repair: X Articles saved as summary-only are requeued
      // once under the article-aware adapter.
      if (this.store.setting('e412XArticleRepair', '') !== 'done') {
        const count = this.store.requeueXArticleSummaries();
        this.store.setSetting('e412XArticleRepair', 'done');
        options.evidence?.('x-article-body-repair', { count });
      }
    }
    if (options.backgroundDisabled) { this.online = false; this.paused = true; }
    this.adapters = new Map(adapters.map(adapter => [adapter.platform, adapter]));
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.lastCheckAt=Number(this.store.setting('schedulerLastCheckAt','0'))||null;
    this.nextCheckAt=this.enabled()?this.now()+HALF_HOUR:null;
    this.timer = setInterval(() => {
      this.expireWaits();
      if (options.backgroundDisabled || !this.enabled() || this.nextCheckAt === null || this.now()<this.nextCheckAt) return;
      this.nextCheckAt=this.now()+HALF_HOUR;
      if (!this.canWork()) { this.markPending(); return; }
      void this.sync(undefined,'timer');
    }, 1000);
    this.timer.unref();
    // Clear unfinished temporary files; completed files are never removed on startup.
    for (const file of readdirSync(this.store.mediaDir).filter(file => file.endsWith('.part'))) rmSync(path.join(this.store.mediaDir, file), { force: true });
    if (!options.backgroundDisabled) queueMicrotask(() => this.pump());
  }
  private enabled(): boolean { return this.store.setting('autoSync', 'true') === 'true'; }
  /** Cooldowns and per-item transient backoffs expire on the shared 1s tick. */
  private expireWaits(): void {
    if (!this.recentImport) return;
    let pump = false;
    for (const [platform, cooldown] of [...this.cooldowns]) {
      if (cooldown.until > this.now()) continue;
      // E4.9: expiry keeps the escalation level (the next failure continues from
      // it); it is forgotten only after COOLDOWN_LEVEL_QUIET_MS without a failure.
      const lastFailureAt = cooldown.lastFailureAt ?? cooldown.until;
      if (this.now() - lastFailureAt >= COOLDOWN_LEVEL_QUIET_MS) { this.cooldowns.delete(platform); this.store.setSetting(cooldownKey(platform), ''); pump = true; }
      else if (cooldown.until > 0) { cooldown.until = 0; this.store.setSetting(cooldownKey(platform), JSON.stringify(cooldown)); pump = true; }
    }
    const due = this.store.db.prepare('SELECT 1 FROM recent_import_item_retries WHERE batch_id=? AND next_at<=? LIMIT 1')
      .get(this.recentImport.options.batchId, this.now());
    if (due) pump = true;
    if (pump) this.pump();
  }
  private platformCooldownActive(platform: Platform): boolean { return (this.cooldowns.get(platform)?.until ?? 0) > this.now(); }
  private platformBlocked(platform: Platform): boolean { return this.hardPauses.has(platform) || this.platformCooldownActive(platform); }
  private blockReason(platform: Platform): string { return this.hardPauses.get(platform)?.reason || this.cooldowns.get(platform)?.reason || '平台暂停'; }
  private cooldown(platform: Platform, reason: string, reset = false): void {
    // E4.9: a failure while the platform already cools is the same incident —
    // two lanes failing together escalate once, not twice.
    if (this.platformCooldownActive(platform)) return;
    const prior = reset ? undefined : this.cooldowns.get(platform);
    const level = prior ? prior.level + 1 : 0;
    if (level >= COOLDOWN_LEVEL_MINUTES.length) { this.cooldowns.delete(platform); this.store.setSetting(cooldownKey(platform), ''); this.hardPause(platform, 'exhausted', `平台持续限流，已暂停；恢复后可手动继续（${reason}）`); return; }
    const until = this.now() + Math.round(COOLDOWN_LEVEL_MINUTES[level] * 60_000 * (1 + Math.random() * 0.2));
    this.cooldowns.set(platform, { level, until, reason, lastFailureAt: this.now() });
    this.store.setSetting(cooldownKey(platform), JSON.stringify(this.cooldowns.get(platform)));
    this.options.evidence?.('batch-platform-cooldown', { platform, level, minutes: COOLDOWN_LEVEL_MINUTES[level], reason });
  }
  private hardPause(platform: Platform, kind: PauseRecord['kind'], reason: string): void {
    this.recentImport?.pausePlatform(platform, reason);
    this.hardPauses.set(platform, { kind, reason, at: this.now() });
    this.store.setSetting(pauseKey(platform), JSON.stringify(this.hardPauses.get(platform)));
    this.options.evidence?.('batch-platform-paused', { platform, kind, reason });
  }
  private clearPlatform(platform: Platform): void {
    this.cooldowns.delete(platform); this.hardPauses.delete(platform); this.transientStreaks.delete(platform);
    this.store.setSetting(cooldownKey(platform), ''); this.store.setSetting(pauseKey(platform), '');
    this.recentImport?.resumePlatform(platform);
  }
  /** Explicit per-platform resume from the popover. */
  resumePlatform(platform: Platform): void { this.clearPlatform(platform); this.pump(); }
  private platformSucceeded(platform: Platform): void {
    this.cooldowns.delete(platform); this.store.setSetting(cooldownKey(platform), '');
    this.transientStreaks.delete(platform);
  }
  private transientStreak(platform: Platform): void {
    const streak = (this.transientStreaks.get(platform) ?? 0) + 1;
    if (streak >= TRANSIENT_STREAK_LIMIT) { this.transientStreaks.delete(platform); this.cooldown(platform, '连续网络失败，已自动冷却', true); }
    else this.transientStreaks.set(platform, streak);
  }
  private canDownload(): boolean { return this.canWork() && !this.downloadsPaused; }
  private nextDetail() { return this.recentImport ? this.recentImport.nextDetail() : this.store.nextDetail(); }
  private nextDownload(preferred?: number) { return this.recentImport ? this.recentImport.nextDownload({ preferred }) : this.store.nextDownload(preferred); }
  /** Batch pause aborts every in-flight lane task; each requeues itself. */
  pauseDownloads(reason='下载已暂停'): void { this.downloadsPaused = true; if(this.recentImport){this.store.setSetting('batchDownloadsPaused','true');this.store.setSetting('batchDownloadsPauseReason',reason);} this.abortTasks(); }
  private abortTasks(): void { for (const task of this.laneTasks.values()) task.abort.abort(); }
  private laneState(platform: Platform): { details: number; images: number; videos: number } {
    const counts = { details: 0, images: 0, videos: 0 };
    for (const task of this.laneTasks.values()) if (task.platform === platform) { if (task.type === 'detail') counts.details++; else if (task.av) counts.videos++; else counts.images++; }
    return counts;
  }
  pauseContentDownload(contentId:number,reason='此条未纳入自动下载') {
    if(!this.recentImport)throw Error('单条下载暂停仅用于本轮独立同步');
    this.recentImport.pauseContentDownload(contentId,reason);
    if(this.preferredContentId===contentId)this.preferredContentId=undefined;
    return this.recentImport.pausedContentDownloads().find(item=>item.contentId===contentId)!;
  }
  resumeDownloads(): void { this.downloadsPaused = false; if(this.recentImport){this.store.setSetting('batchDownloadsPaused','false');this.store.setSetting('batchDownloadsPauseReason','');this.recentImport.resumePlatforms();this.sourceFailures.clear();for(const scope of this.recentImport.state().scopes)this.clearPlatform(scope.platform);} this.pump(); }
  private async checkDiskReserve(): Promise<void> { if(!this.recentImport)return; try { const fs=await statfs(this.dataDir); if(fs.bavail*fs.bsize<5*1024**3)throw Error('DISK_RESERVE：可用空间不足5 GiB，下载已暂停，旧文件保留'); } catch(error) { this.pauseDownloads(safeError(error));throw error; } }
  private sourceFailed(platform:Platform,error:unknown):void { if(!this.recentImport)return;const message=safeError(error),prior=this.sourceFailures.get(platform);const count=prior?.message===message?prior.count+1:1;this.sourceFailures.set(platform,{message,count});if(count>=3||isAuthenticationError(error)||/ACCOUNT_CHANGED|HTTP\s*(?:403|412|429)|限流|访问受限|风控/.test(String(error)))this.recentImport.pausePlatform(platform,message); }
  private canWork(): boolean { return !this.options.backgroundDisabled && this.online && !this.paused && !this.closed; }
  state(): WorkbenchState {
    const contents = this.store.contents();
    const digestStates = this.store.digestPipeline?.list();
    // E4.4 §3.4：一次集合查询取「写了一半」（任一文档已保存新版本）与「批次需处理」。
    const db = this.store.db;
    const hasTable = (name: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
    const halfWritten = new Map<number, number>();
    if (hasTable('editor_documents')) for (const row of db.prepare('SELECT w.content_id id, w.updated_at at FROM editor_workspaces w WHERE EXISTS(SELECT 1 FROM editor_documents d WHERE d.workspace_id=w.id AND d.current_revision>0)').all() as { id: number; at: number }[]) halfWritten.set(row.id, row.at);
    const attention = new Set<number>();
    if (hasTable('batch_digest_items')) for (const row of db.prepare("SELECT i.content_id id FROM batch_digest_items i JOIN batch_digest_runs b ON b.id=i.batch_id WHERE i.state IN ('failed','result-unknown') AND b.state!='complete'").all() as { id: number }[]) attention.add(row.id);
    const connections = this.options.connections().map(connection => {
      const error=this.connectionErrors.get(connection.platform);
      if(connection.state==='connected' && connection.verifiedAt && (!error || connection.verifiedAt>error.at)) this.loginVerified(connection.platform,connection.verifiedAt);
      const remaining=this.connectionErrors.get(connection.platform);
      return remaining?{...connection,state:'expired' as const,message:remaining.message}:connection;
    });
    const deleted = this.store.deletedContents();
    const blocked = this.deletionBlockedIds(contents);
    return { ...(this.recentImport ? {recentSync:{...this.recentImport.state(),lanes:this.laneStates()},downloadsPaused:this.downloadsPaused,downloadsPauseReason:this.store.setting('batchDownloadsPauseReason','')}:{}), contents, deleted, usage: processingUsage(db, this.now()), ...(blocked.length ? { deletionBlocked: blocked } : {}), ...homeSelections(contents, this.now(), digestStates, { halfWritten, attention }), ...(digestStates ? { digestStates } : {}), syncs: this.store.syncs(), connections, autoSync: this.enabled(), online: this.online,
      dataDir: this.dataDir, mediaDir: this.store.mediaDir, timezone: 'Asia/Shanghai', busy: [...this.busy], syncRange: this.syncRange(),
      scheduler:{lastCheckAt:this.lastCheckAt,nextCheckAt:this.enabled()&&this.canWork()?this.nextCheckAt:null,paused:!this.canWork(),pending:[...this.pendingChecks]},
      progress:{contents:contents.length,offline:contents.filter(c=>c.offline).length,bodyPending:contents.filter(c=>!c.bodyComplete).length,
        manifestMissing:contents.filter(c=>!c.mediaManifestComplete).length,mediaQueued:contents.flatMap(c=>c.media).filter(m=>m.state==='queued').length,
        mediaRunning:contents.flatMap(c=>c.media).filter(m=>m.state==='running').length,mediaFailed:contents.flatMap(c=>c.media).filter(m=>m.state==='failed').length,
        mediaSaved:contents.flatMap(c=>c.media).filter(m=>m.state==='succeeded').length} };
  }
  /** Called only after the source confirms a fresh authenticated account. */
  loginVerified(platform:Platform,verifiedAt=this.now()):void {
    const error=this.connectionErrors.get(platform);
    if(!error || verifiedAt>=error.at) this.connectionErrors.delete(platform);
    if(!this.recentImport)return;
    const pause=this.hardPauses.get(platform);
    // A fresh verified login clears an auth pause immediately. An
    // account-changed pause only clears when the source verifies the account
    // bound to this batch; a different account keeps the pause in place.
    if(pause?.kind==='auth')this.resumePlatform(platform);
    else if(pause?.kind==='account-changed'){
      const expected=this.recentImport.expectedAccount(platform),adapter=this.adapters.get(platform);
      if(expected&&adapter?.verifyAccount)void adapter.verifyAccount(expected).then(()=>this.resumePlatform(platform)).catch(()=>{});
    }
  }
  private laneStates(): import('../shared/contracts.js').RecentSyncLane[] {
    const now = this.now();
    // Platforms whose collect failed before a scope row existed still surface
    // here through their cooldown or pause records.
    const platforms = new Set<Platform>([...this.recentImport!.state().scopes.map(scope => scope.platform), ...[...this.cooldowns].filter(([, record]) => record.until > now).map(([platform]) => platform), ...this.hardPauses.keys()]);
    return [...platforms].map(platform => {
      const pause = this.hardPauses.get(platform);
      const cooldown = this.platformCooldownActive(platform) ? this.cooldowns.get(platform) : undefined;
      const active = this.laneState(platform);
      const queued = this.recentImport!.queueCounts(platform, now);
      const mode: import('../shared/contracts.js').RecentSyncLane['mode'] =
        pause ? (pause.kind === 'auth' ? 'login' : 'paused')
        : cooldown ? 'cooldown'
        : active.details + active.images + active.videos > 0 ? 'running'
        : queued.details + queued.media > 0 ? 'idle' : 'done';
      return { platform, mode, until: cooldown?.until, reason: pause?.reason ?? cooldown?.reason, active, queued };
    });
  }
  getMedia(id: number): MediaRecord | undefined { return this.store.media(id); }
  /** E4.6: why a content can't be deleted right now. One pass per state(). */
  private deletionBlockedIds(contents: ContentRecord[]): { contentId: number; reason: string }[] {
    const db = this.store.db;
    const has = (name: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
    const digestActive = new Set(has('digest_requests') ? (db.prepare("SELECT content_id FROM digest_requests WHERE state NOT IN ('failed','cancelled','complete')").all() as { content_id: number }[]).map(row => row.content_id) : []);
    const batchBusyIds = new Set(has('batch_digest_items') ? (db.prepare("SELECT i.content_id FROM batch_digest_items i JOIN batch_digest_runs b ON b.id=i.batch_id WHERE b.state!='complete' AND i.state NOT IN ('complete','candidate','failed','result-unknown','cancelled')").all() as { content_id: number }[]).map(row => row.content_id) : []);
    const laneIds = new Set<number>();
    for (const task of this.laneTasks.values()) laneIds.add(task.type === 'detail' ? task.id : this.store.media(task.id)?.contentId ?? -1);
    const blocked: { contentId: number; reason: string }[] = [];
    for (const content of contents) {
      if (laneIds.has(content.id)) blocked.push({ contentId: content.id, reason: '正在下载或取正文' });
      else if (digestActive.has(content.id)) blocked.push({ contentId: content.id, reason: '正在消化，完成后或取消后可删除' });
      else if (batchBusyIds.has(content.id)) blocked.push({ contentId: content.id, reason: '处理批次未结束' });
    }
    return blocked;
  }
  private deletionBlock(id: number): string | undefined {
    const content = this.store.content(id);
    if (!content) return '收藏不存在';
    return this.deletionBlockedIds([content])[0]?.reason;
  }
  private deletionBlocks(ids: number[]): { id: number; reason: string }[] {
    const blocked: { id: number; reason: string }[] = [];
    for (const id of ids) { const reason = this.store.isDeleted(id) ? '已删除' : this.deletionBlock(id); if (reason) blocked.push({ id, reason }); }
    return blocked;
  }
  deletePreview(ids: number[]): { bytes: number; blocked: { id: number; reason: string }[] } {
    const blocked = this.deletionBlocks(ids);
    return { bytes: this.store.deletePreviewBytes(ids.filter(id => !blocked.some(row => row.id === id))), blocked };
  }
  deleteContents(ids: number[]): { deleted: number[]; blocked: { id: number; reason: string }[]; bytesFreed: number } {
    const blocked = this.deletionBlocks(ids);
    const result = this.store.deleteContents(ids.filter(id => !blocked.some(row => row.id === id)), this.now());
    this.options.evidence?.('content-deleted', { count: result.deleted.length, bytesFreed: result.bytesFreed });
    this.pump();
    return { ...result, blocked };
  }
  deletedContents() { return this.store.deletedContents(); }
  restoreDeleted(id: number): void { this.store.restoreDeleted(id); this.options.evidence?.('content-restored', { contentId: id }); this.pump(); }
  digest(id: number, value: boolean): void {
    if (!this.store.digestPipeline) throw new Error('消化流程尚未启用，不会手动标记为处理完成');
    if (value) this.store.digestPipeline.request(id); else this.store.digestPipeline.removeLibrary(id);
  }
  review(id: number): void { if (this.store.digestPipeline) this.store.digestPipeline.review(id, this.now()); else this.store.review(id, this.now()); }
  retry(id: number,mediaId?:number): void { if(this.recentImport&&!this.recentImport.contains(this.store.content(id)))throw Error('收藏不在本轮同步目标范围'); this.store.retry(id,mediaId); this.preferredContentId = id; this.pump(); }
  retryFailures():number { if(this.recentImport){ const failed=this.store.contents().filter(c=>this.recentImport!.contains(c)&&(c.detailState==='failed'||c.media.some(m=>m.state==='failed')));for(const c of failed)this.store.retry(c.id);this.pump();return failed.length;} const count=this.store.retryFailures();this.pump();return count; }
  autoSync(value: boolean): void { this.store.setSetting('autoSync', String(value)); this.nextCheckAt=value?this.now()+HALF_HOUR:null; if(!value)this.pendingChecks.clear(); }
  setOnline(value: boolean): void {
    const changed = this.online !== value;
    this.online = value;
    if (!value) { if (changed) this.interruptionEpoch++; this.markPending(); this.downloadAbort?.abort(); this.abortTasks(); }
    if (changed && value) this.recover();
  }
  pause(): void { if (!this.paused) this.interruptionEpoch++; this.paused = true; this.markPending(); this.downloadAbort?.abort(); this.abortTasks(); }
  resume(): void { const changed = this.paused; this.paused = false; if (changed) this.recover(); }
  private markPending():void { if(!this.enabled())return; for(const platform of this.adapters.keys()) this.pendingChecks.add(platform); }
  private recover(): void {
    if (!this.canWork()) return;
    this.pump();
    this.drainPending();
  }
  private drainPending():void {
    if(!this.canWork()||!this.enabled())return;
    for(const platform of [...this.pendingChecks]) {
      // Keep the intent while an old collect still owns the source. Its finally
      // drains this set after releasing the mutex, even when it failed offline.
      if(this.busy.has(platform))continue;
      this.pendingChecks.delete(platform);
      void this.sync(platform,'resume');
    }
  }
  async sync(platform?: Platform, trigger:'manual'|'timer'|'resume'='manual'): Promise<void> {
    if (!this.canWork()) { if(this.enabled())this.markPending(); return; }
    if(platform&&!this.adapters.has(platform))throw Error('该平台收藏适配正在接入，登录会话已独立保存；完成接入后再同步');
    const platforms = platform ? [platform] : [...this.adapters.keys()];
    let owned = platforms.filter(p => this.adapters.has(p) && !this.busy.has(p));
    const ongoing = platforms.filter(p => this.busy.has(p)).map(p => this.syncPromises.get(p)).filter((p): p is Promise<void> => !!p);
    for (const p of owned) this.busy.add(p);
    if(owned.length){this.lastCheckAt=this.now();if(trigger==='resume')this.nextCheckAt=this.enabled()?this.now()+HALF_HOUR:null;this.store.setSetting('schedulerLastCheckAt',String(this.lastCheckAt));}
    // Automatic checks leave cooling or hard-paused platforms alone and say
    // so in the sync row; a manual sync still attempts them, and a success
    // resets their cooldown level.
    if(this.recentImport&&trigger!=='manual'){
      const blocked=owned.filter(p=>this.platformBlocked(p));
      for(const p of blocked){
        this.busy.delete(p);
        const id=this.store.startSync(p,this.now(),trigger);
        this.store.finishSync(id,{state:'partial',discovered:0,saved:0,message:`本次自动检查已跳过：${this.blockReason(p)}`,incrementalStatus:'unknown',incrementalReason:'平台处于冷却或暂停'},this.now());
      }
      owned=owned.filter(p=>!blocked.includes(p));
    }
    const run = this.collectBatch(owned,trigger);
    for (const p of owned) this.syncPromises.set(p, run);
    try { await Promise.all([run, ...ongoing]); }
    finally { for (const p of owned) { this.busy.delete(p); this.syncPromises.delete(p); } this.pump(); this.drainPending(); }
  }
  /** E4.7 同步范围：最近一次窗口大小；'all' 读取平台全部收藏历史。 */
  syncRange(): SyncRange {
    const value = this.store.setting('syncRange', '100');
    return value === '10' || value === '30' || value === 'all' ? value : '100';
  }
  setSyncRange(value: SyncRange): void {
    if (!['10', '30', '100', 'all'].includes(value)) throw new Error('同步范围无效');
    this.store.setSetting('syncRange', value);
  }
  private async collectBatch(platforms: Platform[],trigger:'manual'|'timer'|'resume'): Promise<void> {
    const range = this.syncRange();
    const collectOptions = (platform: Platform) => this.recentImport
      ? { expectedAccountId: this.recentImport.expectedAccount(platform), ...(range === 'all' ? { fullHistory: true as const } : { recentLimit: Number(range) }) }
      : undefined;
    const collectTimeout = this.options.collectTimeoutMs ?? (range === 'all' ? 30 * 60_000 : 5 * 60_000);
    const results = await Promise.all(platforms.map(async platform => {
      const id = this.store.startSync(platform, this.now(),trigger);
      try {
        const snapshot = await this.withTimeout(this.adapters.get(platform)!.collect(collectOptions(platform)), collectTimeout);
        if (snapshot.platform !== platform || !snapshot.accountId) throw new Error('Invalid source account');
        this.connectionErrors.delete(platform);
        // E4.7: a mid-collection rate limit keeps the partial snapshot, then the
        // platform cools down — it does not count as a clean success.
        if (this.recentImport) { if (snapshot.limited) this.classifyAndApply(platform, new Error(snapshot.limited), 'collect'); else this.platformSucceeded(platform); }
        return { platform, id, snapshot, items: uniqueItems(snapshot.items) };
      } catch (error) {
        if (!this.closed) {
          const message = safeError(error);
          if (isAuthenticationError(error)) this.connectionErrors.set(platform, {message,at:this.now()});
          if (this.recentImport) this.classifyAndApply(platform, error, 'collect'); else this.sourceFailed(platform, error);
          this.store.finishSync(id, { state: 'failed', failed: 1, message }, this.now());
        }
        return undefined;
      }
    }));
    if (this.closed) return;
    const successful = results.filter((r): r is NonNullable<typeof r> => !!r);
    if(this.recentImport){
      const rangeLine = range === 'all' ? '本次检查全部收藏' : `本次检查最近 ${range} 条`;
      for(const result of successful){
        try{this.store.db.transaction(()=>{
          const target=this.recentImport!.select(result.snapshot,this.now(),range==='all'?'all':Number(range));
          // New-vs-history baseline: a favourite qualifies as "new" only when a
          // prior successful sync exists and its platform favourite time falls
          // inside the last check window (with a 10-minute margin). Older
          // favourites exposed by a widened range stay historical, never "new".
          const previousSyncAt=this.store.lastFinishedSyncStartedAt(result.platform);
          const cutoff=previousSyncAt===undefined?undefined:previousSyncAt-600_000;
          let newCount=0;
          const selected=result.items.filter(item=>target.has(item.sourceId)).map(item=>{
            let discovery:Discovery='historical';
            if(this.store.find(result.platform,result.snapshot.accountId,item.sourceId)===undefined&&cutoff!==undefined){
              if(item.collectedAt==null)discovery='unknown';
              else if(item.collectedAt>=cutoff){discovery='new';newCount++;}
            }
            return {item,discovery};
          });
          const {inserted:saved,skippedDeleted}=this.store.saveSnapshot(result.snapshot,selected,this.now());
          const covered=result.snapshot.target?.complete??result.snapshot.complete;
          const baseline=cutoff===undefined;
          this.store.finishSync(result.id,{state:covered?'succeeded':'partial',discovered:result.items.length,
            deduplicated:selected.length-saved,saved,incrementalStatus:baseline?'baseline':'confirmed',incrementalNew:baseline?0:newCount,
            incrementalReason:baseline?'首次建立本地基线，不计新增':`累计同步范围持续保留；${newCount?`本次新增 ${newCount} 条`:'本次无新增收藏'}`,
            message:`${rangeLine}；${result.snapshot.limited??result.snapshot.target?.reason??(result.snapshot.complete?'已读取到收藏列表末尾':'收藏列表部分覆盖')}${skippedDeleted?`；已跳过已删除 ${skippedDeleted} 条`:''}`},this.now());
        })();}catch(error){this.store.finishSync(result.id,{state:'failed',failed:1,message:safeError(error)},this.now());}
      }
      return;
    }
    // Persisted observations allow quota transfer even when sources are synced in
    // separate manual calls. Baseline-only IDs can fill a later transferred quota,
    // always as historical; they never become newly discovered recommendations.
    let remaining = Math.max(0, 30 - this.store.historicalCount());
    const quotas = new Map<Platform, number>();
    const candidates = new Map<Platform, CollectionItem[]>();
    for (const r of successful) {
      const known = this.store.known(r.platform, r.snapshot.accountId);
      const previous = this.store.account(r.platform, r.snapshot.accountId);
      candidates.set(r.platform, r.items.filter(item => this.store.find(r.platform, r.snapshot.accountId, item.sourceId) === undefined && (!previous || known.has(item.sourceId))));
      const amount = Math.min(Math.max(0, 15 - this.store.historicalCount(r.platform)), candidates.get(r.platform)!.length, remaining);
      quotas.set(r.platform, amount); remaining -= amount;
    }
    for (const r of successful) {
      const peer: Platform = r.platform === 'xiaohongshu' ? 'bilibili' : 'xiaohongshu';
      const currentPeer = successful.find(other => other.platform === peer);
      const peerBaseline = this.store.platformBaseline(peer);
      const peerCapacity = currentPeer ? (currentPeer.snapshot.complete ? currentPeer.items.length : 15) : peerBaseline?.complete ? peerBaseline.observed : 15;
      const allowance = 15 + Math.max(0, 15 - peerCapacity);
      const extra = Math.min(Math.max(0, allowance - this.store.historicalCount(r.platform) - (quotas.get(r.platform) ?? 0)), candidates.get(r.platform)!.length - (quotas.get(r.platform) ?? 0), remaining);
      quotas.set(r.platform, (quotas.get(r.platform) ?? 0) + extra); remaining -= extra;
    }
    for (const r of successful) {
      try {
      this.store.db.transaction(()=>{
      const previous = this.store.account(r.platform, r.snapshot.accountId);
      const known = this.store.known(r.platform, r.snapshot.accountId);
      const incremental=this.incremental(r.snapshot,known);
      let selected: { item: CollectionItem; discovery: Discovery }[];
      const historical = candidates.get(r.platform)!.slice(0, quotas.get(r.platform) ?? 0).map(item => ({ item, discovery: 'historical' as const }));
      if (!previous) selected = historical;
      else selected = [...historical, ...r.items.filter(item => this.store.find(r.platform, r.snapshot.accountId, item.sourceId) !== undefined || !known.has(item.sourceId))
        .map(item => ({ item, discovery: !known.has(item.sourceId) && incremental.newIds.has(item.sourceId) ? 'new' as const : 'unknown' as const }))];
      const {inserted:saved,skippedDeleted} = this.store.saveSnapshot(r.snapshot, selected, this.now());
      const deduplicated = r.snapshot.items.length - r.items.length + r.items.filter(item => known.has(item.sourceId)).length;
      this.store.finishSync(r.id, { state: r.snapshot.complete ? 'succeeded' : 'partial', discovered: r.items.length, deduplicated, saved,incrementalStatus:incremental.status,incrementalNew:incremental.newIds.size,incrementalReason:incremental.reason,
        message: (r.snapshot.complete ? '收藏列表检查完成；正文与媒体进入保存队列' : '历史部分覆盖；已保存已发现项目') + `；${incremental.reason}` + (skippedDeleted ? `；已跳过已删除 ${skippedDeleted} 条` : '') + (r.snapshot.warning ? `。${safeWarning(r.snapshot.warning)}` : '') }, this.now());
      })();
      } catch(error) {
        this.store.finishSync(r.id,{state:'failed',failed:1,message:`收藏保存失败；本次内容与检查点已回滚。${safeError(error)}`,incrementalStatus:'unknown',incrementalReason:'持久化失败，未推进可靠检查点'},this.now());
      }
    }
  }
  private incremental(snapshot:CollectionSnapshot,known:Set<string>):{status:'baseline'|'confirmed'|'unknown';newIds:Set<string>;reason:string} {
    const newIds=new Set<string>();
    // Preserve the existing verified complete-list path. Explicit recent evidence
    // always uses its own checkpoint and never derives one from old observations.
    if(!snapshot.recent){
      const previous=this.store.account(snapshot.platform,snapshot.accountId);
      if(snapshot.platform==='bilibili'&&previous?.complete){for(const item of snapshot.items)if(!known.has(item.sourceId)&&(item.folderIds.length===0||item.folderIds.some(id=>this.store.folderBaseline(snapshot.platform,snapshot.accountId,id))))newIds.add(item.sourceId);
        return {status:'confirmed',newIds,reason:'既有完整账号及收藏夹基线支持本次新增判断'};}
      return {status:'unknown',newIds,reason:'本次新增待确认：来源尚未提供可靠近期顺序'};
    }
    let baseline=false,confirmed=false,uncertain=false;
    const reasons:string[]=[];
    for(const scope of snapshot.recent.scopes){
      if(!this.reliableScope(scope)){uncertain=true;reasons.push(`${scope.scopeId}：头部或连续分页不可靠`);continue;}
      const previous=this.store.checkpoint(snapshot.platform,snapshot.accountId,scope.scopeId);
      if(!previous){
        this.store.saveCheckpoint(snapshot.platform,snapshot.accountId,scope.scopeId,scope.orderedIds,scope,this.now());baseline=true;reasons.push(`${scope.scopeId}：首次可靠头部仅建立基线`);continue;
      }
      const anchor=scope.orderedIds.indexOf(previous[0]);
      const overlap=anchor<0?[]:scope.orderedIds.slice(anchor);
      const length=Math.min(overlap.length,previous.length);
      // A single accidental anchor among a long old checkpoint cannot establish
      // an ordered overlap. Short checkpoints must match their entire sequence.
      const matches=length>=Math.min(2,previous.length)&&overlap.slice(0,length).every((id,i)=>id===previous[i]);
      if(!matches){uncertain=true;reasons.push(`${scope.scopeId}：旧检查点未获得稳定有序重叠，保留旧检查点`);continue;}
      if(scope.orderedIds.slice(0,anchor).some(id=>known.has(id))){
        uncertain=true;reasons.push(`${scope.scopeId}：头部前缀含已知旧内容，顺序发生变化，保留旧检查点`);continue;
      }
      for(const id of scope.orderedIds.slice(0,anchor))if(!known.has(id))newIds.add(id);
      this.store.saveCheckpoint(snapshot.platform,snapshot.accountId,scope.scopeId,scope.orderedIds,scope,this.now());confirmed=true;
    }
    return {status:uncertain?'unknown':confirmed?'confirmed':baseline?'baseline':'unknown',newIds,reason:reasons.join('；')||(confirmed?'本次新增已确认：连续头部与旧检查点有序重叠':'本次新增待确认：无可靠检查点')};
  }
  private reliableScope(scope:RecentScopeEvidence):boolean {
    if(!scope.reliable||scope.sort!=='collection-order'||!scope.orderedIds.length||!scope.pages.length)return false;
    if(!['','0','1'].includes(scope.pages[0].cursor))return false;
    for(let i=0;i<scope.pages.length;i++)if(!scope.pages[i].parsed||(i>0&&scope.pages[i-1].nextCursor!==scope.pages[i].cursor))return false;
    const ordered=scope.pages.flatMap(page=>page.ids);
    return new Set(ordered).size===ordered.length&&ordered.length===scope.orderedIds.length&&ordered.every((id,i)=>id===scope.orderedIds[i]);
  }
  private pump(): void {
    if (this.recentImport) { this.pumpLanes(); return; }
    if (this.queuePromise || !this.canDownload()) return;
    this.queuePromise = this.runQueue().catch(() => { /* Each persisted task has its own error below. */ }).finally(() => {
      this.queuePromise = undefined;
      if (this.canDownload() && (this.nextDetail() || this.nextDownload())) this.pump();
    });
  }
  /** E4.5 batch lanes: at most 6 tasks globally, 1 detail per platform, and
   *  either 2 images or 1 video/audio download per platform. */
  private pumpLanes(): void {
    if (this.lanePumping || !this.canDownload()) return;
    this.lanePumping = true;
    try {
      while (this.canDownload() && this.laneTasks.size < 6) {
        const task = this.pickTask();
        if (!task) break;
        this.startTask(task);
      }
    } finally { this.lanePumping = false; }
  }
  private preferredContent(): ContentRecord | undefined {
    if (this.preferredContentId === undefined) return undefined;
    let preferred = this.store.content(this.preferredContentId);
    if ((this.recentImport && (!this.recentImport.contains(preferred) || !!preferred && this.recentImport.isDownloadPaused(preferred.id))) || !preferred || preferred.detailState === 'failed' || (preferred.detailState === 'succeeded' && preferred.media.every(m => m.state !== 'queued' && m.state !== 'running'))) {
      this.preferredContentId = undefined;
      preferred = undefined;
    }
    return preferred;
  }
  private pickTask(): { platform: Platform; detail?: ContentRecord; media?: MediaRecord & { remoteUrl: string; referer?: string }; av?: boolean } | undefined {
    const platforms = this.recentImport!.state().scopes.map(scope => scope.platform);
    if (!platforms.length) return undefined;
    const detailInFlight = new Set<number>(), mediaInFlight = new Set<number>();
    let globalAv = 0;
    for (const task of this.laneTasks.values()) { if (task.type === 'detail') detailInFlight.add(task.id); else mediaInFlight.add(task.id); if (task.av) globalAv++; }
    const preferred = this.preferredContent();
    const now = this.now();
    for (let i = 0; i < platforms.length; i++) {
      const platform = platforms[(this.laneCursor + i) % platforms.length];
      if (this.platformBlocked(platform)) continue;
      if ((this.laneRestUntil.get(platform) ?? 0) > Date.now()) continue;
      const lane = this.laneState(platform);
      const preferredHere = preferred && preferred.platform === platform && !detailInFlight.has(preferred.id) && !mediaInFlight.has(preferred.media[0]?.id ?? -1) ? preferred : undefined;
      const detail = lane.details < 1
        ? (preferredHere && preferredHere.detailState === 'queued' && this.recentImport!.retryState(`detail:${preferredHere.id}`).nextAt <= now ? preferredHere
          : this.recentImport!.nextDetail({ platform, exclude: detailInFlight, now }))
        : undefined;
      const image = lane.videos === 0 && lane.images < 2 ? this.recentImport!.nextDownload({ platform, preferred: preferredHere?.id, exclude: mediaInFlight, kinds: 'image', now }) : undefined;
      const av = lane.images === 0 && lane.videos === 0 && globalAv < 2 ? this.recentImport!.nextDownload({ platform, preferred: preferredHere?.id, exclude: mediaInFlight, kinds: 'av', now }) : undefined;
      const media = image ?? av;
      const preferMedia = this.lanePreferMedia.get(platform) ?? true;
      const chosen = preferMedia && media ? { media, av: media === av } : detail ? { detail } : media ? { media, av: media === av } : undefined;
      if (!chosen) continue;
      this.lanePreferMedia.set(platform, !preferMedia);
      this.laneCursor = (this.laneCursor + i + 1) % platforms.length;
      return { platform, ...chosen };
    }
    return undefined;
  }
  private readonly lanePreferMedia = new Map<Platform, boolean>();
  private startTask(pick: { platform: Platform; detail?: ContentRecord; media?: MediaRecord & { remoteUrl: string; referer?: string }; av?: boolean }): void {
    const abort = new AbortController();
    if (pick.detail) {
      const key = `d:${pick.detail.id}`;
      this.laneTasks.set(key, { platform: pick.platform, type: 'detail', id: pick.detail.id, av: false, abort });
      void this.runDetailTask(key, pick.detail, abort);
    } else if (pick.media) {
      const key = `m:${pick.media.id}`;
      this.laneTasks.set(key, { platform: pick.platform, type: 'media', id: pick.media.id, av: !!pick.av, abort });
      void this.runMediaTask(key, pick.media, abort);
    }
  }
  private laneTaskDone(platform: Platform, key: string): void {
    this.laneTasks.delete(key);
    // The 250ms politeness delay is per platform lane, not global.
    this.laneRestUntil.set(platform, Date.now() + 250);
    const wake = setTimeout(() => this.pump(), 260);
    wake.unref();
    this.pump();
  }
  private async runDetailTask(key: string, content: ContentRecord, abort: AbortController): Promise<void> {
    const platform = content.platform;
    const epoch = this.interruptionEpoch;
    try {
      await this.checkDiskReserve();
      const adapter = this.adapters.get(platform);
      this.store.detailRunning(content.id);
      if (!adapter) throw new Error('Missing source adapter');
      const detail = await abortable(this.withTimeout(adapter.detail(content, this.recentImport ? { expectedAccountId: content.accountId } : undefined), this.options.detailTimeoutMs ?? 90_000), abort.signal);
      if (this.closed) return;
      this.store.detailSaved(content.id, detail);
      this.platformSucceeded(platform);
      this.recentImport!.clearRetry(`detail:${content.id}`);
    } catch (error) {
      if (!this.closed) {
        if (!this.canWork() || epoch !== this.interruptionEpoch || abort.signal.aborted) this.store.detailRequeue(content.id);
        else this.classifyAndApply(platform, error, 'detail', { contentId: content.id });
      }
    } finally { this.laneTaskDone(platform, key); }
  }
  private async runMediaTask(key: string, media: MediaRecord & { remoteUrl: string; referer?: string }, abort: AbortController): Promise<void> {
    const owner = this.store.content(media.contentId)!;
    const platform = owner.platform;
    const epoch = this.interruptionEpoch;
    const temporaryPath = path.join(this.store.mediaDir, `${media.id}.part`);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // Video/audio transfers get a longer idle budget than images.
    const idleMs = media.kind !== 'image' ? 120_000 : (this.options.downloadIdleMs && Number.isFinite(this.options.downloadIdleMs) && this.options.downloadIdleMs > 0 ? this.options.downloadIdleMs : 60_000);
    const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
    const resetIdle = () => { clearIdle(); idleTimer = setTimeout(() => { timedOut = true; abort.abort(new Error('DOWNLOAD_IDLE_TIMEOUT')); }, idleMs); };
    try {
      await this.checkDiskReserve();
      this.store.downloadRunning(media.id);
      const adapter = this.adapters.get(platform);
      if (!adapter?.verifyAccount) throw Error('本轮来源缺少账号核验能力');
      await adapter.verifyAccount(owner.accountId);
      const remote = new URL(media.remoteUrl);
      if (!['https:', 'http:'].includes(remote.protocol)) throw new Error('Unsupported media protocol');
      resetIdle();
      const response = await abortable(this.fetcher(media.remoteUrl, { headers: media.referer ? { Referer: media.referer } : undefined, signal: abort.signal }, platform), abort.signal);
      resetIdle();
      if (!response.ok || response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || media.mime;
      if (/text\/html|application\/json/.test(mime)) throw new Error('Unexpected media response');
      let bytesSinceDiskCheck = 0;
      const progress = new Transform({ transform: (chunk, _encoding, callback) => { resetIdle(); bytesSinceDiskCheck += chunk.length; if (this.recentImport && bytesSinceDiskCheck >= 16 * 1024 * 1024) { bytesSinceDiskCheck = 0; void this.checkDiskReserve().then(() => callback(null, chunk), error => callback(error)); } else callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), progress, createWriteStream(temporaryPath), { signal: abort.signal });
      clearIdle();
      const bytes = (await stat(temporaryPath)).size;
      const expected = Number(response.headers.get('content-length'));
      if (!bytes || (expected > 0 && bytes !== expected)) throw new Error('Incomplete media response');
      const extension = mime.includes('jpeg') ? '.jpg' : mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : mime.includes('video') ? '.mp4' : mime.includes('audio') ? '.m4a' : '.bin';
      const fileName = `${media.id}${extension}`;
      await rename(temporaryPath, path.join(this.store.mediaDir, fileName));
      if (!this.closed) this.store.downloadSaved(media.id, fileName, bytes, mime);
      this.platformSucceeded(platform);
      this.recentImport!.clearRetry(`media:${media.id}`);
      this.recentImport!.clearRetry(`refresh:${media.id}`);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!this.closed) {
        if (!this.canDownload() || epoch !== this.interruptionEpoch || (abort.signal.aborted && !timedOut)) this.store.db.prepare("UPDATE media SET state='queued',error=NULL WHERE id=?").run(media.id);
        else this.classifyAndApply(platform, timedOut ? new Error(`下载等待数据超时（连续 ${Math.round(idleMs / 1000)} 秒未收到数据），请重试以刷新资源地址`) : error, 'media', { contentId: media.contentId, mediaId: media.id });
      }
    } finally { clearIdle(); this.laneTaskDone(platform, key); }
  }
  private requeueItem(phase: FailurePhase, item: { contentId: number; mediaId?: number }): void {
    if (phase === 'media' && item.mediaId !== undefined) this.store.db.prepare("UPDATE media SET state='queued',error=NULL WHERE id=? AND state='running'").run(item.mediaId);
    else this.store.detailRequeue(item.contentId);
  }
  private failItem(phase: FailurePhase, item: { contentId: number; mediaId?: number }, message: string): void {
    if (phase === 'media' && item.mediaId !== undefined) this.store.downloadFailed(item.mediaId, message);
    else this.store.detailFailed(item.contentId, message);
  }
  /** E4.5 failure routing: expired URLs refresh details, rate-limits cool the
   *  platform, auth problems hard-pause, transients retry the item. */
  private classifyAndApply(platform: Platform, error: unknown, phase: FailurePhase, item?: { contentId: number; mediaId?: number }): void {
    const kind = classifyFailure(error, phase);
    if (kind === 'expired-url' && item?.mediaId !== undefined) {
      const refreshKey = `refresh:${item.mediaId}`;
      const { attempts } = this.recentImport!.retryState(refreshKey);
      this.requeueItem('media', item);
      if (attempts < MAX_EXPIRED_REFRESHES) {
        this.recentImport!.recordRetry(refreshKey, attempts + 1, 0);
        // store.retry requeues the detail; detailSaved refreshes the signed
        // media URLs and keeps any files that are still valid.
        this.store.retry(item.contentId);
        this.pump();
        return;
      }
      this.cooldown(platform, '资源地址多次刷新后仍无法访问，平台可能限流');
      return;
    }
    if (kind === 'rate-limit') { if (item) this.requeueItem(phase, item); this.cooldown(platform, safeError(error)); return; }
    if (kind === 'auth') { if (item) this.requeueItem(phase, item); this.connectionErrors.set(platform, { message: safeError(error), at: this.now() }); this.hardPause(platform, 'auth', '登录失效，请在设置中重新登录后重试'); return; }
    if (kind === 'account-changed') { if (item) this.requeueItem(phase, item); this.hardPause(platform, 'account-changed', '当前登录的不是本批次账号，请切回原账号'); return; }
    if (kind === 'permanent') { if (item) this.failItem(phase, item, safeError(error)); return; }
    this.transientStreak(platform);
    if (item) {
      const key = `${phase}:${phase === 'detail' ? item.contentId : item.mediaId}`;
      const { attempts } = this.recentImport!.retryState(key);
      if (attempts + 1 >= MAX_TRANSIENT_ATTEMPTS) { this.recentImport!.clearRetry(key); this.failItem(phase, item, `${safeError(error)}（已自动重试 ${attempts + 1} 次）`); return; }
      this.recentImport!.recordRetry(key, attempts + 1, this.now() + TRANSIENT_BACKOFF_MS[attempts]);
      this.requeueItem(phase, item);
    }
  }
  private withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TIMEOUT：等待来源响应超过 ${Math.round(ms / 1000)} 秒`)), ms);
      operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  private async runQueue(): Promise<void> {
    while (this.canDownload()) {
      try { await this.checkDiskReserve(); } catch { return; }
      let preferred = this.preferredContentId === undefined ? undefined : this.store.content(this.preferredContentId);
      if ((this.recentImport && (!this.recentImport.contains(preferred) || !!preferred && this.recentImport.isDownloadPaused(preferred.id))) || !preferred || preferred.detailState === 'failed' || (preferred.detailState === 'succeeded' && preferred.media.every(m => m.state !== 'queued' && m.state !== 'running'))) {
        this.preferredContentId = undefined;
        preferred = undefined;
      }
      const queuedMedia = this.nextDownload(preferred?.id);
      const preferredDetail = preferred?.detailState === 'queued' ? preferred : undefined;
      const content = preferredDetail ?? ((queuedMedia && (this.preferMedia || queuedMedia.contentId === preferred?.id)) ? undefined : this.nextDetail());
      if (content) {
        // One detail alternates with one resource. Slow later source pages cannot
        // leave every already discovered image waiting behind all other details.
        this.preferMedia = true;
        const epoch = this.interruptionEpoch;
        const adapter = this.adapters.get(content.platform);
        this.store.detailRunning(content.id);
        try {
          if (!adapter) throw new Error('Missing source adapter');
          const detail = await adapter.detail(content,this.recentImport?{expectedAccountId:content.accountId}:undefined);
          if (this.closed) return;
          this.store.detailSaved(content.id, detail);
          this.sourceFailures.delete(content.platform);
        } catch (error) {
          if (this.closed) return;
          if (!this.canWork() || epoch !== this.interruptionEpoch) { this.store.detailRequeue(content.id); continue; }
          const message = safeError(error);
          this.store.detailFailed(content.id, message);
          this.sourceFailed(content.platform,error);
          if (isAuthenticationError(error)) this.connectionErrors.set(content.platform, {message,at:this.now()});
        }
        if(this.recentImport)await new Promise(resolve=>setTimeout(resolve,250));
        continue;
      }
      const media = queuedMedia;
      if (!media) return;
      const owner = this.store.content(media.contentId)!;
      const temporaryPath = path.join(this.store.mediaDir, `${media.id}.part`);
      this.store.downloadRunning(media.id);
      const abort = new AbortController();
      this.downloadAbort = abort;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const idleMs = this.options.downloadIdleMs && Number.isFinite(this.options.downloadIdleMs) && this.options.downloadIdleMs > 0 ? this.options.downloadIdleMs : 60_000;
      const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
      const resetIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => { timedOut = true; abort.abort(new Error('DOWNLOAD_IDLE_TIMEOUT')); }, idleMs);
      };
      try {
        if(this.recentImport){const adapter=this.adapters.get(owner.platform);if(!adapter?.verifyAccount)throw Error('本轮来源缺少账号核验能力');await adapter.verifyAccount(owner.accountId);}
        const remote = new URL(media.remoteUrl);
        if (!['https:', 'http:'].includes(remote.protocol)) throw new Error('Unsupported media protocol');
        resetIdle();
        const response = await abortable(this.fetcher(media.remoteUrl, { headers: media.referer ? { Referer: media.referer } : undefined, signal: abort.signal }, owner.platform), abort.signal);
        resetIdle();
        if (!response.ok || response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || media.mime;
        if (/text\/html|application\/json/.test(mime)) throw new Error('Unexpected media response');
        let bytesSinceDiskCheck=0;
        const progress = new Transform({ transform: (chunk, _encoding, callback) => { resetIdle(); bytesSinceDiskCheck+=chunk.length; if(this.recentImport&&bytesSinceDiskCheck>=16*1024*1024){bytesSinceDiskCheck=0;void this.checkDiskReserve().then(()=>callback(null,chunk),error=>callback(error));}else callback(null,chunk); } });
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), progress, createWriteStream(temporaryPath), { signal: abort.signal });
        clearIdle();
        const bytes = (await stat(temporaryPath)).size;
        const expected = Number(response.headers.get('content-length'));
        if (!bytes || (expected > 0 && bytes !== expected)) throw new Error('Incomplete media response');
        const extension = mime.includes('jpeg') ? '.jpg' : mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : mime.includes('video') ? '.mp4' : mime.includes('audio') ? '.m4a' : '.bin';
        const fileName = `${media.id}${extension}`;
        await rename(temporaryPath, path.join(this.store.mediaDir, fileName));
        if (!this.closed) this.store.downloadSaved(media.id, fileName, bytes, mime);
        this.sourceFailures.delete(owner.platform);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        if (this.closed) return;
        this.sourceFailed(owner.platform,error);
        if (!this.canDownload()) this.store.db.prepare("UPDATE media SET state='queued',error=NULL WHERE id=?").run(media.id);
        else if (timedOut) this.store.downloadFailed(media.id, `下载等待数据超时（连续 ${Math.round(idleMs / 1000 * 100) / 100} 秒未收到数据），请重试以刷新资源地址`);
        else if (abort.signal.aborted) this.store.db.prepare("UPDATE media SET state='queued',error=NULL WHERE id=?").run(media.id);
        else this.store.downloadFailed(media.id, safeError(error));
      } finally { clearIdle(); this.downloadAbort = undefined; this.preferMedia = false; }
    }
  }
  /** Test/diagnostics helper. Waits until current metadata and file queues settle. */
  async waitForIdle(): Promise<void> {
    while(this.syncPromises.size) await Promise.all([...this.syncPromises.values()]);
    this.pump();
    if (!this.recentImport) { while (this.queuePromise) await this.queuePromise; return; }
    // Lanes briefly rest between tasks; keep waiting while an unblocked
    // platform still has queued work.
    const pending = () => this.recentImport!.state().scopes.some(scope => !this.platformBlocked(scope.platform)
      && (this.recentImport!.nextDetail({ platform: scope.platform, now: this.now() }) || this.recentImport!.nextDownload({ platform: scope.platform, now: this.now() })));
    for (let i = 0; i < 10_000 && (this.laneTasks.size || pending()); i++) {
      if (!this.laneTasks.size && !this.canDownload()) break;
      await new Promise(resolve => setTimeout(resolve, 20));
      this.pumpLanes();
    }
  }
  close(): void {
    if (this.closed) return;
    clearInterval(this.timer);
    this.closed = true;
    this.downloadAbort?.abort();
    this.abortTasks();
    this.store.close();
  }
}
