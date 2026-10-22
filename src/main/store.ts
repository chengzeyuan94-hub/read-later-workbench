import Database from 'better-sqlite3';
import { DigestRepository } from './digest-store.js';
import { EditorRepository,migrateEditorSchema } from './editor-store.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { sha256File } from './editor-media.js';
import path from 'node:path';
import type { CollectionItem, CollectionSnapshot, ContentRecord, DetailResult, MediaRecord, Platform, SyncRecord } from '../shared/contracts.js';

type Row = Record<string, any>;
export type Discovery = ContentRecord['discovery'];
function kindWithKnownMedia(kind: ContentRecord['kind'], mediaKinds: string[]): ContentRecord['kind'] {
  if (kind === 'video' || mediaKinds.includes('video')) return 'video';
  if (kind === 'audio' || mediaKinds.includes('audio')) return 'audio';
  return kind === 'image' || mediaKinds.includes('image') ? 'image' : 'text';
}

/** URL is a location, never the primary identity. Legacy fallback retains only
 * semantic rendition parameters; CDN host and request authentication are ignored. */
function legacyLocation(value: string): string {
  try {
    const url = new URL(value);
    const stable = ['cid', 'id', 'quality', 'qn', 'format', 'codec', 'version'];
    return url.pathname + '?' + stable.filter(k => url.searchParams.has(k)).map(k => `${k}=${url.searchParams.get(k)}`).join('&');
  } catch { return value; }
}
function identity(m: DetailResult['media'][number]): string {
  return `${m.resourceKey ?? `${m.kind}:${m.sourceIdentity ?? legacyLocation(m.remoteUrl)}`}|version=${m.version ?? 'original'}`;
}

/** One-time adoption of the exact superseded XHS path-hash key format.
 * This does not loosen identity matching for current versions or other sources. */
function adoptLegacyXhsVideo(owner:Row,old:Row,incoming:DetailResult['media'][number]):boolean {
  if(owner.platform!=='xiaohongshu'||old.kind!=='video'||incoming.kind!=='video'||old.mime!=='video/mp4'||incoming.mime!=='video/mp4')return false;
  const prefix=`xiaohongshu:${owner.source_id}:video:`;
  const oldVersion=String(old.resource_version??'');
  if(old.resource_key!==`${prefix}${oldVersion}|version=${oldVersion}`)return false;
  const prior=/^(.*):(\d+)x(\d+):(\d+):([a-f0-9]{24})$/i.exec(oldVersion);
  const next=/^(.*):(\d+)x(\d+):(\d+):[^:]+:mp4:[^:]+:(video|asset):([a-f0-9]{24})$/i.exec(incoming.version??'');
  if(!prior||!next||![1,2,3,4].every(index=>prior[index].toLowerCase()===next[index].toLowerCase()))return false;
  // Missing/opaque codec and rendition metadata cannot establish compatibility.
  if(!/^(?:h\.?264|h\.?265|hevc|avc[13](?:\.[a-z0-9]+)?|avc|vp9|av1)$/i.test(prior[1])||[2,3,4].some(index=>Number(prior[index])<=0))return false;
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
  let pathname:string;try{pathname=new URL(old.remote_url).pathname;}catch{return false;}
  if(digest(pathname)!==prior[5])return false;
  if(incoming.resourceKey!==`${prefix}${incoming.version}`)return false;
  const sourcePrefix=`note:${owner.source_id}:video:`;
  const oldIdentity=String(old.source_identity??'');
  const oldSuffix=oldIdentity.startsWith(sourcePrefix)?oldIdentity.slice(sourcePrefix.length):'';
  const hasReliableOldId=!!oldSuffix&&!/^[a-f0-9]{24}$/i.test(oldSuffix);
  if(hasReliableOldId && (incoming.sourceIdentity!==oldIdentity||next[5]!=='video'||digest(oldSuffix)!==next[6]))return false;
  // Early descriptors accidentally stored a path hash instead of a videoId.
  // Those can only adopt at the same canonical location and exact rendition.
  const sameLocation=legacyLocation(old.remote_url)===legacyLocation(incoming.remoteUrl);
  return sameLocation||(hasReliableOldId&&incoming.sourceIdentity===oldIdentity);
}

