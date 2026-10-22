import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertTranscriptReference, clone, findDraftBlock, getDraftAssetRefs, normalizeTranscript, plainText, pointLength, pointSlice, validateBundle, validateDocument, validateSaveRequest, validateSourceReference, type AssetMetadata, type AssetRef, type ContentDocument, type DraftDocument, type ResolvedReference, type SaveRequest, type SaveResult, type SourceReference, type SourceSnapshot, type TranscriptSegment, type Workspace, type WorkspaceBundle } from '../editor-core/model.js';
import type { EditorHistory, EditorInitializationKind, EditorOpenResult, EditorPreview, EditorWorkspaceRecord } from '../shared/editor-contracts.js';
import { createDigestSchema } from './digest-store.js';
import { createOcrSchema,resolveOcrReference } from './ocr-store.js';
import { AsrSourceUnavailableError, asrSourceInventory, resolveAsrReference } from './asr-store.js';
import { markGenerationManual } from './generation-store.js';
import { pinImage, readFixedAsset, sha256 } from './editor-media.js';
type Row = Record<string, any>;
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !value || value.length > 200)
    throw new Error('工作区身份无效'); }
function positive(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error('收藏身份无效'); }
function emptyBundle(content: Row): WorkspaceBundle {
    const workspaceId = `workspace-${randomUUID()}`, draftId = `draft-${randomUUID()}`, mapId = `map-${randomUUID()}`, rootId = `node-${randomUUID()}`;
    return { workspace: { id: workspaceId, collectionId: `${content.platform}:${content.account_id}:${content.source_id}`, userTitle: content.title, draftDocumentId: draftId, mindMapDocumentId: mapId, draftRevision: 1, mapRevision: 1 }, draft: { documentId: draftId, workspaceId, schemaVersion: 1, revision: 1, blocks: [{ id: `block-${randomUUID()}`, type: 'paragraph', runs: [{ text: content.edited_body ?? '' }] }] }, map: { documentId: mapId, workspaceId, schemaVersion: 1, revision: 1, sheetId: `sheet-${randomUUID()}`, rootId, theme: { id: 'light', name: '浅色' }, nodes: { [rootId]: { id: rootId, parentId: null, children: [], title: [{ text: content.title }], notes: '', sourceRefs: [] } } }, sources: [], transcripts: [], assets: [] };
}
const schema = `CREATE TABLE editor_workspaces(id TEXT PRIMARY KEY,content_id INTEGER NOT NULL UNIQUE REFERENCES contents(id),platform TEXT NOT NULL,account_id TEXT NOT NULL,source_id TEXT NOT NULL,json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_source_revision TEXT);
CREATE TABLE editor_documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES editor_workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('draft','map')),current_revision INTEGER NOT NULL,UNIQUE(workspace_id,kind));
CREATE TABLE editor_versions(document_id TEXT NOT NULL REFERENCES editor_documents(id),revision INTEGER NOT NULL,json TEXT NOT NULL,saved_at INTEGER NOT NULL,PRIMARY KEY(document_id,revision));
CREATE TABLE editor_sources(source_id TEXT NOT NULL,revision_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES editor_workspaces(id),json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(source_id,revision_id));
CREATE TABLE editor_transcripts(transcript_id TEXT NOT NULL,revision INTEGER NOT NULL,segment_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES editor_workspaces(id),json TEXT NOT NULL,PRIMARY KEY(transcript_id,revision,segment_id));
CREATE TABLE editor_assets(id TEXT NOT NULL,version TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES editor_workspaces(id),media_id INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE TABLE editor_previews(workspace_id TEXT NOT NULL REFERENCES editor_workspaces(id),map_revision INTEGER NOT NULL,config_key TEXT NOT NULL,state TEXT NOT NULL,svg TEXT,error TEXT,PRIMARY KEY(workspace_id,map_revision,config_key));
CREATE INDEX editor_versions_history ON editor_versions(document_id,revision DESC);`;
function insertBundle(db: Database.Database, content: Row, bundle: WorkspaceBundle, now: number): void { validateBundle(bundle); db.prepare('INSERT INTO editor_workspaces VALUES(?,?,?,?,?,?,?,?,NULL)').run(bundle.workspace.id, content.id, content.platform, content.account_id, content.source_id, JSON.stringify(bundle.workspace), now, now); for (const document of [bundle.draft, bundle.map]) {
    db.prepare('INSERT INTO editor_documents VALUES(?,?,?,?)').run(document.documentId, bundle.workspace.id, 'blocks' in document ? 'draft' : 'map', document.revision);
    db.prepare('INSERT INTO editor_versions VALUES(?,?,?,?)').run(document.documentId, document.revision, JSON.stringify(document), now);
} }
export const EDITOR_SCHEMA_VERSION=7;
/** One consistent backup and one transaction for both editor and digest schema. */
export function migrateEditorSchema(db:Database.Database,dataDir:string,options:{failAfterSchema?:boolean;failAfterEditor?:boolean;targetVersion?:6|7}={}):{backup:string|null;migrated:boolean}{
 const target=options.targetVersion??6;const version=Number(db.pragma('user_version',{simple:true}));if(version>target)throw new Error('数据版本高于本应用支持版本');if(version===target)return{backup:null,migrated:false};if(![4,5,6].includes(version))throw new Error('编辑迁移仅接受schema 4、5或6');
 const backup=path.join(dataDir,`workbench-pre-v${target}-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`);db.prepare('VACUUM INTO ?').run(backup);
 db.transaction(()=>{if(version===4){db.exec(schema);for(const row of db.prepare('SELECT * FROM contents WHERE edited_body IS NOT NULL ORDER BY id').all() as Row[])insertBundle(db,row,emptyBundle(row),Date.now());}if(options.failAfterEditor)throw new Error('injected migration failure after editor');if(version<6)createDigestSchema(db);if(target===7)createOcrSchema(db);if(options.failAfterSchema)throw new Error('injected migration failure');db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('editorMigrationBackup',backup);db.pragma(`user_version=${target}`);})();return{backup,migrated:true};
}
export class EditorRepository {
    readonly assetsDir: string;
    private failureNext: string | null = null;
    constructor(readonly db: Database.Database, readonly dataDir: string, assetsDir = path.join(dataDir, 'editor-assets')) { if (![5,6,7,8,9,10].includes(Number(db.pragma('user_version', { simple: true }))))
        throw new Error('编辑存储需要schema 5、6、7、8或9'); this.db.pragma('synchronous=FULL'); this.assetsDir = assetsDir; mkdirSync(assetsDir, { recursive: true, mode: 0o700 }); }
    private owner(workspaceId: string): Row { id(workspaceId); const row = this.db.prepare('SELECT * FROM editor_workspaces WHERE id=?').get(workspaceId) as Row | undefined; if (!row)
        throw new Error('工作区不存在'); const content = this.db.prepare('SELECT platform,account_id,source_id FROM contents WHERE id=?').get(row.content_id) as Row | undefined; if (!content || content.platform !== row.platform || content.account_id !== row.account_id || content.source_id !== row.source_id)
        throw new Error('工作区收藏归属不符'); return row; }
    private version(documentId: string, revision?: number): ContentDocument { id(documentId); const row = (revision === undefined ? this.db.prepare('SELECT v.json FROM editor_versions v JOIN editor_documents d ON d.id=v.document_id AND d.current_revision=v.revision WHERE d.id=?').get(documentId) : this.db.prepare('SELECT json FROM editor_versions WHERE document_id=? AND revision=?').get(documentId, revision)) as Row | undefined; if (!row)
        throw new Error('引用的已保存版本不存在'); const doc = JSON.parse(row.json); validateDocument(doc); return doc; }
    load(workspaceId: string): EditorWorkspaceRecord {
        const owner = this.owner(workspaceId), workspace = JSON.parse(owner.json) as Workspace, asr = asrSourceInventory(this.db, owner.content_id, workspaceId);
        const bundle: WorkspaceBundle = { workspace, draft: this.version(workspace.draftDocumentId) as WorkspaceBundle['draft'], map: this.version(workspace.mindMapDocumentId) as WorkspaceBundle['map'], sources: (this.db.prepare('SELECT json FROM editor_sources WHERE workspace_id=? ORDER BY created_at,rowid').all(workspaceId) as Row[]).map(x => JSON.parse(x.json)), transcripts: [...(this.db.prepare('SELECT json FROM editor_transcripts WHERE workspace_id=? ORDER BY transcript_id,revision,segment_id').all(workspaceId) as Row[]).map(x => normalizeTranscript(JSON.parse(x.json))), ...asr.segments], assets: (this.db.prepare('SELECT json FROM editor_assets WHERE workspace_id=? ORDER BY rowid').all(workspaceId) as Row[]).map(x => JSON.parse(x.json)) };
        validateBundle(bundle);
        const unavailableSources = asr.unavailable.map(source => ({ ...source, referencedByNodeIds: Object.values(bundle.map.nodes).filter(node => node.sourceRefs.some(ref => ref.kind === 'transcript' && ref.transcriptId === source.transcriptId && ref.revision === source.revision && ref.segmentId === source.segmentId)).map(node => node.id) }));
        return { initialized: true, contentId: owner.content_id, bundle, sourceRevisionId: owner.last_source_revision, sourceUpdated: bundle.sources.length > 1, updatedAt: owner.updated_at, ...(unavailableSources.length ? { unavailableSources } : {}) };
    }
    open(contentId: number, initialization?: EditorInitializationKind): EditorOpenResult { positive(contentId); if (initialization !== undefined && !['source', 'subtitle', 'blank'].includes(initialization))
        throw new Error('初始化方式无效'); const content = this.db.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as Row | undefined; if (!content)
        throw new Error('收藏不存在'); const old = this.db.prepare('SELECT id FROM editor_workspaces WHERE content_id=?').get(contentId) as Row | undefined; if (old) {
        this.captureSource(contentId);
        return this.load(old.id);
    } if (!initialization && content.edited_body === null)
        return { initialized: false, contentId, title: content.title, available: { source: !!content.source_body, subtitle: !!content.subtitle, blank: true } }; if (initialization === 'source' && !content.source_body)
        throw new Error('来源正文尚未取得'); if (initialization === 'subtitle' && !content.subtitle)
        throw new Error('字幕尚未取得'); return this.db.transaction(() => { const concurrent = this.db.prepare('SELECT id FROM editor_workspaces WHERE content_id=?').get(contentId) as Row | undefined; if (concurrent)
        return this.load(concurrent.id); const bundle = emptyBundle(content); if (content.edited_body === null && initialization !== 'blank') {
        const text = initialization === 'subtitle' ? content.subtitle : content.source_body;
        bundle.draft.blocks = text.split(/\r?\n/).map((line: string) => ({ id: `block-${randomUUID()}`, type: 'paragraph' as const, runs: [{ text: line }] }));
    } insertBundle(this.db, content, bundle, Date.now()); this.captureSource(contentId); return this.load(bundle.workspace.id); })(); }
    title(workspaceId: string, title: string): void { if (typeof title !== 'string' || title.length > 10000)
        throw new Error('标题无效'); this.db.transaction(() => { const row = this.owner(workspaceId), workspace = JSON.parse(row.json) as Workspace; const changed=workspace.userTitle!==title; workspace.userTitle = title; this.db.prepare('UPDATE editor_workspaces SET json=?,updated_at=? WHERE id=?').run(JSON.stringify(workspace), Date.now(), workspaceId); if(changed)markGenerationManual(this.db,row.content_id); })(); }
    asset(workspaceId: string, ref: AssetRef): AssetMetadata | undefined { this.owner(workspaceId); if (!ref || typeof ref.assetId !== 'string' || typeof ref.version !== 'string')
        throw new Error('资源身份无效'); const row = this.db.prepare('SELECT json FROM editor_assets WHERE workspace_id=? AND id=? AND version=?').get(workspaceId, ref.assetId, ref.version) as Row | undefined; return row ? JSON.parse(row.json) : undefined; }
    selectImage(workspaceId: string, mediaId: number): AssetMetadata { const owner = this.owner(workspaceId); positive(mediaId); const media = this.db.prepare("SELECT * FROM media WHERE id=? AND content_id=? AND kind='image' AND state='succeeded'").get(mediaId, owner.content_id) as Row | undefined; if (!media?.local_path)
        throw new Error('图片不属于当前收藏或尚未保存'); const pinned = pinImage({ mediaDir: path.join(this.dataDir, 'media'), localPath: media.local_path, assetsDir: this.assetsDir, workspaceId, mediaId, mime: media.mime, expectedBytes: media.bytes }); this.db.prepare('INSERT OR IGNORE INTO editor_assets VALUES(?,?,?,?,?)').run(pinned.asset.id, pinned.asset.version, workspaceId, mediaId, JSON.stringify(pinned.asset)); return pinned.asset; }
    images(workspaceId: string): AssetMetadata[] { const owner = this.owner(workspaceId); for (const row of this.db.prepare("SELECT id FROM media WHERE content_id=? AND current=1 AND kind='image' AND state='succeeded' ORDER BY media_order,id").all(owner.content_id) as Row[]) {
        try {
            this.selectImage(workspaceId, row.id);
        }
        catch { /* unavailable images remain explicit in the source record; never use a remote fallback */ }
    } return (this.db.prepare('SELECT json FROM editor_assets WHERE workspace_id=? ORDER BY rowid').all(workspaceId) as Row[]).map(x => JSON.parse(x.json)); }
    captureSource(contentId: number): void {
        const owner = this.db.prepare('SELECT * FROM editor_workspaces WHERE content_id=?').get(contentId) as Row | undefined;
        if (!owner)
            return;
        const content = this.db.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as Row;
        if (content.detail_state !== 'succeeded')
            return;
        const currentAssets: AssetMetadata[] = [];
        const currentMedia = this.db.prepare("SELECT id FROM media WHERE content_id=? AND current=1 AND kind='image' AND state='succeeded' ORDER BY media_order,id").all(contentId) as Row[];
        for (const media of currentMedia) {
            try {
                // History can contain several versions for one media ID. A new source
                // records only the exact bytes pinned from that media row now.
                currentAssets.push(this.selectImage(owner.id, media.id));
            }
            catch { /* Never substitute a historical version for unavailable current bytes. */ }
        }
        // Failed or unavailable detail responses never replace the last valid textual source.
        if (!content.source_body && !content.subtitle && !currentAssets.length)
            return;
        const previous = this.db.prepare('SELECT json FROM editor_sources WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(owner.id) as Row | undefined;
        if (!content.source_body && previous && (JSON.parse(previous.json) as SourceSnapshot).blocks.some(block => plainText(block.runs).length > 0))
            return;
        const blocks: SourceSnapshot['blocks'] = String(content.source_body).split(/\r?\n/).map((text, index) => ({ id: `source-block-${index}`, type: 'paragraph', runs: [{ text }] }));
        if (currentAssets.length)
            blocks.push({ id: 'source-images', type: 'paragraph', runs: [], assetRefs: currentAssets.map(a => ({ assetId: a.id, version: a.version })) });
        const signature = sha256(JSON.stringify({ blocks, subtitle: content.subtitle, complete: !!content.body_complete, kind: content.kind })), revisionId = `source-${signature}`, sourceId = `${owner.id}-source`;
        const source: SourceSnapshot = { workspaceId: owner.id, sourceId, sourceRevisionId: revisionId, blocks, sha256: sha256(JSON.stringify(blocks)), coverage: { complete: !!content.body_complete, description: content.kind === 'video' || content.kind === 'audio' ? '平台简介；不是音视频转录' : content.body_complete ? '已取得的来源正文与本地图片' : '仅已取得部分；未宣称完整' }, originalUrl: publicUrl(content.url) };
        this.db.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO editor_sources VALUES(?,?,?,?,?)').run(sourceId, revisionId, owner.id, JSON.stringify(source), Date.now()); this.db.prepare('UPDATE editor_workspaces SET last_source_revision=? WHERE id=?').run(revisionId, owner.id); if (content.subtitle) {
            const transcriptId = `${owner.id}-subtitle-${sha256(content.subtitle)}`;
            const segment: TranscriptSegment = { workspaceId: owner.id, transcriptId, revision: 1, segmentId: `${transcriptId}-text`, runs: [{ text: content.subtitle }] };
            this.db.prepare('INSERT OR IGNORE INTO editor_transcripts VALUES(?,?,?,?,?)').run(transcriptId, 1, segment.segmentId, owner.id, JSON.stringify(segment));
        } })();
    }
    private requireAssets(refs: AssetRef[], workspaceId: string): void { for (const ref of refs) {
        const a = this.asset(workspaceId, ref);
        if (!a)
            throw new Error('图片版本不存在或不属于当前工作区');
        readFixedAsset(this.assetsDir, a);
    } }
    resolve(workspaceId: string, ref: SourceReference, pending: Map<string, ContentDocument> = new Map()): ResolvedReference { this.owner(workspaceId); validateSourceReference(ref); let text: string, assets: AssetRef[] = [], version: string, targetId: string, transcript: ResolvedReference['transcript']; if (ref.kind === 'capturedSource') {
        const row = this.db.prepare('SELECT json FROM editor_sources WHERE source_id=? AND revision_id=? AND workspace_id=?').get(ref.sourceId, ref.sourceRevisionId, workspaceId) as Row | undefined;
        if (!row)
            throw new Error('引用时来源版本不存在');
        const source = JSON.parse(row.json) as SourceSnapshot;
        const block = findDraftBlock(source.blocks, ref.blockId);
        if (!block)
            throw new Error('引用时来源段落不存在');
        text = plainText(block.runs);
        assets = clone(block.assetRefs ?? []);
        version = ref.sourceRevisionId;
        targetId = ref.blockId;
    }
    else if (ref.kind === 'transcript') {
        const asr = resolveAsrReference(this.db,workspaceId,ref); if(asr){this.requireAssets(asr.assets,workspaceId);return asr;}
        const row = this.db.prepare('SELECT json FROM editor_transcripts WHERE transcript_id=? AND revision=? AND segment_id=? AND workspace_id=?').get(ref.transcriptId, ref.revision, ref.segmentId, workspaceId) as Row | undefined;
        if (!row)
            throw new Error('引用时字幕版本不存在');
        const segment = JSON.parse(row.json) as TranscriptSegment;
        transcript = assertTranscriptReference(ref, segment);
        text = plainText(segment.runs);
        version = String(ref.revision);
        targetId = ref.segmentId;
    }
    else if(ref.kind==='ocr'){return resolveOcrReference(this.db,this.assetsDir,workspaceId,ref);}
    else {
        const document = pending.get(`${ref.documentId}:${ref.revision}`) ?? this.version(ref.documentId, ref.revision);
        if (!('blocks' in document) || document.workspaceId !== workspaceId)
            throw new Error('整理稿引用归属不符');
        const block = findDraftBlock(document.blocks, ref.blockId);
        if (!block)
            throw new Error('引用时整理稿段落不存在');
        text = plainText(block.runs);
        assets = clone(block.assetRefs ?? []);
        version = String(ref.revision);
        targetId = ref.blockId;
    } let selectedText = text; if (ref.range) {
        const r = ref.range;
        if (r.end > pointLength(text))
            throw new Error('引用选区超出版本范围');
        selectedText = pointSlice(text, r.start, r.end);
        if (r.excerpt !== undefined && r.excerpt !== selectedText)
            throw new Error('引用摘录与固定版本不符');
        if (r.before !== undefined && r.before !== pointSlice(text, Math.max(0, r.start - pointLength(r.before)), r.start))
            throw new Error('引用前文不符');
        if (r.after !== undefined && r.after !== pointSlice(text, r.end, r.end + pointLength(r.after)))
            throw new Error('引用后文不符');
    } assets.push(...clone(ref.assets ?? [])); this.requireAssets(assets, workspaceId); return { kind: ref.kind, text, selectedText, assets, version, targetId, ...(transcript ? { transcript } : {}) }; }
    private validateReferences(document: ContentDocument, pending: Map<string, ContentDocument>, previous?: ContentDocument): void { if ('blocks' in document)
        this.requireAssets(getDraftAssetRefs(document.blocks), document.workspaceId);
    else
        for (const node of Object.values(document.nodes)) {
            if (node.image)
                this.requireAssets([node.image], document.workspaceId);
            for (const ref of node.sourceRefs) {
                try { this.resolve(document.workspaceId, ref, pending); }
                catch (error) {
                    // Preserve only a citation already saved on this same node.
                    // It stays unresolved: no new range, target or verified export.
                    const preserved = previous && !('blocks' in previous) && previous.nodes[node.id]?.sourceRefs.some(saved => isDeepStrictEqual(saved, ref));
                    if (!(error instanceof AsrSourceUnavailableError) || !preserved) throw error;
                    this.requireAssets(ref.assets ?? [], document.workspaceId);
                }
            }
        } }
    injectFailureOnce(message = '模拟写入失败'): void { this.failureNext = message; }
    save(requests: SaveRequest[], options: {
        failAfterFirst?: boolean;
    } = {}): SaveResult[] { const identity = (r: SaveRequest) => ({ workspaceId: r?.workspaceId ?? 'invalid', documentId: r?.documentId ?? 'invalid', sessionId: r?.sessionId ?? 'invalid', requestId: r?.requestId ?? 'invalid' }); try {
        if (!Array.isArray(requests) || !requests.length || requests.length > 2)
            throw new Error('保存需要一或两份文档');
        const ids = new Set<string>();
        for (const r of requests) {
            validateSaveRequest(r);
            if (ids.has(r.documentId))
                throw new Error('重复文档');
            ids.add(r.documentId);
        }
        if (new Set(requests.map(r => r.workspaceId)).size !== 1)
            throw new Error('不能跨工作区保存');
        return this.db.transaction(() => { const pending = new Map<string, ContentDocument>(), conflicts = new Map<string, number>(); for (const r of requests) {
            const owner = this.owner(r.workspaceId), workspace = JSON.parse(owner.json) as Workspace, row = this.db.prepare('SELECT * FROM editor_documents WHERE id=? AND workspace_id=?').get(r.documentId, r.workspaceId) as Row | undefined;
            const kind = 'blocks' in r.document ? 'draft' : 'map';
            if (!row || row.kind !== kind || r.documentId !== (kind === 'draft' ? workspace.draftDocumentId : workspace.mindMapDocumentId))
                throw new Error('文档归属或类型不符');
            if (row.current_revision !== r.expectedRevision)
                conflicts.set(r.documentId, row.current_revision);
            const next = clone(r.document);
            next.revision = r.expectedRevision + 1;
            pending.set(`${r.documentId}:${next.revision}`, next);
        } if (conflicts.size)
            return requests.map(r => conflicts.has(r.documentId) ? { status: 'conflict', ...identity(r), actualRevision: conflicts.get(r.documentId)! } : { status: 'failed', ...identity(r), error: '同批文档版本冲突' }) as SaveResult[]; for (const doc of pending.values()) {
            validateDocument(doc);
            this.validateReferences(doc, pending, this.version(doc.documentId));
        } if (this.failureNext) {
            const error = this.failureNext;
            this.failureNext = null;
            throw new Error(error);
        } const humanChanged=requests.some(r=>{const old=clone(this.version(r.documentId)),next=clone(r.document);old.revision=0;next.revision=0;return !isDeepStrictEqual(old,next);});
          for (const [index, r] of requests.entries()) {
            const doc = pending.get(`${r.documentId}:${r.expectedRevision + 1}`)!;
            this.db.prepare('INSERT INTO editor_versions VALUES(?,?,?,?)').run(doc.documentId, doc.revision, JSON.stringify(doc), Date.now());
            this.db.prepare('UPDATE editor_documents SET current_revision=? WHERE id=?').run(doc.revision, doc.documentId);
            const workspace = JSON.parse(this.owner(r.workspaceId).json) as Workspace;
            if ('blocks' in doc)
                workspace.draftRevision = doc.revision;
            else
                workspace.mapRevision = doc.revision;
            this.db.prepare('UPDATE editor_workspaces SET json=?,updated_at=? WHERE id=?').run(JSON.stringify(workspace), Date.now(), workspace.id);
            if (index === 0 && options.failAfterFirst)
                throw new Error('注入首文档后故障');
        } if(humanChanged)markGenerationManual(this.db,this.owner(requests[0].workspaceId).content_id);
          return requests.map(r => ({ status: 'saved', ...identity(r), committedRevision: r.expectedRevision + 1 })) as SaveResult[]; })();
    }
    catch {
        return (Array.isArray(requests) ? requests : []).map(r => ({ status: 'failed', ...identity(r), error: '保存未完成，请保留当前稿后重试；若持续失败请查看本地诊断' }));
    } }
    history(workspaceId: string): EditorHistory { const owner = this.owner(workspaceId), w = JSON.parse(owner.json) as Workspace; const list = (documentId: string, kind: 'draft' | 'map') => (this.db.prepare('SELECT revision,saved_at FROM editor_versions WHERE document_id=? ORDER BY revision DESC LIMIT 50').all(documentId) as Row[]).map(x => ({ revision: x.revision, savedAt: x.saved_at, kind })); return { draft: list(w.draftDocumentId, 'draft'), map: list(w.mindMapDocumentId, 'map') }; }
    restore(workspaceId: string, kind: 'draft' | 'map', revision: number, expectedRevision: number, sessionId: string, requestId: string): SaveResult { const owner = this.owner(workspaceId), w = JSON.parse(owner.json) as Workspace; if (!['draft', 'map'].includes(kind))
        throw new Error('版本类型无效'); positive(revision); const documentId = kind === 'draft' ? w.draftDocumentId : w.mindMapDocumentId, document = clone(this.version(documentId, revision)); document.revision = expectedRevision; return this.db.transaction(()=>{const result=this.save([{ workspaceId, documentId, sessionId, requestId, expectedRevision, document }])[0];if(result.status==='saved')markGenerationManual(this.db,owner.content_id);return result;})(); }
    list(): EditorWorkspaceRecord[] { return (this.db.prepare('SELECT id FROM editor_workspaces ORDER BY updated_at DESC').all() as Row[]).map(x => this.load(x.id)); }
    /** Trusted pipeline adoption only; never overwrites any manually initialized workspace. */
    adoptGeneratedBundle(contentId:number,bundle:WorkspaceBundle):boolean{positive(contentId);validateBundle(bundle);return this.db.transaction(()=>{if(this.db.prepare('SELECT id FROM editor_workspaces WHERE content_id=?').get(contentId))return false;const content=this.db.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as Row|undefined;if(!content||bundle.workspace.collectionId!==`${content.platform}:${content.account_id}:${content.source_id}`||bundle.draft.revision!==1||bundle.map.revision!==1)throw new Error('生成工作区归属或初始版本无效');for(const asset of bundle.assets)readFixedAsset(this.assetsDir,asset);insertBundle(this.db,content,bundle,Date.now());for(const asset of bundle.assets){const mediaId=Number(asset.id.split('-media-').at(-1));const owner=this.db.prepare('SELECT content_id FROM media WHERE id=?').get(mediaId) as Row|undefined;if(!owner||owner.content_id!==contentId)throw new Error('生成图片不属于当前收藏');this.db.prepare('INSERT INTO editor_assets VALUES(?,?,?,?,?)').run(asset.id,asset.version,bundle.workspace.id,mediaId,JSON.stringify(asset));}for(const source of bundle.sources){if(source.sha256!==sha256(JSON.stringify(source.blocks)))throw new Error('生成来源快照摘要无效');this.db.prepare('INSERT INTO editor_sources VALUES(?,?,?,?,?)').run(source.sourceId,source.sourceRevisionId,bundle.workspace.id,JSON.stringify(source),Date.now());}for(const segment of bundle.transcripts)this.db.prepare('INSERT INTO editor_transcripts VALUES(?,?,?,?,?)').run(segment.transcriptId,segment.revision,segment.segmentId,bundle.workspace.id,JSON.stringify(segment));this.validateReferences(bundle.draft,new Map());this.validateReferences(bundle.map,new Map());this.db.prepare('UPDATE editor_workspaces SET last_source_revision=? WHERE id=?').run(bundle.sources.at(-1)?.sourceRevisionId??null,bundle.workspace.id);return true;})();}
    putPreview(preview: EditorPreview): boolean { const current = this.load(preview.workspaceId); if (preview.mapRevision !== current.bundle.map.revision)
        return false; if (typeof preview.configKey !== 'string' || preview.configKey.length > 200)
        throw new Error('预览配置无效'); if (preview.state === 'ready' && (!preview.svg || preview.svg.length > 5000000 || /<(?:script|foreignObject)\b|(?:href|src)\s*=\s*["']?(?:https?:|file:|javascript:)/i.test(preview.svg)))
        throw new Error('预览内容无效'); this.db.prepare('INSERT INTO editor_previews VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,map_revision,config_key) DO UPDATE SET state=excluded.state,svg=excluded.svg,error=excluded.error').run(preview.workspaceId, preview.mapRevision, preview.configKey, preview.state, preview.svg ?? null, preview.error ?? null); return true; }
    previews(): EditorPreview[] { return (this.db.prepare('SELECT p.* FROM editor_previews p JOIN editor_workspaces w ON w.id=p.workspace_id JOIN editor_documents d ON d.workspace_id=w.id AND d.kind=\'map\' AND d.current_revision=p.map_revision ORDER BY w.updated_at DESC').all() as Row[]).map(x => ({ workspaceId: x.workspace_id, mapRevision: x.map_revision, configKey: x.config_key, state: x.state, ...(x.svg ? { svg: x.svg } : {}), ...(x.error ? { error: x.error } : {}) })); }
}
export function publicUrl(value: string): string { try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
        throw new Error();
    return u.origin + u.pathname;
}
catch {
    return 'https://www.xiaohongshu.com/';
} }
