/** Read-only E11 audit. It never constructs Store/repositories, recovers work,
 * migrates, probes a helper, dispatches a task, or reads a formal/E1 directory. */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveE11Paths } from '../src/main/e11-isolation.js';
import { boundedFile, readFixedAsset, sha256, sha256File } from '../src/main/editor-media.js';
import { pointLength, pointSlice, validateDocument, validateSource, validateSourceReference, validateTranscript, type SourceReference } from '../src/editor-core/model.js';
import { validateNativeOutput, type OcrJobToken } from '../src/main/ocr-store.js';
import type { DigestInternalScope } from '../src/shared/digest-contracts.js';
import type { OcrResult } from '../src/shared/ocr-contracts.js';
type Row = Record<string, any>;
export interface E11File { path: string; bytes: number; sha256: string }
export interface E11Table { count: number; sha256: string }
export interface E11Audit {
  kind: 'editor-e11-readonly-audit'; schema: number; readOnly: true; queryOnly: true; integrity: boolean;
  tables: Record<string, E11Table>; resources: E11File[]; resourcesSha256: string;
  calls: { ocr: number; probes: number; digestReal: Record<string, number>; digestSynthetic: Record<string, number> };
  requests: { total: number; real: number; synthetic: number; activeReal: number; selectedImages: number };
  ocr: { jobs: Record<string, number>; results: number; corrections: number; adoptions: number };
  library: { legacy: number; realGenerated: number; syntheticGenerated: number };
  issues: { code: string; identity: string }[]; valid: boolean;
  nativeBuild?: { helperSha256: string; declaredSha256: string; matches: boolean };
}
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
/** Sorted row encodings make this independent of SQLite physical page layout. */
export function tableSnapshot(db: Database.Database): Record<string, E11Table> {
  const result: Record<string, E11Table> = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
    const count = Number((db.prepare(`SELECT count(*) n FROM ${quote(name)}`).get() as Row).n);
    if (count > 200_000) throw new Error('隔离审计表行数超过有界检查上限');
    const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row)).sort();
    result[name] = { count, sha256: sha256(JSON.stringify(rows)) };
  }
  return result;
}
/** Streaming hashes, no media decode, following no symlinks. Empty dirs are
 * recorded by the upgrade manifest separately; this list describes file bytes. */