/** One database per application userData. Never reads an old workbench database. */
export class Store {
  readonly db: Database.Database;
  readonly mediaDir: string;
  readonly editor?: EditorRepository;
  readonly digestPipeline?: DigestRepository;
  constructor(readonly dataDir: string, options: {editorEnabled?:boolean;ocrEnabled?:boolean;asrEnabled?:boolean;generationEnabled?:boolean;editorAssetsDir?:string} = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.mediaDir = path.join(dataDir, 'media');
    mkdirSync(this.mediaDir, { recursive: true });
    const candidate = process.env.RLW_SQLITE_BINDING || path.resolve('.runtime', process.versions.electron ? 'electron.node' : 'node24.node');
    this.db = new Database(path.join(dataDir, 'workbench.sqlite'), existsSync(candidate) ? { nativeBinding: candidate } : {});
    if(options.ocrEnabled&&!options.editorEnabled||options.asrEnabled&&(!options.ocrEnabled||!options.editorEnabled)||options.generationEnabled&&(!options.asrEnabled||!options.ocrEnabled||!options.editorEnabled)){this.db.close();throw new Error('文字提取需要显式启用编辑存储');}if(options.generationEnabled&&Number(this.db.pragma('user_version',{simple:true}))!==10){this.db.close();throw new Error('阅读创作需要明确准备的schema10副本');}if(Number(this.db.pragma('user_version',{simple:true}))>(options.generationEnabled?10:options.asrEnabled?8:options.ocrEnabled?7:6)){this.db.close();throw new Error('数据版本高于本应用支持版本，拒绝降级打开');}
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (platform TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL, baseline_complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(platform, account_id));
      CREATE TABLE IF NOT EXISTS folders (platform TEXT NOT NULL, account_id TEXT NOT NULL, folder_id TEXT NOT NULL, title TEXT NOT NULL, baseline_complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(platform, account_id, folder_id));
      CREATE TABLE IF NOT EXISTS observed (platform TEXT NOT NULL, account_id TEXT NOT NULL, source_id TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY(platform, account_id, source_id));
      CREATE TABLE IF NOT EXISTS folder_observed (platform TEXT NOT NULL, account_id TEXT NOT NULL, folder_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(platform, account_id, folder_id, source_id));
      CREATE TABLE IF NOT EXISTS contents (
        id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT NOT NULL, author TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL,
        published_at INTEGER, collected_at INTEGER, first_discovered_at INTEGER NOT NULL, discovery TEXT NOT NULL,
        source_body TEXT NOT NULL DEFAULT '', edited_body TEXT, body_complete INTEGER NOT NULL DEFAULT 0,
        subtitle TEXT NOT NULL DEFAULT '', detail_state TEXT NOT NULL DEFAULT 'queued', detail_error TEXT,
        digested_at INTEGER, last_reviewed_at INTEGER, UNIQUE(platform, account_id, source_id));
      CREATE TABLE IF NOT EXISTS content_folders (content_id INTEGER NOT NULL REFERENCES contents(id), folder_id TEXT NOT NULL, PRIMARY KEY(content_id, folder_id));
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY, content_id INTEGER NOT NULL REFERENCES contents(id), kind TEXT NOT NULL,
        remote_url TEXT NOT NULL, referer TEXT, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        state TEXT NOT NULL DEFAULT 'queued', local_path TEXT, bytes INTEGER NOT NULL DEFAULT 0, error TEXT,
        UNIQUE(content_id, remote_url));
      CREATE TABLE IF NOT EXISTS syncs (
        id INTEGER PRIMARY KEY, platform TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        state TEXT NOT NULL DEFAULT 'running', discovered INTEGER NOT NULL DEFAULT 0, deduplicated INTEGER NOT NULL DEFAULT 0,
        saved INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS content_discovery ON contents(discovery, first_discovered_at);
      CREATE INDEX IF NOT EXISTS media_queue ON media(state);
      CREATE TABLE IF NOT EXISTS content_deletions (
        content_id INTEGER PRIMARY KEY REFERENCES contents(id),
        deleted_at INTEGER NOT NULL, bytes_freed INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS pending_file_deletions (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_favorite_order (
        content_id INTEGER PRIMARY KEY REFERENCES contents(id),
        rank REAL NOT NULL);

    `);
    this.migrate();
    if(options.editorEnabled){try{if(!((options.asrEnabled&&Number(this.db.pragma('user_version',{simple:true}))===8)||(options.generationEnabled&&Number(this.db.pragma('user_version',{simple:true}))===10)))migrateEditorSchema(this.db,dataDir,{targetVersion:options.ocrEnabled?7:6});this.editor=new EditorRepository(this.db,dataDir,options.editorAssetsDir);this.digestPipeline=new DigestRepository(this.db,dataDir,this.editor);}catch(error){this.db.close();throw error;}}
    this.db.prepare("UPDATE contents SET detail_state='queued', detail_error=NULL,repair_state=CASE WHEN repair_state='running' THEN 'queued' ELSE repair_state END WHERE detail_state='running'").run();
    this.db.prepare("UPDATE media SET state='queued', local_path=NULL, bytes=0, error=NULL WHERE state='running'").run();
    this.db.prepare("UPDATE syncs SET state='failed', finished_at=?, message='应用退出时采集被中断，请重新同步', failed=failed+1 WHERE state='running'").run(Date.now());
    this.processPendingDeletions();
  }
  /** Roots local deletion may unlink inside. Everything else is refused. */
  private deletionRoots(): string[] {
    return [this.mediaDir, this.editor?.assetsDir ?? path.join(this.dataDir, 'editor-assets'),
      path.join(this.dataDir, 'digest-inputs'), path.join(this.dataDir, 'digest-results'),
      path.join(this.dataDir, 'asr-results'), path.join(this.dataDir, 'asr-prepared'),
      path.join(this.dataDir, 'generation-results')].map(dir => path.resolve(dir));
  }
  private guardedPurgePath(file: string): string {
    const resolved = path.resolve(file);
    if (!this.deletionRoots().some(root => resolved === root || resolved.startsWith(root + path.sep))) throw new Error('待删除文件路径超出数据目录范围');
    return resolved;
  }
  /** Crash recovery: a committed purge keeps its file list until unlinked. */
  private processPendingDeletions(): void {
    for (const row of this.db.prepare('SELECT path FROM pending_file_deletions').all() as Row[]) {
      try { rmSync(this.guardedPurgePath(String(row.path)), { recursive: true, force: true }); } catch { /* out-of-root or unreadable: drop the row, never unlink */ }
      this.db.prepare('DELETE FROM pending_file_deletions WHERE path=?').run(row.path);
    }
  }
  /** E4.6 deleted-content exclusion. One predicate, shared by every list/queue query. */
  private static readonly NOT_DELETED = "NOT EXISTS (SELECT 1 FROM content_deletions d WHERE d.content_id=contents.id)";
  deletedIds(): Set<number> { return new Set((this.db.prepare('SELECT content_id FROM content_deletions').all() as Row[]).map(row => Number(row.content_id))); }
  deletedContents(): { contentId: number; title: string; platform: string; accountId: string; sourceId: string; deletedAt: number; bytesFreed: number }[] {
    return (this.db.prepare(`SELECT d.content_id,d.deleted_at,d.bytes_freed,d.title,d.platform,d.source_id,c.account_id
      FROM content_deletions d JOIN contents c ON c.id=d.content_id ORDER BY d.deleted_at DESC`).all() as Row[])
      .map(row => ({ contentId: row.content_id, title: row.title, platform: row.platform, accountId: row.account_id, sourceId: row.source_id, deletedAt: row.deleted_at, bytesFreed: row.bytes_freed }));
  }
  isDeleted(id: number): boolean { return !!this.db.prepare('SELECT 1 FROM content_deletions WHERE content_id=?').get(id); }
  /** 重新导入：tombstone removed; the next queue pass re-fetches body and media.
   * Notes and AI results are gone for good. */
  restoreDeleted(id: number): void {
    this.db.transaction(() => {
      if (!this.db.prepare('DELETE FROM content_deletions WHERE content_id=?').run(id).changes) throw new Error('该收藏未被删除');
      this.db.prepare("UPDATE contents SET detail_state='queued',detail_error=NULL WHERE id=?").run(id);
      const itemKeys = [`detail:${id}`];
      for (const row of this.db.prepare('SELECT id FROM media WHERE content_id=?').all(id) as Row[]) itemKeys.push(`media:${row.id}`, `refresh:${row.id}`);
      const cleanup = this.db.prepare('DELETE FROM recent_import_item_retries WHERE item_key=?');
      for (const key of itemKeys) try { cleanup.run(key); } catch { /* table may not exist before batch init */ }
      this.db.prepare('DELETE FROM recent_import_download_pauses WHERE content_id=?').run(id);
    })();
  }
  /** Files a purge of `id` would unlink, honouring refcounts on shared stores. */
  deletionPlan(id: number): string[] {
    const db = this.db, files = new Set<string>();
    const has = (name: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
    const add = (root: string, rel: string | null | undefined) => { if (rel) files.add(this.guardedPurgePath(path.join(root, rel))); };
    const mediaRows = db.prepare('SELECT id,local_path FROM media WHERE content_id=?').all(id) as Row[];
    for (const m of mediaRows) {
      // media file names are per-row unique, but legacy rows may share a path.
      if (m.local_path && !db.prepare('SELECT 1 FROM media WHERE content_id!=? AND local_path=? LIMIT 1').get(id, m.local_path)) add(this.mediaDir, m.local_path);
      files.add(this.guardedPurgePath(path.join(this.mediaDir, `${m.id}.part`)));
      // Cached thumbnails are keyed <mediaId>-<size>-<mtime>-w<width>.jpg.
      const thumbsDir = path.join(this.mediaDir, '.thumbs');
      try { for (const file of readdirSync(thumbsDir)) if (file.startsWith(`${m.id}-`)) files.add(this.guardedPurgePath(path.join(thumbsDir, file))); } catch { /* no thumbs yet */ }
    }
    for (const request of (has('digest_requests') ? db.prepare('SELECT id FROM digest_requests WHERE content_id=?').all(id) : []) as Row[])
      files.add(this.guardedPurgePath(path.join(this.dataDir, 'digest-results', String(request.id))));
    // digest-inputs are FICLONE copies keyed by the media file's sha; drop only
    // when no other content's frozen scope still names the same input file.
    for (const m of mediaRows) {
      if (!m.local_path) continue;
      const source = this.guardedPurgePath(path.join(this.mediaDir, m.local_path));
      if (!existsSync(source)) continue;
      const relative = `${sha256File(source)}${path.extname(m.local_path) || '.bin'}`;
      const candidate = path.join(this.dataDir, 'digest-inputs', relative);
      if (existsSync(candidate)
        && !(has('digest_requests') && db.prepare("SELECT 1 FROM digest_requests WHERE content_id!=? AND scope_json LIKE '%'||?||'%' LIMIT 1").get(id, relative))) files.add(this.guardedPurgePath(candidate));
    }
    const workspaces = (has('editor_workspaces') ? db.prepare('SELECT id FROM editor_workspaces WHERE content_id=?').all(id) : []) as Row[];
    const assetsDir = this.editor?.assetsDir ?? path.join(this.dataDir, 'editor-assets');
    for (const workspace of workspaces) {
      for (const asset of db.prepare('SELECT json FROM editor_assets WHERE workspace_id=?').all(workspace.id) as Row[]) {
        let relative = ''; try { relative = String(JSON.parse(asset.json).relativePath ?? ''); } catch { continue; }
        if (relative && !db.prepare("SELECT 1 FROM editor_assets WHERE workspace_id!=? AND json LIKE '%'||?||'%' LIMIT 1").get(workspace.id, relative)) add(assetsDir, relative);
      }
    }
    const genDir = path.join(this.dataDir, 'generation-results');
    const genRequests = (has('generation_requests') ? db.prepare('SELECT request_id FROM generation_requests WHERE content_id=?').all(id) : []) as Row[];
    for (const request of genRequests) {
      for (const task of db.prepare('SELECT result_path FROM generation_tasks WHERE request_id=? AND result_path IS NOT NULL').all(request.request_id) as Row[])
        if (!db.prepare('SELECT 1 FROM generation_tasks WHERE request_id!=? AND result_path=? LIMIT 1').get(request.request_id, task.result_path)
          && !db.prepare('SELECT 1 FROM generation_cache WHERE file_path=? LIMIT 1').get(task.result_path)) add(genDir, task.result_path);
      for (const artifact of db.prepare('SELECT base_path FROM generation_artifacts WHERE request_id=?').all(request.request_id) as Row[]) add(genDir, artifact.base_path);
    }
    if (has('generation_markdown_projections'))
      for (const workspace of workspaces)
        for (const row of db.prepare('SELECT file_path FROM generation_markdown_projections WHERE workspace_id=?').all(workspace.id) as Row[])
          if (!db.prepare('SELECT 1 FROM generation_markdown_projections WHERE workspace_id!=? AND file_path=? LIMIT 1').get(workspace.id, row.file_path)) add(genDir, row.file_path);
    if (has('asr_results')) {
      const asrDir = path.join(this.dataDir, 'asr-results');
      for (const row of db.prepare('SELECT file_path FROM asr_results WHERE content_id=?').all(id) as Row[])
        if (!db.prepare('SELECT 1 FROM asr_results WHERE content_id!=? AND file_path=? LIMIT 1').get(id, row.file_path)) add(asrDir, row.file_path);
      for (const row of db.prepare('SELECT file_path FROM asr_corrections WHERE result_id IN (SELECT id FROM asr_results WHERE content_id=?)').all(id) as Row[])
        if (!db.prepare('SELECT 1 FROM asr_corrections WHERE result_id NOT IN (SELECT id FROM asr_results WHERE content_id=?) AND file_path=? LIMIT 1').get(id, row.file_path)) add(asrDir, row.file_path);
    }
    if (has('asr_media_jobs')) for (const job of db.prepare('SELECT id FROM asr_media_jobs WHERE content_id=?').all(id) as Row[])
      files.add(this.guardedPurgePath(path.join(this.dataDir, 'asr-prepared', String(job.id))));
    return [...files];
  }
  /** Soft-delete rows + queue their files for unlink. Audit/budget ledgers stay.
   *  FK is paused inside this transaction: kept ledgers may still reference a
   *  purged digest_requests / ocr_jobs row, which is the intended audit trail. */
  private purgeContentRows(id: number, now: number): string[] {
    const db = this.db;
    const has = (name: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
    const ids = (table: string, column: string) => has(table) ? (db.prepare(`SELECT ${column} AS value FROM ${table} WHERE content_id=?`).all(id) as Row[]).map(row => String(row.value)) : [];
    const requests = ids('digest_requests', 'id');
    const genRequests = ids('generation_requests', 'request_id');
    const workspaces = ids('editor_workspaces', 'id');
    const auths = ids('asr_authorizations', 'request_id');
    const mediaIds = (db.prepare('SELECT id FROM media WHERE content_id=?').all(id) as Row[]).map(row => Number(row.id));
    const list = (values: (string | number)[]) => `(${values.map(() => '?').join(',')})`;
    const files = this.deletionPlan(id);
    const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
    if (genRequests.length) {
      if (has('generation_tasks')) run(`DELETE FROM generation_tasks WHERE request_id IN ${list(genRequests)}`, ...genRequests);
      if (has('generation_artifacts')) run(`DELETE FROM generation_artifacts WHERE request_id IN ${list(genRequests)}`, ...genRequests);
    }
    if (has('generation_adoptions')) run('DELETE FROM generation_adoptions WHERE content_id=?', id);
    if (has('generation_adoption_undos')) run('DELETE FROM generation_adoption_undos WHERE content_id=?', id);
    if (has('generation_edit_leases')) run('DELETE FROM generation_edit_leases WHERE content_id=?', id);
    if (has('generation_editor_meta')) run('DELETE FROM generation_editor_meta WHERE content_id=?', id);
    if (has('generation_requests')) run('DELETE FROM generation_requests WHERE content_id=?', id);
    if (workspaces.length) {
      if (has('generation_body_refs')) run(`DELETE FROM generation_body_refs WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      if (has('generation_markdown')) run(`DELETE FROM generation_markdown WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      if (has('generation_markdown_projections')) run(`DELETE FROM generation_markdown_projections WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
    }
    if (auths.length && has('asr_chunks')) {
      run(`DELETE FROM asr_chunks WHERE request_id IN ${list(auths)}`, ...auths);
      if (has('asr_media_jobs')) run(`DELETE FROM asr_media_jobs WHERE request_id IN ${list(auths)}`, ...auths);
    }
    if (has('asr_media_jobs')) {
      if (has('asr_chunks')) run('DELETE FROM asr_chunks WHERE media_job_id IN (SELECT id FROM asr_media_jobs WHERE content_id=?)', id);
      run('DELETE FROM asr_media_jobs WHERE content_id=?', id);
    }
    if (has('asr_authorizations')) run('DELETE FROM asr_authorizations WHERE content_id=?', id);
    if (has('asr_results')) {
      if (has('asr_adoptions')) run('DELETE FROM asr_adoptions WHERE result_id IN (SELECT id FROM asr_results WHERE content_id=?)', id);
      if (has('asr_corrections')) run('DELETE FROM asr_corrections WHERE result_id IN (SELECT id FROM asr_results WHERE content_id=?)', id);
      run('DELETE FROM asr_results WHERE content_id=?', id);
    }
    if (requests.length && has('asr_pipeline_inputs')) run(`DELETE FROM asr_pipeline_inputs WHERE request_id IN ${list(requests)}`, ...requests);
    if (has('ocr_results')) {
      if (has('ocr_adoptions')) run('DELETE FROM ocr_adoptions WHERE result_id IN (SELECT result_id FROM ocr_results WHERE content_id=?)', id);
      if (has('ocr_corrections')) run('DELETE FROM ocr_corrections WHERE result_id IN (SELECT result_id FROM ocr_results WHERE content_id=?)', id);
      run('DELETE FROM ocr_results WHERE content_id=?', id);
    }
    if (has('ocr_jobs')) run('DELETE FROM ocr_jobs WHERE content_id=?', id);
    if (requests.length) {
      if (has('ocr_pipeline_inputs')) run(`DELETE FROM ocr_pipeline_inputs WHERE request_id IN ${list(requests)}`, ...requests);
      run(`DELETE FROM digest_stages WHERE request_id IN ${list(requests)}`, ...requests);
      run(`DELETE FROM digest_candidates WHERE request_id IN ${list(requests)}`, ...requests);
    }
    if (has('digest_library')) run('DELETE FROM digest_library WHERE content_id=?', id);
    if (has('digest_requests')) run('DELETE FROM digest_requests WHERE content_id=?', id);
    if (workspaces.length) {
      if (has('editor_assets')) run(`DELETE FROM editor_assets WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      if (has('editor_transcripts')) run(`DELETE FROM editor_transcripts WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      if (has('editor_sources')) run(`DELETE FROM editor_sources WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      if (has('editor_previews')) run(`DELETE FROM editor_previews WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      run(`DELETE FROM editor_versions WHERE document_id IN (SELECT id FROM editor_documents WHERE workspace_id IN ${list(workspaces)})`, ...workspaces);
      run(`DELETE FROM editor_documents WHERE workspace_id IN ${list(workspaces)}`, ...workspaces);
      run(`DELETE FROM editor_workspaces WHERE id IN ${list(workspaces)}`, ...workspaces);
    }
    run('DELETE FROM media WHERE content_id=?', id);
    if (has('recent_import_download_pauses')) run('DELETE FROM recent_import_download_pauses WHERE content_id=?', id);
    for (const key of [`detail:${id}`, ...mediaIds.flatMap(mid => [`media:${mid}`, `refresh:${mid}`])])
      try { this.db.prepare('DELETE FROM recent_import_item_retries WHERE item_key=?').run(key); } catch { /* table may not exist yet */ }
    const owner = db.prepare('SELECT title,platform,source_id FROM contents WHERE id=?').get(id) as Row;
    run('INSERT INTO content_deletions(content_id,deleted_at,bytes_freed,title,platform,source_id) VALUES(?,?,?,?,?,?)', id, now, 0, owner.title, owner.platform, owner.source_id);
    const pending = db.prepare('INSERT INTO pending_file_deletions VALUES(?,?)');
    for (const file of files) pending.run(file, now);
    return files;
  }
  /** Preview = the same plan, nothing deleted. */
  deletePreviewBytes(ids: number[]): number {
    const seen = new Set<string>();
    let bytes = 0;
    for (const id of ids) for (const file of this.deletionPlan(id)) {
      if (seen.has(file)) continue; seen.add(file);
      try { const info = statSync(file); bytes += info.isFile() ? info.size : 0; } catch { /* missing files free nothing */ }
    }
    return bytes;
  }
  /** Committed soft-delete then unlink. `bytes_freed` counts linked files only. */
  deleteContents(ids: number[], now: number): { deleted: number[]; bytesFreed: number } {
    const pending = new Map<number, string[]>();
    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        for (const id of ids) {
          if (this.isDeleted(id)) continue;
          if (!this.db.prepare('SELECT 1 FROM contents WHERE id=?').get(id)) throw new Error('收藏不存在');
          pending.set(id, this.purgeContentRows(id, now));
        }
      })();
    } finally { this.db.pragma('foreign_keys = ON'); }
    let freed = 0;
    for (const [id, files] of pending) {
      let contentFreed = 0;
      for (const file of files) {
        try { const info = statSync(file); if (info.isFile()) contentFreed += info.size; } catch { /* already gone */ }
        try { rmSync(file, { recursive: true, force: true }); } catch { /* missing is success */ }
        this.db.prepare('DELETE FROM pending_file_deletions WHERE path=?').run(file);
      }
      freed += contentFreed;
      this.db.prepare('UPDATE content_deletions SET bytes_freed=? WHERE content_id=?').run(contentFreed, id);
    }
    return { deleted: [...pending.keys()], bytesFreed: freed };
  }
  private migrate(): void {
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version >= 4) return;
    // VACUUM INTO takes a consistent SQLite snapshot (including WAL). It is
    // synchronous so no migration statement can run before its completion.
    const backup = path.join(this.dataDir, `workbench-pre-v4-${Date.now()}.sqlite`);
    this.db.prepare('VACUUM INTO ?').run(backup);
    this.db.transaction(() => {
      const add = (table: string, name: string, sql: string) => {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
        if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
      };
      if(version<2){
      add('contents', 'manifest_complete', 'INTEGER NOT NULL DEFAULT 0');
      add('contents', 'manifest_error', 'TEXT');
      add('contents', 'adapter_version', 'INTEGER NOT NULL DEFAULT 0');
      add('contents', 'availability', "TEXT NOT NULL DEFAULT 'available'");
      add('contents', 'repair_state', "TEXT NOT NULL DEFAULT 'none'");
      add('contents', 'repair_attempts', 'INTEGER NOT NULL DEFAULT 0');
      add('contents', 'repair_reason', 'TEXT');
      add('media', 'resource_key', 'TEXT');
      add('media', 'role', 'TEXT');
      add('media', 'media_order', 'INTEGER NOT NULL DEFAULT 0');
      add('media', 'title', 'TEXT');
      add('media', 'source_identity', 'TEXT');
      add('media', 'resource_version', 'TEXT');
      add('media', 'current', 'INTEGER NOT NULL DEFAULT 1');
      add('syncs', 'incremental_status', "TEXT NOT NULL DEFAULT 'unknown'");
      add('syncs', 'incremental_new', 'INTEGER NOT NULL DEFAULT 0');
      add('syncs', 'incremental_reason', "TEXT NOT NULL DEFAULT ''");
      add('syncs', 'trigger', "TEXT NOT NULL DEFAULT 'manual'");
      this.db.exec(`CREATE TABLE IF NOT EXISTS recent_checkpoints (
        platform TEXT NOT NULL,account_id TEXT NOT NULL,scope_id TEXT NOT NULL,
        ordered_ids TEXT NOT NULL,evidence TEXT NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(platform,account_id,scope_id));
        CREATE TABLE IF NOT EXISTS fixed_batch (content_id INTEGER PRIMARY KEY REFERENCES contents(id), batch TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS media_current ON media(content_id,current,media_order);`);
      this.db.prepare("INSERT OR IGNORE INTO fixed_batch(content_id,batch) SELECT id,'round-01-original' FROM contents ORDER BY id LIMIT 30").run();
      // Only old successful details with an actual media manifest can inherit it.
      this.db.exec(`UPDATE contents SET manifest_complete=body_complete
        WHERE detail_state='succeeded' AND (kind='text' OR EXISTS (SELECT 1 FROM media WHERE content_id=contents.id AND kind=contents.kind));
        UPDATE media SET media_order=(SELECT count(*)-1 FROM media AS before WHERE before.content_id=media.content_id AND before.id<=media.id);`);
      this.db.prepare(`UPDATE contents SET detail_state='queued',repair_state='queued',repair_reason='旧版视频详情缺少视频清单；一次自动修复',manifest_error='视频清单尚未取得'
        WHERE platform='xiaohongshu' AND kind='video' AND adapter_version<2 AND detail_state='succeeded' AND body_complete=0
        AND NOT EXISTS (SELECT 1 FROM media WHERE content_id=contents.id AND kind='video')`).run();
      }
      add('media','expected_duration','REAL');
      // A v1-v3 saved file may be valid while its old manifest has neither cid
      // identity nor actual P order/title. Refresh that metadata once, keeping
      // the original files. The schema boundary bounds automatic retries.
      this.db.prepare(`UPDATE contents SET detail_state='queued',detail_error=NULL,repair_state='queued',
        repair_reason='旧版B站媒体缺少稳定身份或分P标题；一次元数据修复'
        WHERE platform='bilibili' AND adapter_version<2 AND detail_state IN ('succeeded','failed')
        AND (NOT EXISTS (SELECT 1 FROM media WHERE content_id=contents.id AND kind='video' AND current=1)
          OR EXISTS (SELECT 1 FROM media WHERE content_id=contents.id AND kind='video' AND current=1
            AND (resource_key IS NULL OR resource_key='' OR title IS NULL OR title='')))` ).run();
      this.setSetting('migrationBackup', backup);
      this.db.pragma('user_version = 4');
    })();
  }
  checkpoint(platform: Platform, accountId: string, scopeId: string): string[] | undefined {
    const row = this.db.prepare('SELECT ordered_ids FROM recent_checkpoints WHERE platform=? AND account_id=? AND scope_id=?').get(platform, accountId, scopeId) as Row | undefined;
    return row ? JSON.parse(row.ordered_ids) : undefined;
  }
  saveCheckpoint(platform: Platform, accountId: string, scopeId: string, ids: string[], evidence: unknown, now: number): void {
    this.db.prepare(`INSERT INTO recent_checkpoints(platform,account_id,scope_id,ordered_ids,evidence,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(platform,account_id,scope_id) DO UPDATE SET ordered_ids=excluded.ordered_ids,evidence=excluded.evidence,updated_at=excluded.updated_at`).run(platform,accountId,scopeId,JSON.stringify(ids),JSON.stringify(evidence),now);
  }
  setting(key: string, fallback: string): string { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined)?.value ?? fallback; }
  setSetting(key: string, value: string): void { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  account(platform: Platform, accountId: string): { complete: boolean } | undefined {
    const row = this.db.prepare('SELECT baseline_complete FROM accounts WHERE platform=? AND account_id=?').get(platform, accountId) as Row | undefined;
    return row ? { complete: !!row.baseline_complete } : undefined;
  }
  known(platform: Platform, accountId: string): Set<string> { return new Set((this.db.prepare('SELECT source_id FROM observed WHERE platform=? AND account_id=?').all(platform, accountId) as Row[]).map(r => r.source_id)); }
  folderBaseline(platform: Platform, accountId: string, folderId: string): boolean { return !!(this.db.prepare('SELECT baseline_complete FROM folders WHERE platform=? AND account_id=? AND folder_id=?').get(platform, accountId, folderId) as Row | undefined)?.baseline_complete; }
  historicalCount(platform?: Platform): number { return ((platform ? this.db.prepare(`SELECT count(*) AS n FROM contents WHERE discovery='historical' AND ${Store.NOT_DELETED} AND platform=?`).get(platform) : this.db.prepare(`SELECT count(*) AS n FROM contents WHERE discovery='historical' AND ${Store.NOT_DELETED}`).get()) as Row).n; }
  platformBaseline(platform: Platform): { observed: number; complete: boolean } | undefined {
    const accounts = this.db.prepare('SELECT baseline_complete FROM accounts WHERE platform=?').all(platform) as Row[];
    if (!accounts.length) return undefined;
    return { observed: (this.db.prepare('SELECT count(*) AS n FROM observed WHERE platform=?').get(platform) as Row).n, complete: accounts.every(a => !!a.baseline_complete) };
  }
  find(platform: Platform, accountId: string, sourceId: string): number | undefined { return (this.db.prepare('SELECT id FROM contents WHERE platform=? AND account_id=? AND source_id=?').get(platform, accountId, sourceId) as Row | undefined)?.id; }
  saveSnapshot(snapshot: CollectionSnapshot, selected: { item: CollectionItem; discovery: Discovery }[], now: number): { inserted: number; skippedDeleted: number } {
    return this.db.transaction(() => {
      let inserted = 0;
      this.db.prepare(`INSERT INTO accounts(platform,account_id,name,baseline_complete) VALUES(?,?,?,?) ON CONFLICT(platform,account_id) DO UPDATE SET name=excluded.name, baseline_complete=MAX(accounts.baseline_complete,excluded.baseline_complete)`).run(snapshot.platform, snapshot.accountId, snapshot.accountName, +snapshot.complete);
      const folder = this.db.prepare(`INSERT INTO folders(platform,account_id,folder_id,title,baseline_complete) VALUES(?,?,?,?,?) ON CONFLICT(platform,account_id,folder_id) DO UPDATE SET title=excluded.title, baseline_complete=MAX(folders.baseline_complete,excluded.baseline_complete)`);
      for (const f of snapshot.folders) folder.run(snapshot.platform, snapshot.accountId, f.id, f.title, +snapshot.complete);
      const observed = this.db.prepare('INSERT OR IGNORE INTO observed(platform,account_id,source_id,first_seen) VALUES(?,?,?,?)');
      const folderObserved = this.db.prepare('INSERT OR IGNORE INTO folder_observed(platform,account_id,folder_id,source_id) VALUES(?,?,?,?)');
      for (const item of snapshot.items) {
        observed.run(snapshot.platform, snapshot.accountId, item.sourceId, now);
        for (const folderId of item.folderIds) folderObserved.run(snapshot.platform, snapshot.accountId, folderId, item.sourceId);
      }
      const insert = this.db.prepare(`INSERT OR IGNORE INTO contents(platform,account_id,source_id,title,author,url,kind,published_at,collected_at,first_discovered_at,discovery) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      // E4.8: collected_at fills once and never moves — it is the platform's own
      // favourite time, and later snapshots must not overwrite a known value.
      const update = this.db.prepare('UPDATE contents SET title=?, author=?, url=?, kind=?, published_at=COALESCE(?,published_at), collected_at=COALESCE(collected_at,?) WHERE id=?');
      const relation = this.db.prepare('INSERT OR IGNORE INTO content_folders(content_id,folder_id) VALUES(?,?)');
      // E4.6 tombstone baseline: a locally deleted collection is never updated,
      // requeued or counted as new. observed/checkpoint bookkeeping above is
      // unchanged so coverage and new-vs-history detection stay correct.
      const tombstones = this.deletedIds();
      let skippedDeleted = 0;
      for (const { item, discovery } of selected) {
        if (tombstones.size && tombstones.has(this.find(snapshot.platform, snapshot.accountId, item.sourceId) ?? -1)) { skippedDeleted++; continue; }
        const firstSeen = (this.db.prepare('SELECT first_seen FROM observed WHERE platform=? AND account_id=? AND source_id=?').get(snapshot.platform, snapshot.accountId, item.sourceId) as Row).first_seen;
        const result = insert.run(snapshot.platform, snapshot.accountId, item.sourceId, item.title, item.author, item.url, item.kind, item.publishedAt ?? null, item.collectedAt ?? null, firstSeen, discovery);
        inserted += result.changes;
        const id = this.find(snapshot.platform, snapshot.accountId, item.sourceId)!;
        const knownMediaKinds = (this.db.prepare('SELECT DISTINCT kind FROM media WHERE content_id=? AND current=1').all(id) as Row[]).map(row => String(row.kind));
        update.run(item.title, item.author, item.url, kindWithKnownMedia(item.kind, knownMediaKinds), item.publishedAt ?? null, item.collectedAt ?? null, id);
        for (const f of item.folderIds) relation.run(id, f);
      }
      this.applyFavoriteOrder(snapshot, tombstones);
      return { inserted, skippedDeleted };
    })();
  }
  /** E4.8: persist the platform's own favourite order as a rank. Index 0 of the
   * snapshot items is the platform's newest favourite. Already-ranked items are
   * anchors and never move; unranked items above the first anchor rise above the
   * current maximum (new favourites), items between anchors interpolate strictly
   * between them, and items after the last anchor sink below it. Tombstones are
   * never ranked. */
  private applyFavoriteOrder(snapshot: CollectionSnapshot, tombstones: Set<number>): void {
    const rows = this.db.prepare(`SELECT c.id, c.source_id, o.rank FROM contents c
      LEFT JOIN content_favorite_order o ON o.content_id=c.id
      WHERE c.platform=? AND c.account_id=?`).all(snapshot.platform, snapshot.accountId) as Row[];
    const bySource = new Map(rows.map(row => [String(row.source_id), row] as const));
    const ranked = new Map<number, number>();
    let maxRank = 0;
    for (const row of rows) if (row.rank !== null && row.rank !== undefined) { ranked.set(Number(row.id), Number(row.rank)); maxRank = Math.max(maxRank, Number(row.rank)); }
    // Walk the snapshot in platform order, keeping only live local rows.
    const walk: { contentId: number; rank?: number }[] = [];
    for (const item of snapshot.items) {
      const row = bySource.get(item.sourceId);
      if (!row || tombstones.size && tombstones.has(Number(row.id))) continue;
      walk.push({ contentId: Number(row.id), rank: ranked.get(Number(row.id)) });
    }
    const insert = this.db.prepare('INSERT OR IGNORE INTO content_favorite_order(content_id,rank) VALUES(?,?)');
    const anchors = new Map<number, number>();
    walk.forEach((entry, index) => { if (entry.rank !== undefined) anchors.set(index, entry.rank!); });
    const emit = (from: number, to: number, above: number | undefined, below: number | undefined) => {
      const k = to - from;
      for (let j = 0; j < k; j++) {
        let rank: number;
        if (above === undefined) rank = Math.max(maxRank, below ?? maxRank) + (k - j);
        else if (below === undefined) rank = above - (j + 1);
        else rank = below + (above - below) * (k - j) / (k + 1);
        insert.run(walk[from + j].contentId, rank);
      }
    };
    let runStart = 0; let previousAnchor: number | undefined;
    for (const [index, rank] of [...anchors.entries()].sort((a, b) => a[0] - b[0])) {
      emit(runStart, index, previousAnchor, rank);
      previousAnchor = rank; runStart = index + 1;
    }
    emit(runStart, walk.length, previousAnchor, undefined);
  }
  /** E4.7→4.8 startup backfill: items without a rank get the platform's latest
   * observed order (newest first); the rest sink below, ordered by collected_at
   * then id. Tombstoned items are never ranked. Idempotent. */
  backfillFavoriteOrder(batchId: string): void {
    const scopes = this.db.prepare('SELECT platform, account_id, observed_json FROM recent_import_scopes WHERE batch_id=?').all(batchId) as Row[];
    // No scopes → nothing observed to seed from; leave ranks for the first sync.
    if (!scopes.length) return;
    this.db.transaction(() => {
      const unranked = this.db.prepare(`SELECT c.id, c.source_id, c.collected_at FROM contents c
        LEFT JOIN content_favorite_order o ON o.content_id=c.id
        WHERE c.platform=? AND c.account_id=? AND o.content_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM content_deletions d WHERE d.content_id=c.id)`);
      const insert = this.db.prepare('INSERT OR IGNORE INTO content_favorite_order(content_id,rank) VALUES(?,?)');
      for (const scope of scopes) {
        const rows = unranked.all(scope.platform, scope.account_id) as Row[];
        if (!rows.length) continue;
        const observed = (JSON.parse(String(scope.observed_json)) as string[]);
        const order = new Map(observed.map((id, index) => [id, index] as const));
        const inOrder = rows.filter(row => order.has(String(row.source_id))).sort((a, b) => order.get(String(a.source_id))! - order.get(String(b.source_id))!);
        const rest = rows.filter(row => !order.has(String(row.source_id))).sort((a, b) => (Number(b.collected_at ?? 0) - Number(a.collected_at ?? 0)) || (Number(b.id) - Number(a.id)));
        let rank = inOrder.length + rest.length;
        for (const row of inOrder) insert.run(row.id, rank--);
        for (const row of rest) insert.run(row.id, rank--);
      }
      // Rows under accounts that no longer have an import scope (e.g. the account
      // changed): no observed order exists, so they sit below every scoped rank.
      const orphans = this.db.prepare(`SELECT c.id, c.platform, c.collected_at FROM contents c
        LEFT JOIN content_favorite_order o ON o.content_id=c.id
        WHERE o.content_id IS NULL AND NOT EXISTS (SELECT 1 FROM content_deletions d WHERE d.content_id=c.id)
        ORDER BY c.platform, c.collected_at DESC, c.id DESC`).all() as Row[];
      const orphanRank = new Map<string, number>();
      for (const row of orphans) {
        const rank = (orphanRank.get(row.platform) ?? 0);
        insert.run(row.id, rank);
        orphanRank.set(row.platform, rank - 1);
      }
    })();
  }
  contents(): ContentRecord[] {
    const rows = this.db.prepare(`SELECT * FROM contents WHERE ${Store.NOT_DELETED} ORDER BY first_discovered_at DESC,id DESC`).all() as Row[];
    // E4.10: one batched load each for media / favourite rank / folders instead
    // of three per-row queries — identical output, ~O(1) queries per call.
    const notDeletedC = 'NOT EXISTS (SELECT 1 FROM content_deletions d WHERE d.content_id=c.id)';
    const mediaByContent = new Map<number, MediaRecord[]>();
    for (const row of this.db.prepare(`SELECT m.* FROM media m JOIN contents c ON c.id=m.content_id WHERE m.current=1 AND ${notDeletedC} ORDER BY m.content_id,m.media_order,m.id`).all() as Row[]) {
      const record = this.toMedia(row);
      const list = mediaByContent.get(record.contentId);
      if (list) list.push(record); else mediaByContent.set(record.contentId, [record]);
    }
    const rankByContent = new Map<number, number>();
    for (const row of this.db.prepare(`SELECT o.content_id id, o.rank FROM content_favorite_order o JOIN contents c ON c.id=o.content_id WHERE ${notDeletedC}`).all() as Row[]) rankByContent.set(Number(row.id), Number(row.rank));
    const foldersByContent = new Map<number, string[]>();
    for (const row of this.db.prepare(`SELECT f.content_id id, f.folder_id FROM content_folders f JOIN contents c ON c.id=f.content_id WHERE ${notDeletedC} ORDER BY f.content_id,f.folder_id`).all() as Row[]) {
      const list = foldersByContent.get(Number(row.id));
      if (list) list.push(String(row.folder_id)); else foldersByContent.set(Number(row.id), [String(row.folder_id)]);
    }
    return rows.map(r => this.toContent(r, { media: mediaByContent.get(r.id) ?? [], favoriteRank: rankByContent.get(r.id), folderIds: foldersByContent.get(r.id) ?? [] }));
  }
  content(id: number): ContentRecord | undefined { const row = this.db.prepare('SELECT * FROM contents WHERE id=?').get(id) as Row | undefined; return row ? this.toContent(row) : undefined; }
  private toContent(r: Row, prefetched?: { media: MediaRecord[]; favoriteRank: number | undefined; folderIds: string[] }): ContentRecord {
    const media = prefetched?.media ?? (this.db.prepare('SELECT * FROM media WHERE content_id=? AND current=1 ORDER BY media_order,id').all(r.id) as Row[]).map(this.toMedia);
    const requiredMedia = ['image', 'video', 'audio'].includes(r.kind);
    return { id: r.id, platform: r.platform, accountId: r.account_id, sourceId: r.source_id, title: r.title, author: r.author, url: r.url, kind: r.kind,
      publishedAt: r.published_at, collectedAt: r.collected_at, firstDiscoveredAt: r.first_discovered_at, discovery: r.discovery,
      favoriteRank: prefetched ? prefetched.favoriteRank : (this.db.prepare('SELECT rank FROM content_favorite_order WHERE content_id=?').get(r.id) as Row | undefined)?.rank,
      folderIds: prefetched ? prefetched.folderIds : (this.db.prepare('SELECT folder_id FROM content_folders WHERE content_id=? ORDER BY folder_id').all(r.id) as Row[]).map(f => f.folder_id),
      body: r.source_body, bodyComplete: !!r.body_complete, subtitle: r.subtitle, detailState: r.detail_state, detailError: r.detail_error,
      digestedAt: r.digested_at, lastReviewedAt: r.last_reviewed_at, media,
      mediaManifestComplete: !!r.manifest_complete, manifestError: r.manifest_error,adapterVersion:r.adapter_version, availability:r.availability,
      repairState:r.repair_state,repairAttempts:r.repair_attempts,
      offline: r.detail_state === 'succeeded' && !!r.body_complete && !!r.manifest_complete && (!requiredMedia || media.some(m => m.kind === r.kind)) && media.every(m => this.validFile(m)) };
  }
  private validFile(m: MediaRecord): boolean {
    if(m.state !== 'succeeded' || !m.localPath) return false;
    try { const value=statSync(path.join(this.mediaDir,m.localPath)); return value.isFile() && value.size>0 && value.size===m.bytes; } catch { return false; }
  }
  private toMedia(r: Row): MediaRecord { return { id: r.id, contentId: r.content_id, kind: r.kind, state: r.state, localPath: r.local_path, mime: r.mime, error: r.error, bytes: r.bytes, resourceKey:r.resource_key,role:r.role,order:r.media_order,title:r.title,current:!!r.current,durationSeconds:r.expected_duration??undefined }; }
  media(id: number): MediaRecord | undefined { const row = this.db.prepare('SELECT * FROM media WHERE id=?').get(id) as Row | undefined; return row ? this.toMedia(row) : undefined; }
  nextDetail(): ContentRecord | undefined { const row = this.db.prepare(`SELECT id FROM contents WHERE detail_state='queued' AND ${Store.NOT_DELETED} ORDER BY id LIMIT 1`).get() as Row | undefined; return row ? this.content(row.id) : undefined; }
  detailRunning(id: number): void { this.db.prepare("UPDATE contents SET detail_state='running',detail_error=NULL,repair_attempts=repair_attempts+CASE WHEN repair_state='queued' THEN 1 ELSE 0 END,repair_state=CASE WHEN repair_state='queued' THEN 'running' ELSE repair_state END WHERE id=?").run(id); }
  detailFailed(id: number, error: string): void { this.db.prepare("UPDATE contents SET detail_state='failed',detail_error=?,repair_state=CASE WHEN repair_state='running' THEN 'failed' ELSE repair_state END,repair_reason=CASE WHEN repair_state='running' THEN ? ELSE repair_reason END,availability=CASE WHEN ? LIKE '%内容失效%' OR ? LIKE '%不可访问%' THEN 'unavailable' WHEN ? LIKE '%不支持%' THEN 'unsupported' ELSE availability END WHERE id=?").run(error,error,error,error,error,id); }
  detailRequeue(id: number): void { this.db.prepare("UPDATE contents SET detail_state='queued',detail_error=NULL,repair_state=CASE WHEN repair_state='running' THEN 'queued' ELSE repair_state END WHERE id=?").run(id); }
  /** E4.9: X tweets whose own body was dropped because an embedded quote was
   * unreadable get one detail requeue under the quote-tolerant adapter. */
  requeueXQuoteBlocked(): number {
    const result = this.db.prepare(`UPDATE contents SET detail_state='queued',detail_error=NULL,
      repair_state='queued',repair_reason='旧版适配器因引用帖缺失丢弃本帖正文；一次自动修复'
      WHERE platform='twitter' AND detail_state='succeeded' AND body_complete=0
      AND manifest_error LIKE '%引用帖%' AND ${Store.NOT_DELETED}`).run();
    return Number(result.changes);
  }
  /** E4.12: X Articles whose detail saved only the summary get one detail
   * requeue under the article-aware adapter. */
  requeueXArticleSummaries(): number {
    const result = this.db.prepare(`UPDATE contents SET detail_state='queued',detail_error=NULL,
      repair_state='queued',repair_reason='旧版适配器只保存了 X 长文章摘要；一次自动修复'
      WHERE platform='twitter' AND detail_state='succeeded' AND body_complete=0
      AND manifest_error LIKE '%X 长文章只有摘要%' AND ${Store.NOT_DELETED}`).run();
    return Number(result.changes);
  }
  detailSaved(id: number, detail: DetailResult): void {
    this.db.transaction(() => {
      const owner=this.db.prepare('SELECT * FROM contents WHERE id=?').get(id) as Row;
      const bodyValid=detail.bodyStatus !== 'unavailable';
      // Legacy adapters returned '' for optional subtitle errors. An empty value
      // only replaces saved text when explicitly declared a valid new result.
      const subtitleValid=detail.subtitleStatus === 'valid' || (detail.subtitleStatus !== 'unavailable' && !!detail.subtitle);
      const manifestComplete=detail.mediaManifestComplete ?? detail.bodyComplete;
      const kind = kindWithKnownMedia(owner.kind, detail.media.map(media => media.kind));
      this.db.prepare(`UPDATE contents SET kind=?,source_body=?,body_complete=?,subtitle=?,published_at=COALESCE(?,published_at),detail_state='succeeded',detail_error=NULL,
        manifest_complete=?,manifest_error=?,adapter_version=MAX(adapter_version,?),availability=?,repair_state=CASE WHEN repair_state IN ('running','queued') THEN ? ELSE repair_state END,
        repair_reason=CASE WHEN repair_state IN ('running','queued') THEN ? ELSE repair_reason END WHERE id=?`).run(
        kind,bodyValid?detail.body:owner.source_body,bodyValid?+detail.bodyComplete:owner.body_complete,subtitleValid?(detail.subtitle??''):owner.subtitle,detail.publishedAt??null,
        +manifestComplete,detail.manifestError??(manifestComplete?null:'媒体清单尚未完整取得'),detail.adapterVersion??0,detail.availability??'available',manifestComplete?'succeeded':'failed',detail.manifestError??(manifestComplete?'自动修复已取得媒体清单':'修复已尝试；媒体清单不完整，可重试'),id);
      const existing=this.db.prepare('SELECT * FROM media WHERE content_id=? ORDER BY current DESC,media_order,id').all(id) as Row[];
      const incoming=[...new Map(detail.media.map(m=>[identity(m),m])).values()];
      // A failed/incomplete extraction does not erase previously obtained media.
      if(manifestComplete) this.db.prepare('UPDATE media SET current=0 WHERE content_id=?').run(id);
      const used=new Set<number>();
      for(const [index,m] of incoming.entries()) {
        const key=identity(m);
        const old=existing.find(row=>!used.has(row.id) && row.kind===m.kind && row.resource_key===key)
          ?? existing.find(row=>!used.has(row.id) && row.kind===m.kind && !row.resource_key && legacyLocation(row.remote_url)===legacyLocation(m.remoteUrl))
          ?? existing.find(row=>!used.has(row.id) && adoptLegacyXhsVideo(owner,row,m));
        if(old) {
          used.add(old.id);
          const valid=this.validFile(this.toMedia(old));
          this.db.prepare(`UPDATE media SET remote_url=?,referer=?,mime=?,resource_key=?,role=?,media_order=?,title=?,source_identity=?,resource_version=?,expected_duration=?,current=1,
            state=?,error=NULL,local_path=?,bytes=? WHERE id=?`).run(m.remoteUrl,m.referer??null,m.mime??old.mime,key,m.role??m.kind,m.order??index,m.title??null,m.sourceIdentity??null,m.version??null,m.durationSeconds??null,
            valid?'succeeded':'queued',valid?old.local_path:null,valid?old.bytes:0,old.id);
        } else {
          this.db.prepare("UPDATE media SET current=0,remote_url=remote_url || '#retired-' || id WHERE content_id=? AND remote_url=?").run(id,m.remoteUrl);
          this.db.prepare(`INSERT INTO media(content_id,kind,remote_url,referer,mime,resource_key,role,media_order,title,source_identity,resource_version,expected_duration,current)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(id,m.kind,m.remoteUrl,m.referer??null,m.mime??'application/octet-stream',key,m.role??m.kind,m.order??index,m.title??null,m.sourceIdentity??null,m.version??null,m.durationSeconds??null);
        }
      }
    })();
    this.editor?.captureSource(id);
  }
  nextDownload(preferredContentId?: number): (MediaRecord & { remoteUrl: string; referer?: string }) | undefined {
    const row = this.db.prepare(`SELECT media.* FROM media JOIN contents ON contents.id=media.content_id WHERE media.state='queued' AND media.current=1 AND contents.detail_state='succeeded' AND ${Store.NOT_DELETED} ORDER BY CASE WHEN media.content_id=? THEN 0 ELSE 1 END,media.media_order,media.id LIMIT 1`).get(preferredContentId ?? -1) as Row | undefined;
    return row ? { ...this.toMedia(row), remoteUrl: row.remote_url, referer: row.referer ?? undefined } : undefined;
  }
  downloadRunning(id: number): void { this.db.prepare("UPDATE media SET state='running',error=NULL WHERE id=?").run(id); }
  downloadSaved(id: number, localPath: string, bytes: number, mime: string): void { this.db.prepare("UPDATE media SET state='succeeded',local_path=?,bytes=?,mime=?,error=NULL WHERE id=?").run(localPath, bytes, mime, id); const media=this.media(id);if(media)this.editor?.captureSource(media.contentId); }
  downloadFailed(id: number, error: string): void { this.db.prepare("UPDATE media SET state='failed',local_path=NULL,bytes=0,error=? WHERE id=?").run(error, id); }
  retry(id: number, mediaId?:number): void {
    if(mediaId!==undefined){
      const old=this.db.prepare('SELECT * FROM media WHERE id=? AND content_id=? AND current=1').get(mediaId,id) as Row|undefined;
      if(!old)throw new Error('媒体不属于当前内容');
      this.db.transaction(()=>{
        this.db.prepare("UPDATE media SET current=0,remote_url=remote_url || '#retired-' || id WHERE id=?").run(mediaId);
        // Keep original file and row as historical recovery evidence. Replacement
        // gets a fresh ID/file name, so failed repair cannot overwrite the original.
        this.db.prepare(`INSERT INTO media(content_id,kind,remote_url,referer,mime,resource_key,role,media_order,title,source_identity,resource_version,expected_duration,current)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(id,old.kind,old.remote_url,old.referer,old.mime,old.resource_key,old.role,old.media_order,old.title,old.source_identity,old.resource_version,old.expected_duration);
      })();
    }

    // Refresh source detail as well: media URLs are often short-lived signatures.
    this.db.prepare("UPDATE contents SET detail_state='queued',detail_error=NULL,availability='available',repair_state=CASE WHEN repair_state='failed' THEN 'queued' ELSE repair_state END WHERE id=? AND detail_state!='running'").run(id);
    this.db.prepare("UPDATE media SET state='queued',error=NULL,local_path=NULL,bytes=0 WHERE content_id=? AND current=1 AND state='failed'").run(id);
    for (const media of this.content(id)?.media ?? []) if (media.state === 'succeeded' && !this.validFile(media)) this.db.prepare("UPDATE media SET state='queued',error=NULL,local_path=NULL,bytes=0 WHERE id=?").run(media.id);
  }
  /** Explicit user action: one bounded retry pass, never run by startup/polling. */
  retryFailures():number {
    const rows=this.db.prepare(`SELECT id FROM contents WHERE ${Store.NOT_DELETED} AND (detail_state='failed' OR repair_state='failed'
      OR (detail_state='succeeded' AND manifest_complete=0)
      OR EXISTS(SELECT 1 FROM media WHERE content_id=contents.id AND current=1 AND state='failed')) ORDER BY id`).all() as Row[];
    this.db.transaction(()=>{for(const row of rows)this.retry(row.id);})();
    return rows.length;
  }
  digest(id: number, value: boolean, now: number): void { this.db.prepare('UPDATE contents SET digested_at=?,last_reviewed_at=NULL WHERE id=?').run(value ? now : null, id); }
  review(id: number, now: number): void { this.db.prepare('UPDATE contents SET last_reviewed_at=? WHERE id=? AND digested_at IS NOT NULL').run(now, id); }
  startSync(platform: Platform, now: number, trigger: 'manual'|'timer'|'resume'='manual'): number { return Number(this.db.prepare('INSERT INTO syncs(platform,started_at,trigger) VALUES(?,?,?)').run(platform, now, trigger).lastInsertRowid); }
  finishSync(id: number, values: { state: 'succeeded' | 'partial' | 'failed'; discovered?: number; deduplicated?: number; saved?: number; failed?: number; message?: string; incrementalStatus?: 'baseline'|'confirmed'|'unknown'; incrementalNew?: number; incrementalReason?: string }, now: number): void {
    this.db.prepare('UPDATE syncs SET finished_at=?,state=?,discovered=?,deduplicated=?,saved=?,failed=?,message=?,incremental_status=?,incremental_new=?,incremental_reason=? WHERE id=?').run(now, values.state, values.discovered ?? 0, values.deduplicated ?? 0, values.saved ?? 0, values.failed ?? 0, values.message ?? '', values.incrementalStatus??'unknown',values.incrementalNew??0,values.incrementalReason??'',id);
  }
  /** E4.7: start time of the newest finished successful sync for a platform. */
  lastFinishedSyncStartedAt(platform: Platform): number | undefined {
    return (this.db.prepare("SELECT started_at FROM syncs WHERE platform=? AND state IN ('succeeded','partial') ORDER BY id DESC LIMIT 1").get(platform) as Row | undefined)?.started_at;
  }
  syncs(): SyncRecord[] { return (this.db.prepare('SELECT * FROM syncs ORDER BY id DESC LIMIT 100').all() as Row[]).map(r => ({ id: r.id, platform: r.platform, startedAt: r.started_at, finishedAt: r.finished_at, state: r.state, discovered: r.discovered, deduplicated: r.deduplicated, saved: r.saved, failed: r.failed, message: r.message,incrementalStatus:r.incremental_status,incrementalNew:r.incremental_new,incrementalReason:r.incremental_reason,trigger:r.trigger })); }
  close(): void { this.db.close(); }
}
