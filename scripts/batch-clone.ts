/** Consistent SQLite backup plus independent local files. Never opens a formal Store. */
import Database from 'better-sqlite3';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveE3RealPaths } from '../src/main/e3-real-isolation.js';
import { assertBatchOrdinaryPath, createBatchPaths, resolveBatchPaths, validateBatchRuntimeSources, type BatchRuntimeSources } from '../src/main/batch-isolation.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
import { sha256File } from '../src/main/editor-media.js';
import type { E1Paths } from '../src/main/e1-isolation.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Clone sources are either an E3-real isolated root or an earlier batch-sync root. Both are read-only inputs. */
function resolveCloneSource(value: string | undefined, projectRoot: string): E1Paths {
  const normalized = typeof value === 'string' ? path.normalize(value) : '';
  if (/[\\/]\.acceptance-data[\\/]batch-sync[\\/]e42-[-a-zA-Z0-9_]+$/.test(normalized) && existsSync(path.join(normalized, 'batch-isolated.json'))) {
    const paths = { root: normalized, dataDir: path.join(normalized, 'data'), userDataDir: path.join(normalized, 'userData'), assetsDir: path.join(normalized, 'editor-assets'), exportsDir: path.join(normalized, 'exports'), evidenceDir: path.join(normalized, 'evidence') };
    for (const file of [...Object.values(paths), path.join(paths.dataDir, 'workbench.sqlite')]) assertBatchOrdinaryPath(file);
    const marker = JSON.parse(readFileSync(path.join(normalized, 'batch-isolated.json'), 'utf8'));
    if (marker.schema !== 1 || marker.kind !== 'read-later-workbench-batch-e42' || marker.root !== normalized || (marker.databaseSchema !== 9 && marker.databaseSchema !== 10) || marker.profileCopied !== false || marker.credentialsCopied !== false) throw Error('批量准备来源标记无效');
    return paths;
  }
  return resolveE3RealPaths(value, { mustExist: true, projectRoot });
}
const mutable = new Set(['settings','digest_requests','digest_stages','ocr_jobs','asr_media_jobs','asr_chunks','asr_calls','generation_requests','generation_tasks','generation_calls','generation_edit_leases']);
type Row = Record<string, any>;
export async function cloneBatch(options: { source: string | undefined; target: string | undefined; runtimeSources: BatchRuntimeSources; projectRoot?: string; nativeBinding?: string; expectedSourceUserDataDir?: string }) {
  const project = options.projectRoot ?? process.cwd(), binding = options.nativeBinding ?? path.join(project,'.runtime/node24.node');
  const source = resolveCloneSource(options.source, project);
  const planned = resolveBatchPaths(options.target,{projectRoot:project});
  validateBatchRuntimeSources(options.runtimeSources, project, planned.userDataDir);
  const sourceDb = new Database(path.join(source.dataDir,'workbench.sqlite'), { readonly: true, fileMustExist: true, nativeBinding: binding });
  let target: ReturnType<typeof createBatchPaths>;
  try {
    sourceDb.pragma('query_only=ON');
    const sourceVersion = Number(sourceDb.pragma('user_version',{simple:true}));
    if (![9,10].includes(sourceVersion) || sourceDb.pragma('quick_check',{simple:true}) !== 'ok' || (sourceDb.pragma('foreign_key_check') as unknown[]).length) throw Error('批量准备要求完整的已验收 schema 9 或 10 副本');
    target = createBatchPaths(options.target, { projectRoot: project });
    await sourceDb.backup(path.join(target.dataDir,'workbench.sqlite'));
  } finally { sourceDb.close(); }
  const db = new Database(path.join(target.dataDir,'workbench.sqlite'), { nativeBinding: binding });
  const before: Record<string,{count:number;sha256:string}> = {}, resources: {path:string;bytes:number;sha256:string}[] = [];
  const oldRequests: unknown[] = [];
  let schemaMigrated = false; const batchIdRebound: Record<string,number> = {}; const targetBatchId = path.basename(target!.root);
  try {
    // E4.2 roots are schema 9; upgrade only the detached copy, then rebind this root's recent-import batch scope.
    if (Number(db.pragma('user_version',{simple:true})) === 9) { migrateE44Schema(db, target.dataDir); schemaMigrated = true; }
    if (Number(db.pragma('user_version',{simple:true})) !== 10 || db.pragma('quick_check',{simple:true}) !== 'ok') throw Error('批量副本 schema 10 升级未通过');
    db.transaction(() => {
      for (const table of ['recent_import_scopes','recent_import_targets','recent_import_download_pauses']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        batchIdRebound[table] = db.prepare(`UPDATE ${table} SET batch_id=? WHERE batch_id<>?`).run(targetBatchId, targetBatchId).changes;
      }
    })();
    for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]) {
      if (!/^[a-z_]+$/.test(name)) throw Error('批量快照遇到未知表名');
      const rows = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(); before[name] = {count:rows.length,sha256:hash(rows)};
    }
    function freeSpace(): void { const info=statfsSync(target.root); if(info.bavail*info.bsize<5*1024**3)throw Error('磁盘剩余不足 5 GiB，副本未发布'); }
    function copyTree(from:string,to:string):void {
      assertBatchOrdinaryPath(from); mkdirSync(to,{recursive:true,mode:0o700});
      for(const item of readdirSync(from,{withFileTypes:true})) {
        const a=path.join(from,item.name),b=path.join(to,item.name);
        if(from===source.dataDir && /^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(item.name))continue;
        if(item.isSymbolicLink())throw Error('副本拒绝链接资源');
        if(item.isDirectory())copyTree(a,b);
        else if(item.isFile()) {
          freeSpace();const bytes=statSync(a).size,sha256=sha256File(a);
          copyFileSync(a,b,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
          if(lstatSync(a).ino===lstatSync(b).ino || statSync(b).size!==bytes || sha256File(b)!==sha256 || sha256File(a)!==sha256)throw Error('副本资源发生变化或不是独立文件');
          resources.push({path:path.relative(target.root,b),bytes,sha256});
        }else throw Error('副本只接受普通文件');
      }
    }
    copyTree(source.dataDir,target.dataDir); copyTree(source.assetsDir,target.assetsDir); copyTree(source.exportsDir,target.exportsDir);
    const relocate=(value:any):any=>typeof value==='string'&&value.startsWith(source.dataDir+path.sep)?target.dataDir+value.slice(source.dataDir.length):Array.isArray(value)?value.map(relocate):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,relocate(item)])):value;
    db.pragma('foreign_keys=ON');db.pragma('synchronous=FULL');
    db.transaction(()=>{
      oldRequests.push(...db.prepare("SELECT id,state,generation FROM digest_requests WHERE state NOT IN ('cancelled','complete','failed','result-unknown')").all());
      db.prepare("UPDATE digest_requests SET state='cancelled',generation=generation+1 WHERE state NOT IN ('cancelled','complete','failed','result-unknown')").run();
      db.prepare("UPDATE digest_stages SET state='cancelled',run_id=NULL WHERE request_id IN (SELECT id FROM digest_requests WHERE state='cancelled') AND state NOT IN ('succeeded','not-required','failed','result-unknown')").run();
      db.prepare("UPDATE ocr_jobs SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','no-text','failed','partial','cancelled')").run();
      for(const table of ['asr_media_jobs','asr_chunks']) {
        db.prepare(`UPDATE ${table} SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','failed','result-unknown','cancelled')`).run();
        for(const row of db.prepare(`SELECT id,prepared_json FROM ${table} WHERE prepared_json IS NOT NULL`).all() as Row[])db.prepare(`UPDATE ${table} SET prepared_json=? WHERE id=?`).run(JSON.stringify(relocate(JSON.parse(row.prepared_json))),row.id);
      }
      for(const table of ['asr_calls','generation_calls'])db.prepare(`UPDATE ${table} SET status=CASE WHEN submitted=1 THEN 'result-unknown' ELSE 'interrupted-before-submit' END,finished_at=? WHERE status IN ('prepared','submitted')`).run(Date.now());
      db.prepare("UPDATE generation_requests SET state='cancelled' WHERE state NOT IN ('cancelled','succeeded','failed','result-unknown')").run();
      db.prepare("UPDATE generation_tasks SET state='cancelled',run_id=NULL WHERE state NOT IN ('succeeded','failed','result-unknown','cancelled')").run();
      db.prepare('DELETE FROM generation_edit_leases').run();
      db.prepare("INSERT INTO settings(key,value) VALUES('autoSync','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    })();
    for(const [table,previous] of Object.entries(before)) {
      const rows=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      if(!['generation_edit_leases','settings'].includes(table)&&rows.length!==previous.count)throw Error('快照丢失历史记录');
      if(!mutable.has(table)&&hash(rows)!==previous.sha256)throw Error('快照改动了受保护历史数据');
    }
    if(db.pragma('quick_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw Error('批量快照完整性校验失败');
  }finally{db.close();}
  const snapshot={schema:1,createdAt:new Date().toISOString(),source:source.root,target:target.root,schemaMigrated,batchId:targetBatchId,batchIdRebound,before,resources,oldRequests,profileCopied:false,credentialsCopied:false,sourceReadOnly:true,newUploads:0};
  writeFileSync(path.join(target.evidenceDir,'batch-snapshot.json'),JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
  const runtimeSources:BatchRuntimeSources={sessionMode:'isolated-five-platforms',sourceUserDataDir:target.userDataDir,credentialUserDataDirs:options.runtimeSources.credentialUserDataDirs};
  writeFileSync(path.join(target.root,'batch-isolated.json'),JSON.stringify({schema:1,kind:'read-later-workbench-batch-e42',root:target.root,databaseSchema:10,preparedAt:snapshot.createdAt,source:source.root,profileCopied:false,credentialsCopied:false,oldProcessingPaused:true,runtimeSources},null,2)+'\n',{flag:'wx',mode:0o600});
  return {prepared:true,root:target.root,schemaMigrated,batchIdRebound,counts:Object.fromEntries(Object.entries(before).map(([key,value])=>[key,value.count])),resourceFiles:resources.length,resourceBytes:resources.reduce((sum,item)=>sum+item.bytes,0),oldRequestsPaused:oldRequests.length,profileCopied:false,credentialsCopied:false};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const {RLW_BATCH_SOURCE:source,RLW_BATCH_DIR:target,RLW_BATCH_ASR_CREDENTIAL_DIR:siliconflow,RLW_BATCH_GENERATION_CREDENTIAL_DIR:deepseek}=process.env;
  if(!siliconflow||!deepseek)throw Error('准备前需要明确两个凭据目录；五平台将在新资料根重新登录，不读取旧登录目录');
  console.log(JSON.stringify(await cloneBatch({source,target,runtimeSources:{sessionMode:'isolated-five-platforms',credentialUserDataDirs:{siliconflow,deepseek}}})));
}
