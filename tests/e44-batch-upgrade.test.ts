import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveBatchPaths} from '../src/main/batch-isolation.js';
import {createE3RealPaths} from '../src/main/e3-real-isolation.js';
import {cloneBatch} from '../scripts/batch-clone.js';
import {Store} from '../src/main/store.js';
import {EditorRepository,migrateEditorSchema} from '../src/main/editor-store.js';
import {DigestRepository,migrateE44Schema} from '../src/main/digest-store.js';
import {migrateAsrSchema} from '../src/main/asr-store.js';
import {migrateGenerationSchema} from '../src/main/generation-store.js';
const sandbox=path.resolve('.test-data',`e44-upgrade-${randomUUID()}`),binding=path.resolve('.runtime/node24.node');
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
function paths(name:string){const projectRoot=path.join(sandbox,name),source=path.join(projectRoot,'.acceptance-data/editor-e3-real/source'),target=path.join(projectRoot,'.acceptance-data/batch-sync/e42-target'),sourceUserDataDir=path.join(projectRoot,'unavailable-old-profile'),credentials=path.join(source,'userData');return{projectRoot,source,target,sourceUserDataDir,runtimeSources:{sourceUserDataDir,credentialUserDataDirs:{siliconflow:credentials,deepseek:credentials}},nativeBinding:binding};}
/** A real E4.2 source is schema 9: no digest_library.source column, recent_import_* keyed by its own root basename. */
function fixture(name:string,{v10=false}={}){
 const f=paths(name),p=createE3RealPaths(f.source,{projectRoot:f.projectRoot}),store=new Store(p.dataDir);
 for(const id of ['first','second']){const item={sourceId:id,title:'Synthetic '+id,author:'test',url:'https://example.invalid/'+id,kind:'text' as const,folderIds:[]};store.saveSnapshot({platform:'xiaohongshu',accountId:'fixture',accountName:'fixture',folders:[],complete:true,items:[item]},[{item,discovery:'historical'}],1);}
 const first=store.find('xiaohongshu','fixture','first')!;store.detailSaved(first,{body:'Saved source text.',bodyComplete:true,mediaManifestComplete:true,media:[]});
 migrateEditorSchema(store.db,p.dataDir,{targetVersion:7});const editor=new EditorRepository(store.db,p.dataDir),opened=editor.open(first,'source');if(!opened.initialized)throw Error('fixture');editor.title(opened.bundle.workspace.id,'Keep the human draft');
 migrateAsrSchema(store.db,p.dataDir);const digest=new DigestRepository(store.db,p.dataDir,editor);migrateGenerationSchema(store.db,p.dataDir);digest.request(first);
 // Shape the schema-9 digest_library exactly as an E4.2 root has it: no source column, legacy flag only.
 store.db.exec(`ALTER TABLE digest_library DROP COLUMN source`);
 store.db.prepare(`INSERT INTO digest_library(content_id,active,legacy,entered_at,completed_at) VALUES(?,1,1,?,?)`).run(first,1000,2000);
 store.db.prepare(`INSERT INTO digest_library(content_id,active,legacy,entered_at,completed_at) VALUES(?,1,0,?,?)`).run(store.find('xiaohongshu','fixture','second')!,1000,2000);
 store.db.exec(`CREATE TABLE IF NOT EXISTS recent_import_scopes(batch_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, requested_limit INTEGER NOT NULL, target_json TEXT NOT NULL, observed_json TEXT NOT NULL, target_complete INTEGER NOT NULL, history_complete INTEGER NOT NULL, reliable INTEGER NOT NULL, reason TEXT NOT NULL, paused_reason TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(batch_id,platform));
  CREATE TABLE IF NOT EXISTS recent_import_targets(batch_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(batch_id,platform,account_id,source_id));
  CREATE TABLE IF NOT EXISTS recent_import_download_pauses(batch_id TEXT NOT NULL, content_id INTEGER NOT NULL REFERENCES contents(id), reason TEXT NOT NULL, paused_at INTEGER NOT NULL, PRIMARY KEY(batch_id,content_id));`);
 const batchId=path.basename(p.root);
 store.db.prepare(`INSERT INTO recent_import_scopes VALUES(?,?,?,2,'[]','[]',0,0,0,'test',NULL,1,1)`).run(batchId,'xiaohongshu','fixture');
 store.db.prepare(`INSERT INTO recent_import_targets VALUES(?,?,?,?)`).run(batchId,'xiaohongshu','fixture','first');
 store.db.prepare(`INSERT INTO recent_import_download_pauses VALUES(?,?,?,1)`).run(batchId,first,'test pause');
 if(v10){migrateE44Schema(store.db,p.dataDir);}
 assert.equal(Number(store.db.pragma('user_version',{simple:true})),v10?10:9);
 store.close();writeFileSync(path.join(p.root,'e3-real-isolated.json'),JSON.stringify({schema:1,databaseSchema:v10?10:9,root:p.root,kind:'read-later-workbench-editor-e3-real',networkBlockedRequired:true,profileCopied:false,credentialsCopied:false}));
 writeFileSync(path.join(p.userDataDir,'siliconflow-key.encrypted'),'synthetic credential sentinel');writeFileSync(path.join(p.dataDir,'media/original.bin'),'synthetic original bytes');return{...f,p};
}
test('cloneBatch upgrades a schema 9 E4.2 source to a schema 10 copy without touching the source',async()=>{
 const f=fixture('v9'),dbFile=path.join(f.p.dataDir,'workbench.sqlite'),before=hash(dbFile),mtime=statSync(dbFile).mtimeMs;
 const result=await cloneBatch(f);assert.equal(result.schemaMigrated,true);
 assert.equal(hash(dbFile),before);assert.equal(statSync(dbFile).mtimeMs,mtime);
 const src=new Database(dbFile,{readonly:true,nativeBinding:binding});try{assert.equal(Number(src.pragma('user_version',{simple:true})),9);}finally{src.close();}
 const db=new Database(path.join(f.target,'data/workbench.sqlite'),{readonly:true,nativeBinding:binding});try{
  assert.equal(Number(db.pragma('user_version',{simple:true})),10);
  assert.equal(db.pragma('quick_check',{simple:true}),'ok');
  assert.deepEqual(db.prepare(`SELECT legacy,source FROM digest_library ORDER BY content_id`).all(),[{legacy:1,source:'legacy'},{legacy:0,source:'ai'}]);
 }finally{db.close();}
 const marker=JSON.parse(readFileSync(path.join(f.target,'batch-isolated.json'),'utf8'));assert.equal(marker.databaseSchema,10);
});
test('cloneBatch rebinds recent_import batch_id to the new root basename',async()=>{
 const f=fixture('rebind');const result=await cloneBatch(f);assert.equal(result.batchIdRebound.recent_import_scopes,1);assert.equal(result.batchIdRebound.recent_import_targets,1);assert.equal(result.batchIdRebound.recent_import_download_pauses,1);
 const db=new Database(path.join(f.target,'data/workbench.sqlite'),{readonly:true,nativeBinding:binding});try{
  for(const table of ['recent_import_scopes','recent_import_targets','recent_import_download_pauses'])assert.deepEqual(db.prepare(`SELECT DISTINCT batch_id b FROM ${table}`).all(),[{b:'e42-target'}]);
 }finally{db.close();}
});
test('a schema 9 marker is refused with an explicit prepare instruction',async()=>{
 const f=fixture('marker9');await cloneBatch(f);
 const markerFile=path.join(f.target,'batch-isolated.json'),marker=JSON.parse(readFileSync(markerFile,'utf8'));marker.databaseSchema=9;writeFileSync(markerFile,JSON.stringify(marker));
 assert.throws(()=>resolveBatchPaths(f.target,{projectRoot:f.projectRoot,mustExist:true}),/schema 9.*batch:prepare/);
});
test('a schema 10 source still clones',async()=>{
 const f=fixture('v10',{v10:true});const result=await cloneBatch(f);assert.equal(result.schemaMigrated,false);assert.equal(result.counts.contents,2);
 const db=new Database(path.join(f.target,'data/workbench.sqlite'),{readonly:true,nativeBinding:binding});try{assert.equal(Number(db.pragma('user_version',{simple:true})),10);}finally{db.close();}
});
