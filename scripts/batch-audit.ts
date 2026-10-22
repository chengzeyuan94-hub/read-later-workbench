/** Read-only acceptance checks. Never constructs Store, starts Electron, or writes SQLite. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBatchOrdinaryPath, resolveBatchPaths } from '../src/main/batch-isolation.js';
import { resolveE3RealPaths } from '../src/main/e3-real-isolation.js';
import { sha256File } from '../src/main/editor-media.js';
import { plainText, textBlocks, validateDraft, validateMap } from '../src/editor-core/model.js';

type Row = Record<string, any>;
const project = process.cwd();
const paths = resolveBatchPaths(process.env.RLW_BATCH_DIR, { mustExist: true, projectRoot: project });
const baselineFile = path.join(paths.evidenceDir, 'batch-protection-baseline.json');
const snapshot = JSON.parse(readFileSync(path.join(paths.evidenceDir, 'batch-snapshot.json'), 'utf8'));
if (snapshot.target !== paths.root || snapshot.profileCopied !== false || snapshot.credentialsCopied !== false) throw Error('克隆基线与本轮根不一致');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = path.join(project, '.runtime/node24.node');
function openReadOnly(root: string): Database.Database {
  const file = path.join(root, 'data/workbench.sqlite'); assertBatchOrdinaryPath(file);
  const db = new Database(file, { readonly: true, fileMustExist: true, nativeBinding: binding });
  db.pragma('query_only=ON');
  if (!db.readonly || db.pragma('query_only', { simple: true }) !== 1) { db.close(); throw Error('验收仅允许只读 SQLite'); }
  return db;
}
const tables = ['contents', 'editor_workspaces', 'editor_documents', 'editor_versions', 'generation_editor_meta'] as const;
if (process.argv.includes('--capture-baseline')) {
  if (existsSync(baselineFile)) throw Error('保护基线已存在，拒绝覆盖；去掉 --capture-baseline 直接复检');
  const source = resolveE3RealPaths(snapshot.source, { mustExist: true, projectRoot: project });
  const db = openReadOnly(source.root);
  let baseline: Row;
  try {
    baseline = db.transaction(() => {
      const rows = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]]));
      for (const table of tables) if (rows[table].length !== snapshot.before[table]?.count || hash(rows[table]) !== snapshot.before[table]?.sha256) throw Error('旧来源已变化，不能从它重建克隆时保护基线');
      const manual = rows.generation_editor_meta.filter(row => row.origin === 'human' || row.manual_epoch > 0);
      const workspaceIds = new Set(manual.map(row => row.workspace_id));
      return {
        schema: 1, root: paths.root, createdAt: new Date().toISOString(), snapshotSha256: sha256File(path.join(paths.evidenceDir, 'batch-snapshot.json')),
        contents: rows.contents.map(row => ({ id: row.id, identitySha: hash([row.platform, row.account_id, row.source_id]), editedBodySha: hash(row.edited_body), sourceBodySha: hash(row.source_body), digestedAt: row.digested_at })),
        versions: rows.editor_versions.map(row => ({ documentId: row.document_id, revision: row.revision, sha256: hash(row) })),
        manual: manual.map(row => ({ contentId: row.content_id, workspaceId: row.workspace_id, manualEpoch: row.manual_epoch })),
        manualDocuments: rows.editor_documents.filter(row => workspaceIds.has(row.workspace_id)).map(row => ({ id: row.id, workspaceId: row.workspace_id, revision: row.current_revision })),
        manualWorkspaces: rows.editor_workspaces.filter(row => workspaceIds.has(row.id)).map(row => ({ id: row.id, jsonSha: hash(row.json) })),
      };
    })();
  } finally { db.close(); }
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
if (baseline.schema !== 1 || baseline.root !== paths.root || baseline.snapshotSha256 !== sha256File(path.join(paths.evidenceDir, 'batch-snapshot.json'))) throw Error('保护基线身份或克隆快照已变化');
const db = openReadOnly(paths.root);
let database: Row;
try {
  database = db.transaction(() => {
    const missingContents: number[] = [], changedIdentities: number[] = [], changedEditedBodies: number[] = [], changedSourceBodies: number[] = [], clearedDigested: number[] = [];
    for (const old of baseline.contents) {
      const row = db.prepare('SELECT * FROM contents WHERE id=?').get(old.id) as Row | undefined;
      if (!row) { missingContents.push(old.id); continue; }
      if (hash([row.platform, row.account_id, row.source_id]) !== old.identitySha) changedIdentities.push(old.id);
      if (hash(row.edited_body) !== old.editedBodySha) changedEditedBodies.push(old.id);
      if (hash(row.source_body) !== old.sourceBodySha) changedSourceBodies.push(old.id);
      if (old.digestedAt != null && row.digested_at == null) clearedDigested.push(old.id);
    }
    const changedVersions: { documentId: string; revision: number }[] = [];
    for (const old of baseline.versions) {
      const row = db.prepare('SELECT * FROM editor_versions WHERE document_id=? AND revision=?').get(old.documentId, old.revision);
      if (!row || hash(row) !== old.sha256) changedVersions.push({ documentId: old.documentId, revision: old.revision });
    }
    const manualMetaProblems: number[] = [], advancedManualDocuments: string[] = [], changedManualWorkspaces: string[] = [];
    for (const old of baseline.manual) {
      const row = db.prepare('SELECT * FROM generation_editor_meta WHERE content_id=?').get(old.contentId) as Row | undefined;
      if (!row || row.workspace_id !== old.workspaceId || row.origin !== 'human' || row.manual_epoch < old.manualEpoch) manualMetaProblems.push(old.contentId);
    }
    for (const old of baseline.manualDocuments) {
      const row = db.prepare('SELECT * FROM editor_documents WHERE id=?').get(old.id) as Row | undefined;
      if (!row || row.workspace_id !== old.workspaceId || row.current_revision !== old.revision) advancedManualDocuments.push(old.id);
    }
    for (const old of baseline.manualWorkspaces) {
      const row = db.prepare('SELECT json FROM editor_workspaces WHERE id=?').get(old.id) as Row | undefined;
      if (!row || hash(row.json) !== old.jsonSha) changedManualWorkspaces.push(old.id);
    }
    const hasTable = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const oldIds = new Set<number>(baseline.contents.map((row: Row) => row.id));
    const identities = db.prepare('SELECT id,platform,account_id,source_id FROM contents ORDER BY id').all() as Row[];
    const originalNewOverlap = [...new Set(identities.map(row => row.platform))].map(platform => {
      const old = identities.filter(row => row.platform === platform && oldIds.has(row.id));
      const fresh = identities.filter(row => row.platform === platform && !oldIds.has(row.id));
      const sameSource: Row[] = [];
      for (const a of old) for (const b of fresh) if (a.source_id === b.source_id) sameSource.push({ oldContentId: a.id, newContentId: b.id, sameAccount: a.account_id === b.account_id });
      return { platform, original: old.length, added: fresh.length, originalAccounts: new Set(old.map(row => row.account_id)).size, newAccounts: new Set(fresh.map(row => row.account_id)).size, sameAccountSeen: old.some(a => fresh.some(b => a.account_id === b.account_id)), sameSource };
    });
    const batchItems = hasTable('batch_digest_items') ? db.prepare('SELECT i.content_id,c.platform,c.kind,i.state,i.retry_count FROM batch_digest_items i JOIN contents c ON c.id=i.content_id ORDER BY i.selected_at,i.content_id').all() as Row[] : [];
    const sampleCandidates = batchItems.filter(row => row.state === 'complete');
    const completedPairs = sampleCandidates.map(item => {
      const problems: string[] = [];
      const artifactRow = db.prepare('SELECT a.* FROM generation_artifacts a JOIN batch_digest_items i ON i.content_id=a.content_id AND i.request_id=a.request_id WHERE a.content_id=? AND a.installed=1 ORDER BY a.created_at DESC LIMIT 1').get(item.content_id) as Row | undefined;
      if (!artifactRow) return { contentId: item.content_id, platform: item.platform, valid: false, problems: ['completed-without-installed-pair'] };
      const artifact = JSON.parse(artifactRow.json);
      const request = db.prepare('SELECT * FROM generation_requests WHERE request_id=?').get(artifactRow.request_id) as Row;
      const digest = db.prepare('SELECT * FROM digest_requests WHERE id=?').get(artifactRow.request_id) as Row;
      const scope = JSON.parse(digest.scope_json), input = JSON.parse(request.input_json);
      const content = db.prepare('SELECT platform,account_id,source_id FROM contents WHERE id=?').get(item.content_id) as Row;
      const library = db.prepare('SELECT * FROM digest_library WHERE content_id=?').get(item.content_id) as Row | undefined;
      const storedBundle = library?.bundle_json ? JSON.parse(library.bundle_json) : null;
      const sameRequest = request.content_id === item.content_id && digest.content_id === item.content_id && library?.request_id === artifactRow.request_id;
      const sameSource = artifact.sourceRevisionId === request.scope_revision && input.sourceRevisionId === request.scope_revision && scope.input.revisionId === request.scope_revision && scope.input.platform === content.platform && scope.input.accountId === content.account_id && scope.input.sourceId === content.source_id;
      if (!sameRequest) problems.push('request-mismatch');
      if (!sameSource) problems.push('source-mismatch');
      if (artifact.sourceSha256 !== hash(input) || request.input_sha !== hash(input) || artifact.draftSha256 !== hash(artifact.draft)) problems.push('artifact-content-hash-mismatch');
      try { validateDraft(artifact.draft); validateMap(artifact.map); } catch { problems.push('invalid-document-schema'); }
      const draftChars = textBlocks(artifact.draft.blocks).map(block => plainText(block.runs)).join('\n').trim().length;
      const nodes = Object.values(artifact.map.nodes) as Row[];
      const nonemptyNodes = nodes.filter(node => plainText(node.title).trim()).length;
      if (!draftChars || nodes.length < 2 || nonemptyNodes !== nodes.length) problems.push('empty-document-or-map');
      if (artifact.draft.workspaceId !== artifact.map.workspaceId) problems.push('pair-workspace-mismatch');
      const saved = [artifact.draft, artifact.map].map(document => {
        const version = db.prepare('SELECT json FROM editor_versions WHERE document_id=? AND revision=?').get(document.documentId, document.revision) as Row | undefined;
        const current = db.prepare('SELECT workspace_id,current_revision FROM editor_documents WHERE id=?').get(document.documentId) as Row | undefined;
        const versionPreserved = !!version && hash(JSON.parse(version.json)) === hash(document);
        if (!versionPreserved || current?.workspace_id !== document.workspaceId || current.current_revision < document.revision) problems.push('saved-version-invalid');
        return { revision: document.revision, currentRevision: current?.current_revision, versionPreserved };
      });
      // The publication snapshot stays paired even if a later, intentional UI edit advances current documents.
      if (!storedBundle || hash(storedBundle.draft) !== hash(artifact.draft) || hash(storedBundle.map) !== hash(artifact.map)) problems.push('library-pair-mismatch');
      const fileEntries = JSON.parse(artifactRow.files_json) as Row[];
      const base = path.join(paths.dataDir, 'generation-results', artifactRow.base_path);
      if (path.isAbsolute(artifactRow.base_path) || artifactRow.base_path.split('/').includes('..')) throw Error('成对成果路径无效');
      let markdownBytes = 0;
      for (const entry of fileEntries) {
        if (path.isAbsolute(entry.relativePath) || entry.relativePath.split('/').includes('..')) throw Error('成对成果文件路径无效');
        const file = path.join(base, entry.relativePath);
        try { assertBatchOrdinaryPath(file); if (sha256File(file) !== entry.sha256) problems.push('artifact-file-hash-mismatch'); if (entry.relativePath === 'document.md') markdownBytes = statSync(file).size; }
        catch { problems.push('artifact-file-missing'); }
      }
      if (!markdownBytes || !fileEntries.some(entry => entry.relativePath === 'pair.json')) problems.push('paired-files-missing');
      return { contentId: item.content_id, platform: item.platform, kind: item.kind, valid: !problems.length, sameRequest, sameSource, draftChars, draftBlocks: artifact.draft.blocks.length, mapNodes: nodes.length, nonemptyNodes, markdownBytes, filesChecked: fileEntries.length, draft: saved[0], map: saved[1], problems: [...new Set(problems)] };
    });
    const sample: Row[] = [];
    // At most six: cover each source/media group first, then fill from the remaining complete items.
    for (const row of sampleCandidates) if (sample.length < 6 && !sample.some(prior => prior.platform === row.platform && prior.kind === row.kind)) sample.push(row);
    for (const row of sampleCandidates) if (sample.length < 6 && !sample.some(prior => prior.content_id === row.content_id)) sample.push(row);
    return {
      readOnly: db.readonly, queryOnly: db.pragma('query_only', { simple: true }) === 1, schema: db.pragma('user_version', { simple: true }), quickCheck: db.pragma('quick_check', { simple: true }), foreignKeyProblems: (db.pragma('foreign_key_check') as Row[]).length,
      originalContents: { expected: baseline.contents.length, missingContents, changedIdentities, changedEditedBodies, changedSourceBodies, clearedDigested },
      historicalVersions: { expected: baseline.versions.length, changedVersions },
      manualDrafts: { expectedWorkspaces: baseline.manual.length, expectedDocuments: baseline.manualDocuments.length, manualMetaProblems, advancedManualDocuments, changedManualWorkspaces, note: '指针或工作区变化需要与本轮明确人工编辑核对；旧历史版本必须逐条保留' },
      contents: db.prepare('SELECT platform,kind,detail_state,availability,count(*) count FROM contents GROUP BY platform,kind,detail_state,availability ORDER BY platform,kind,detail_state,availability').all(),
      duplicates: db.prepare('SELECT count(*) count FROM (SELECT 1 FROM contents GROUP BY platform,account_id,source_id HAVING count(*)>1)').get(),
      media: db.prepare('SELECT kind,state,current,count(*) count FROM media GROUP BY kind,state,current ORDER BY kind,state,current').all(),
      scopes: hasTable('recent_import_scopes') ? db.prepare('SELECT platform,requested_limit,json_array_length(target_json) targetCount,json_array_length(observed_json) observedCount,target_complete,history_complete,reliable,paused_reason FROM recent_import_scopes ORDER BY platform').all() : [],
      originalNewOverlap, batchItems, completedPairs, calls: hasTable('batch_digest_submissions') ? db.prepare('SELECT kind,count(*) count,sum(duration_ms)/60000 minutes FROM batch_digest_submissions GROUP BY kind').all() : [],
      suggestedOfflineExportSamples: sample.map(({ content_id, platform, kind }) => ({ contentId: content_id, platform, kind })),
    };
  })();
} finally { db.close(); }

const resourceFailures: { path: string; reason: string }[] = [];
for (const resource of snapshot.resources) {
  if (typeof resource.path !== 'string' || !/^(data|editor-assets|exports)\//.test(resource.path) || path.isAbsolute(resource.path) || resource.path.split('/').includes('..')) throw Error('资源基线路径无效');
  const file = path.join(paths.root, resource.path);
  try { assertBatchOrdinaryPath(file); if (!statSync(file).isFile() || statSync(file).size !== resource.bytes || sha256File(file) !== resource.sha256) resourceFailures.push({ path: resource.path, reason: 'changed' }); }
  catch { resourceFailures.push({ path: resource.path, reason: 'missing-or-unsafe' }); }
}
// Hash the three explicitly baselined formal files without opening formal SQLite or login profiles.
const formalDir = path.join(os.homedir(), 'Library/Application Support/ReadLaterWorkbench/round-01-data');
const formalBefore = JSON.parse(readFileSync(path.join(paths.evidenceDir, 'formal-files-before.json'), 'utf8'));
const formal = formalBefore.files.map((old: Row) => {
  if (!['workbench.sqlite','workbench.sqlite-wal','workbench.sqlite-shm'].includes(old.name)) throw Error('正式文件基线范围无效');
  const file = path.join(formalDir, old.name);
  try { assertBatchOrdinaryPath(file); return { name: old.name, unchanged: statSync(file).size === old.bytes && sha256File(file) === old.sha256 }; }
  catch { return { name: old.name, unchanged: false }; }
});
const issues = database.originalContents;
const preserved = database.quickCheck === 'ok' && database.foreignKeyProblems === 0 && !issues.missingContents.length && !issues.changedIdentities.length && !issues.changedEditedBodies.length && !issues.clearedDigested.length && !database.historicalVersions.changedVersions.length && !database.manualDrafts.manualMetaProblems.length && !database.manualDrafts.advancedManualDocuments.length && !database.manualDrafts.changedManualWorkspaces.length && !resourceFailures.length && formal.every((row: Row) => row.unchanged);
const completedPairsValid = database.completedPairs.every((row: Row) => row.valid);
const report = { schema: 1, createdAt: new Date().toISOString(), root: paths.root, preserved, completedPairsValid, database, originalResources: { checked: snapshot.resources.length, failures: resourceFailures }, formal, note: '保留校验通过不等于新批量功能验收通过；离线播放、编辑及原生导出仍需 UI 实测' };
const outputDir = path.join(paths.evidenceDir, 'batch-audits'); assertBatchOrdinaryPath(outputDir); mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const output = path.join(outputDir, `audit-${Date.now()}.json`); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, preserved, originalContents: baseline.contents.length, historicalVersions: baseline.versions.length, manualWorkspaces: baseline.manual.length, manualDocuments: baseline.manualDocuments.length, changedManualDocuments: database.manualDrafts.advancedManualDocuments.length, resourcesChecked: snapshot.resources.length, resourceFailures: resourceFailures.length, formal, scopes: database.scopes, completedPairs: database.completedPairs, calls: database.calls, sample: database.suggestedOfflineExportSamples }));
if (!preserved || !completedPairsValid) process.exitCode = 1;
