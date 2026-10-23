import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {acquireBatchSourceLease,batchBuildMode,batchSourceHolders,BATCH_LOGIN_PLATFORMS,createBatchPaths,resolveBatchPaths,validateBatchRuntimeSources} from '../src/main/batch-isolation.js';
import {createE3RealPaths} from '../src/main/e3-real-isolation.js';
import {cloneBatch} from '../scripts/batch-clone.js';
import {Store} from '../src/main/store.js';
import {EditorRepository,migrateEditorSchema} from '../src/main/editor-store.js';
import {DigestRepository} from '../src/main/digest-store.js';
import {migrateAsrSchema} from '../src/main/asr-store.js';
import {GenerationRepository,migrateGenerationSchema} from '../src/main/generation-store.js';
import { migrateE44Schema } from '../src/main/digest-store.js';
const sandbox=path.resolve('.test-data',`batch-isolation-${randomUUID()}`),binding=path.resolve('.runtime/node24.node');
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
function paths(name:string){const projectRoot=path.join(sandbox,name),source=path.join(projectRoot,'.acceptance-data/editor-e3-real/source'),target=path.join(projectRoot,'.acceptance-data/batch-sync/e42-target'),sourceUserDataDir=path.join(projectRoot,'unavailable-old-profile'),credentials=path.join(source,'userData');return{projectRoot,source,target,sourceUserDataDir,runtimeSources:{sourceUserDataDir,credentialUserDataDirs:{siliconflow:credentials,deepseek:credentials}},nativeBinding:binding};}
test('batch builds reject formal/default/old routes and missing roots',()=>{
 assert.equal(batchBuildMode('/project/dist/batch-e42-a1',{RLW_BATCH_DIR:'/selected'}),true);
 for(const environment of [{},{RLW_BATCH_DIR:'/selected',RLW_DATA_DIR:'/formal'},{RLW_BATCH_DIR:'/selected',RLW_E3_REAL_DIR:'/old'},{RLW_BATCH_DIR:'/selected',RLW_SOURCE_MODE:'bridge'}])assert.throws(()=>batchBuildMode('/project/dist/batch-e42-a1',environment));
 assert.throws(()=>batchBuildMode('/project/dist/editor-e3-real',{RLW_BATCH_DIR:'/selected'}));
 assert.equal(batchBuildMode('/project/dist/main',{}),false);
});
test('separate root/profile/credentials boundaries reject aliases, missing marker and formal Store target',()=>{
 const f=paths('paths'),p=createBatchPaths(f.target,{projectRoot:f.projectRoot});mkdirSync(f.runtimeSources.credentialUserDataDirs.siliconflow,{recursive:true});
 const sources=validateBatchRuntimeSources(f.runtimeSources,f.projectRoot,p.userDataDir);assert.equal(sources.sourcePartitions.bilibili,path.join(p.userDataDir,'Partitions/rlw-bilibili'));assert.deepEqual(Object.keys(sources.sourcePartitions),[...BATCH_LOGIN_PLATFORMS]);assert.equal(sources.sourceSessionDataDir,p.userDataDir);assert.equal(existsSync(f.sourceUserDataDir),false);
 assert.throws(()=>resolveBatchPaths(path.join(f.sourceUserDataDir,'round-01-data'),{projectRoot:f.projectRoot}));
 assert.throws(()=>createBatchPaths(f.target,{projectRoot:f.projectRoot}));assert.throws(()=>resolveBatchPaths(f.target,{projectRoot:f.projectRoot,mustExist:true}));
 assert.throws(()=>validateBatchRuntimeSources(f.runtimeSources,f.projectRoot,f.sourceUserDataDir));
 assert.throws(()=>batchSourceHolders(Object.fromEntries(BATCH_LOGIN_PLATFORMS.map(platform=>[platform,path.join(f.sourceUserDataDir,'Partitions',`rlw-${platform}`)])) as any),/拒绝旧或正式/);
 const outside=path.join(f.projectRoot,'outside');mkdirSync(outside);symlinkSync(outside,path.join(p.dataDir,'media'));
 assert.throws(()=>resolveBatchPaths(f.target,{projectRoot:f.projectRoot}));
});
test('profile lease refuses live holder, another batch and acquisition race; normal release preserves next owner',()=>{
 const f=paths('lease'),p=createBatchPaths(f.target,{projectRoot:f.projectRoot});mkdirSync(f.runtimeSources.credentialUserDataDirs.siliconflow,{recursive:true});Object.assign(p,validateBatchRuntimeSources(f.runtimeSources,f.projectRoot,p.userDataDir));
 assert.throws(()=>acquireBatchSourceLease(p,{holders:()=>[42]}),/42/);
 const release=acquireBatchSourceLease(p,{holders:()=>[]});assert.throws(()=>acquireBatchSourceLease(p,{holders:()=>[]}),/持有/);release();
 let probes=0;assert.throws(()=>acquireBatchSourceLease(p,{holders:()=>++probes===1?[]:[43]}),/占用/);
 const release2=acquireBatchSourceLease(p,{holders:()=>[]});release();assert.throws(()=>acquireBatchSourceLease(p,{holders:()=>[]}),/持有/);release2();
});
function fixture(name:string){
 const f=paths(name),p=createE3RealPaths(f.source,{projectRoot:f.projectRoot}),store=new Store(p.dataDir),item={sourceId:'synthetic',title:'Synthetic retained title',author:'test',url:'https://example.invalid',kind:'text' as const,folderIds:[]};
 store.saveSnapshot({platform:'xiaohongshu',accountId:'fixture',accountName:'fixture',folders:[],complete:true,items:[item]},[{item,discovery:'historical'}],1);
 const contentId=store.find('xiaohongshu','fixture','synthetic')!;store.detailSaved(contentId,{body:'Synthetic saved source text.',bodyComplete:true,mediaManifestComplete:true,media:[]});
 migrateEditorSchema(store.db,p.dataDir,{targetVersion:7});const editor=new EditorRepository(store.db,p.dataDir),opened=editor.open(contentId,'source');if(!opened.initialized)throw Error('fixture');editor.title(opened.bundle.workspace.id,'Keep the human draft');migrateAsrSchema(store.db,p.dataDir);const digest=new DigestRepository(store.db,p.dataDir,editor);migrateGenerationSchema(store.db,p.dataDir);migrateE44Schema(store.db,p.dataDir);digest.request(contentId);const generation=new GenerationRepository(store.db,p.dataDir,editor,digest);generation.authorize(contentId);
 store.close();writeFileSync(path.join(p.root,'e3-real-isolated.json'),JSON.stringify({schema:1,databaseSchema:9,root:p.root,kind:'read-later-workbench-editor-e3-real',networkBlockedRequired:true,profileCopied:false,credentialsCopied:false}));
 writeFileSync(path.join(p.userDataDir,'siliconflow-key.encrypted'),'synthetic credential sentinel');writeFileSync(path.join(p.dataDir,'media/original.bin'),'synthetic original bytes');writeFileSync(path.join(p.assetsDir,'human.bin'),'synthetic editor bytes');writeFileSync(path.join(p.exportsDir,'human.md'),'synthetic exported document');return {...f,p};
}
test('online snapshot retains actual records, manual versions and independent files, pauses old work, never copies credentials/profile',async()=>{
 const f=fixture('clone'),original=hash(path.join(f.p.dataDir,'workbench.sqlite'));const result=await cloneBatch(f);assert.equal(result.counts.contents,1);assert.equal(result.oldRequestsPaused,1);assert.equal(result.credentialsCopied,false);
 const p=resolveBatchPaths(f.target,{projectRoot:f.projectRoot,mustExist:true});assert.deepEqual(readdirSync(p.userDataDir),[]);assert.equal(hash(path.join(f.p.dataDir,'workbench.sqlite')),original);assert.equal(existsSync(f.sourceUserDataDir),false);assert.equal(p.sourceSessionDataDir,p.userDataDir);
 for(const relative of ['data/media/original.bin','editor-assets/human.bin','exports/human.md']){assert.equal(hash(path.join(f.source,relative)),hash(path.join(f.target,relative)));assert.notEqual(statSync(path.join(f.source,relative)).ino,statSync(path.join(f.target,relative)).ino);}
 const db=new Database(path.join(p.dataDir,'workbench.sqlite'),{readonly:true,nativeBinding:binding});try{assert.equal((db.prepare('SELECT state FROM digest_requests').get() as any).state,'cancelled');assert.equal((db.prepare('SELECT state FROM generation_requests').get() as any).state,'cancelled');assert.equal((db.prepare('SELECT count(*) n FROM editor_versions').get() as any).n>0,true);assert.equal(db.pragma('quick_check',{simple:true}),'ok');}finally{db.close();}
 await assert.rejects(cloneBatch(f),/全新/);
 const markerFile=path.join(f.target,'batch-isolated.json'),marker=JSON.parse(readFileSync(markerFile,'utf8'));marker.runtimeSources={sourceUserDataDir:f.sourceUserDataDir,credentialUserDataDirs:f.runtimeSources.credentialUserDataDirs};writeFileSync(markerFile,JSON.stringify(marker));const legacy=resolveBatchPaths(f.target,{projectRoot:f.projectRoot,mustExist:true});assert.equal(legacy.sourceSessionDataDir,p.userDataDir);assert.equal(existsSync(f.sourceUserDataDir),false,'legacy source profile is never opened or created');
});
test('linked resources cannot publish a launchable clone',async(t)=>{
 const f=fixture('linked');try{symlinkSync(path.join(f.p.assetsDir,'human.bin'),path.join(f.p.dataDir,'media/link.bin'));}catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.diagnostic('file links need Developer Mode or admin on Windows; the rejection path is covered elsewhere');return;}throw error;}
 await assert.rejects(cloneBatch(f),/链接/);assert.equal(existsSync(path.join(f.target,'batch-isolated.json')),false);
});