export function treeFiles(root: string, prefix = ''): E11File[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('资源目录不能使用符号链接或别名');
  const output: E11File[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = path.join(relative, entry.name), file = path.join(root, item), info = lstatSync(file);
      if (info.isSymbolicLink() || realpathSync(file) !== file) throw new Error('资源包含符号链接或路径别名');
      if (info.isDirectory()) walk(item);
      else if (info.isFile()) output.push({ path: path.posix.join(prefix, item.split(path.sep).join('/')), bytes: info.size, sha256: sha256File(file) });
      else throw new Error('资源包含非普通文件');
      if (output.length > 100_000) throw new Error('隔离资源数量超过有界检查上限');
    }
  };
  walk(''); return output.sort((a, b) => a.path.localeCompare(b.path));
}
export function resourceSnapshot(dataDir: string, assetsDir: string): E11File[] {
  return [...treeFiles(dataDir, 'data').filter(f => !/^data\/workbench\.sqlite(?:-wal|-shm)?$/.test(f.path)), ...treeFiles(assetsDir, 'editor-assets')].sort((a, b) => a.path.localeCompare(b.path));
}
const binding = () => process.env.RLW_SQLITE_BINDING || path.resolve('.runtime/node24.node');
function auditOcrReference(db: Database.Database, assetsDir: string, workspaceId: string, ref: Extract<SourceReference, { kind: 'ocr' }>): void {
  validateSourceReference(ref);
  const owner = db.prepare('SELECT content_id FROM editor_workspaces WHERE id=?').get(workspaceId) as Row | undefined;
  const raw = db.prepare('SELECT json FROM ocr_results WHERE result_id=? AND content_id=?').get(ref.resultId, owner?.content_id ?? -1) as Row | undefined;
  if (!raw || ref.revision !== 1) throw new Error('unresolved OCR owner or version');
  const result = JSON.parse(raw.json) as OcrResult;
  const correction = ref.correctionRevision === undefined ? null : db.prepare('SELECT json FROM ocr_corrections WHERE result_id=? AND revision=?').get(ref.resultId, ref.correctionRevision) as Row | undefined;
  if (ref.correctionRevision !== undefined && !correction) throw new Error('unresolved correction');
  const block = (correction ? JSON.parse(correction.json).blocks : result.blocks).find((b: Row) => b.id === ref.blockId);
  if (!block) throw new Error('unresolved OCR block');
  const range = ref.range;
  if (range && (range.end > pointLength(block.text) || range.excerpt !== undefined && range.excerpt !== pointSlice(block.text, range.start, range.end) || range.before !== undefined && range.before !== pointSlice(block.text, Math.max(0, range.start - pointLength(range.before)), range.start) || range.after !== undefined && range.after !== pointSlice(block.text, range.end, range.end + pointLength(range.after)))) throw new Error('OCR excerpt changed');
  readFixedAsset(assetsDir, result.asset);
  for (const asset of ref.assets ?? []) {
    const found = db.prepare('SELECT json FROM editor_assets WHERE workspace_id=? AND id=? AND version=?').get(workspaceId, asset.assetId, asset.version) as Row | undefined;
    if (!found) throw new Error('unresolved OCR attachment');
    readFixedAsset(assetsDir, JSON.parse(found.json));
  }
}
export function auditE11(root: string): E11Audit {
  const p = resolveE11Paths(root, { mustExist: true }), file = path.join(p.dataDir, 'workbench.sqlite');
  const db = new Database(file, { readonly: true, fileMustExist: true, nativeBinding: binding() });
  try {
    db.pragma('query_only=ON');
    return db.transaction((): E11Audit => {
      const schema = Number(db.pragma('user_version', { simple: true }));
      if (![4, 6, 7].includes(schema)) throw new Error('只读审计仅接受隔离schema 4、6或7；拒绝未知版本');
      const tables = tableSnapshot(db), has = (name: string) => !!tables[name];
      const rows = (sql: string, ...parameters: any[]): Row[] => db.prepare(sql).all(...parameters) as Row[];
      const issue = (code: string, identity: string | number) => issues.push({ code, identity: String(identity) });
      const issues: E11Audit['issues'] = [];
      const integrity = db.pragma('quick_check', { simple: true }) === 'ok' && (db.pragma('foreign_key_check') as unknown[]).length === 0;
      if (!integrity) issue('sqlite-integrity', 'database');
      const resources = resourceSnapshot(p.dataDir, p.assetsDir);
      const calls: E11Audit['calls'] = { ocr: tables.ocr_calls?.count ?? 0, probes: tables.ocr_probe_calls?.count ?? 0, digestReal: {}, digestSynthetic: {} };
      if (has('digest_calls')) for (const c of rows('SELECT c.stage,r.synthetic,count(*) n FROM digest_calls c JOIN digest_requests r ON r.id=c.request_id GROUP BY c.stage,r.synthetic')) (c.synthetic ? calls.digestSynthetic : calls.digestReal)[c.stage] = c.n;
      const requests: E11Audit['requests'] = { total: tables.digest_requests?.count ?? 0, real: 0, synthetic: 0, activeReal: 0, selectedImages: 0 };
      const scopes = new Map<string, { request: Row; scope: DigestInternalScope }>();
      if (has('digest_requests')) for (const request of rows('SELECT * FROM digest_requests ORDER BY id')) {
        request.synthetic ? requests.synthetic++ : requests.real++;
        if (!request.synthetic && !['cancelled', 'complete'].includes(request.state)) requests.activeReal++;
        try {
          const scope = JSON.parse(request.scope_json) as DigestInternalScope;
          const owner = rows('SELECT platform,account_id,source_id FROM contents WHERE id=?', request.content_id)[0];
          if (!owner || scope.input.platform !== owner.platform || scope.input.accountId !== owner.account_id || scope.input.sourceId !== owner.source_id) issue('scope-owner', request.id);
          const selected = scope.input.ocrMediaIds ?? (scope.input.requiresOCR ? scope.input.media.filter(m => m.kind === 'image').map(m => m.id) : []);
          requests.selectedImages += selected.length;
          if (new Set(selected).size !== selected.length || selected.some(id => !scope.input.media.some(m => m.id === id && m.kind === 'image')) || !!selected.length !== scope.input.requiresOCR && scope.input.ocrScopeVersion === 1) issue('ocr-frozen-selection', request.id);
          if (scope.input.ocrSelection && JSON.stringify(scope.input.ocrSelection.filter(m => m.included).map(m => m.mediaId).sort((a, b) => a - b)) !== JSON.stringify([...selected].sort((a, b) => a - b))) issue('ocr-selection-disagreement', request.id);
          for (const media of scope.input.media.filter(m => m.available)) {
            const fixed = boundedFile(path.join(p.dataDir, 'digest-inputs'), scope.fixedMediaPaths[String(media.id)]);
            if (!media.sha256 || statSync(fixed).size !== media.bytes || sha256File(fixed) !== media.sha256) issue('frozen-input-bytes', `${request.id}:${media.id}`);
          }
          for (const asset of scope.assets) readFixedAsset(p.assetsDir, asset);
          scopes.set(request.id, { request, scope });
        } catch { issue('scope-or-fixed-resource', request.id); }
      }
      const ocr: E11Audit['ocr'] = { jobs: {}, results: tables.ocr_results?.count ?? 0, corrections: tables.ocr_corrections?.count ?? 0, adoptions: tables.ocr_adoptions?.count ?? 0 };
      if (has('ocr_jobs')) for (const job of rows('SELECT * FROM ocr_jobs')) {
        ocr.jobs[job.state] = (ocr.jobs[job.state] ?? 0) + 1;
        const frozen = scopes.get(job.request_id), selected = frozen?.scope.input.ocrMediaIds ?? frozen?.scope.input.media.filter(m => m.kind === 'image').map(m => m.id);
        if (!frozen || frozen.request.synthetic || job.content_id !== frozen.request.content_id || !selected?.includes(job.media_id)) issue('job-authorization', job.id);
        if (job.state === 'running' && (frozen?.request.generation !== job.generation || ['cancelled', 'complete'].includes(frozen?.request.state))) issue('stale-running-job', job.id);
        if (['succeeded', 'no-text', 'partial'].includes(job.state) && !rows('SELECT result_id FROM ocr_results WHERE result_id=? AND content_id=? AND request_id=? AND media_id=?', job.result_id, job.content_id, job.request_id, job.media_id).length) issue('job-result', job.id);
        if (job.result_id && ['succeeded', 'no-text', 'partial'].includes(job.state)) try { const saved = JSON.parse(rows('SELECT json FROM ocr_results WHERE result_id=?', job.result_id)[0].json); if (saved.coverage !== ({ succeeded: 'complete', 'no-text': 'no-text', partial: 'partial' } as Row)[job.state]) issue('job-result-coverage', job.id); } catch { issue('job-result-coverage', job.id); }
      }
      if (schema === 7 && has('digest_stages')) for (const { request, scope } of scopes.values()) if (!request.synthetic) {
        const selected = scope.input.ocrMediaIds ?? (scope.input.requiresOCR ? scope.input.media.filter(m => m.kind === 'image').map(m => m.id) : []);
        const ocrStage = rows("SELECT state FROM digest_stages WHERE request_id=? AND name='ocr'", request.id)[0];
        if (ocrStage?.state === 'succeeded') for (const id of selected) if (!rows("SELECT id FROM ocr_jobs WHERE request_id=? AND media_id=? AND state IN ('succeeded','no-text')", request.id, id).length) issue('ocr-stage-incomplete', request.id);
        if (request.state === 'complete') issue('e11-unimplemented-flow-completed', request.id);
      }
      if (has('ocr_results')) for (const row of rows('SELECT * FROM ocr_results')) {
        try {
          const result = JSON.parse(row.json) as OcrResult, frozen = scopes.get(row.request_id), media = frozen?.scope.input.media.find(m => m.id === row.media_id);
          if (!frozen || !media || result.resultId !== row.result_id || result.contentId !== row.content_id || result.requestId !== row.request_id || result.mediaId !== row.media_id || result.scopeRevisionId !== frozen.scope.input.revisionId || result.sha256 !== media.sha256 || result.mediaVersion !== media.version) throw new Error();
          readFixedAsset(p.assetsDir, result.asset);
          if (!/^[a-f0-9]{64}$/.test(String(result.engine.helperSha256))) issue('result-helper-fingerprint', row.result_id);
          const token: OcrJobToken = { jobId: 'readonly-audit', requestId: row.request_id, contentId: row.content_id, generation: frozen.request.generation, scopeRevisionId: result.scopeRevisionId, runId: 'readonly-audit', media, relativePath: frozen.scope.fixedMediaPaths[String(media.id)], cacheKey: 'readonly-audit', engine: result.engine };
          const { text, blocks, slices, coverage, warnings, startedAt, completedAt } = result;
          validateNativeOutput({ schemaVersion: 1, ok: true, op: 'recognize', engine: result.engine, image: { ...result.image, sha256: result.sha256, bytes: media.bytes, mime: result.mime }, recognition: { text, blocks, slices, coverage, warnings, startedAt, completedAt }, limits: {}, metrics: result.metrics }, token);
        } catch { issue('ocr-result-contract-or-resource', row.result_id); }
      }
      if (has('ocr_calls')) for (const call of rows('SELECT * FROM ocr_calls')) {
        const frozen = scopes.get(call.request_id), job = rows('SELECT * FROM ocr_jobs WHERE id=?', call.job_id)[0];
        if (!frozen || frozen.request.synthetic || !job || job.request_id !== call.request_id || job.media_id !== call.media_id || call.scope_revision_id !== frozen.scope.input.revisionId || call.input_sha !== frozen.scope.input.media.find(m => m.id === call.media_id)?.sha256) issue('ocr-call-authorization', call.run_id);
      }
      if (has('ocr_corrections')) for (const row of rows('SELECT * FROM ocr_corrections')) {
        try {
          const c = JSON.parse(row.json), original = rows('SELECT json FROM ocr_results WHERE result_id=?', row.result_id)[0];
          const result = JSON.parse(original.json) as OcrResult;
          if (c.resultId !== row.result_id || c.revision !== row.revision || c.text !== c.blocks.map((b: Row) => b.text).join('\n') || new Set(c.blocks.map((b: Row) => b.id)).size !== c.blocks.length) throw new Error();
          for (const b of c.blocks) if (!['ocr', 'manual'].includes(b.provenance) || b.provenance === 'manual' && b.originalBlockIds.length || b.provenance === 'ocr' && !b.originalBlockIds.length || b.originalBlockIds.some((id: string) => !result.blocks.some(block => block.id === id))) throw new Error();
        } catch { issue('correction-provenance-or-version', row.result_id); }
      }
      if (has('ocr_adoptions')) for (const row of rows('SELECT * FROM ocr_adoptions')) if (row.kind === 'original' ? row.revision !== 1 : row.kind !== 'correction' || !rows('SELECT revision FROM ocr_corrections WHERE result_id=? AND revision=?', row.result_id, row.revision).length) issue('adopted-version', row.result_id);
      if (has('editor_assets')) for (const row of rows('SELECT * FROM editor_assets')) try { readFixedAsset(p.assetsDir, JSON.parse(row.json)); } catch { issue('editor-asset', `${row.id}:${row.version}`); }
      if (has('editor_sources')) for (const row of rows('SELECT * FROM editor_sources')) try { validateSource(JSON.parse(row.json)); } catch { issue('source-model', `${row.source_id}:${row.revision_id}`); }
      if (has('editor_transcripts')) for (const row of rows('SELECT * FROM editor_transcripts')) try { validateTranscript(JSON.parse(row.json)); } catch { issue('transcript-model', row.transcript_id); }
      if (has('editor_versions')) for (const row of rows('SELECT v.*,d.workspace_id FROM editor_versions v JOIN editor_documents d ON d.id=v.document_id')) try {
        const doc = JSON.parse(row.json); validateDocument(doc);
        if (doc.documentId !== row.document_id || doc.revision !== row.revision || doc.workspaceId !== row.workspace_id) throw new Error();
        if ('nodes' in doc) for (const node of Object.values(doc.nodes)) for (const ref of node.sourceRefs) if (ref.kind === 'ocr') auditOcrReference(db, p.assetsDir, row.workspace_id, ref);
      } catch { issue('editor-version-or-ocr-reference', `${row.document_id}:${row.revision}`); }
      const library: E11Audit['library'] = { legacy: 0, realGenerated: 0, syntheticGenerated: 0 };
      if (has('digest_library')) for (const row of rows('SELECT * FROM digest_library')) { if (row.legacy) library.legacy++; else row.synthetic ? library.syntheticGenerated++ : library.realGenerated++; }
      if (library.realGenerated) issue('e11-unimplemented-real-library', 'library');
      for (const stage of ['asr', 'organize', 'map', 'markdown']) if (calls.digestReal[stage]) issue('e11-unimplemented-real-call', stage);
      const nativeDir = path.resolve('dist/editor-e11/native'), helper = path.join(nativeDir, 'ocr-helper'), build = path.join(nativeDir, 'build-manifest.json');
      let nativeBuild: E11Audit['nativeBuild'];
      if (existsSync(helper) && existsSync(build)) {
        const declared = JSON.parse(readFileSync(boundedFile(nativeDir, 'build-manifest.json'), 'utf8')), actual = sha256File(boundedFile(nativeDir, 'ocr-helper'));
        // Authorized E111 source changes must not invalidate the sealed E11 executable.
        // The old manifest stays immutable; verify its source from its historical Git ref.
        let sourceMatches = declared.sourceSha256 === sha256File(path.resolve('native/ocr-helper.swift'));
        if (!sourceMatches) try { sourceMatches = declared.sourceSha256 === sha256(execFileSync('git', ['show', 'editor-e11:native/ocr-helper.swift'], { maxBuffer: 1024 * 1024 })); } catch { sourceMatches = false; }
        nativeBuild = { helperSha256: actual, declaredSha256: declared.executableSha256, matches: actual === declared.executableSha256 && actual === declared.capability?.engine?.helperSha256 && sourceMatches };
        if (!nativeBuild.matches) issue('native-build-fingerprint', 'compiled-helper');
      }
      return { kind: 'editor-e11-readonly-audit', schema, readOnly: true, queryOnly: true, integrity, tables, resources, resourcesSha256: sha256(JSON.stringify(resources)), calls, requests, ocr, library, issues, valid: issues.length === 0, ...(nativeBuild ? { nativeBuild } : {}) };
    })();
  } finally { db.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditE11(process.env.RLW_E11_DIR!);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
}
