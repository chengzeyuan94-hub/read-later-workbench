import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createE3FixPaths,e3FixBuildMode,resolveE3FixPaths} from '../src/main/e3-fix-isolation.js';
test('E3 compiled entry refuses missing, formal and old-version environments',()=>{
 assert.equal(e3FixBuildMode('/workspace/dist/editor-e3-fix',{RLW_E3_FIX_DIR:'/selected'}),true);
 for(const env of [{},{RLW_E3_FIX_DIR:'/selected',RLW_E2_DIR:'/old'},{RLW_E3_FIX_DIR:'/selected',RLW_DATA_DIR:'/formal'}])assert.throws(()=>e3FixBuildMode('/workspace/dist/editor-e3-fix',env));
 assert.throws(()=>e3FixBuildMode('/workspace/dist/editor-e2',{RLW_E3_FIX_DIR:'/selected'}));
});
test('E3 root is a new direct child, rejects aliases and requires schema9 marker plus DB',()=>{
 const project=path.resolve('.acceptance-data/editor-e3-fix',`isolation-test-${randomUUID()}`),root=path.join(project,'.acceptance-data/editor-e3-fix/run');
 const p=createE3FixPaths(root,{projectRoot:project});
 assert.throws(()=>createE3FixPaths(root,{projectRoot:project}));assert.throws(()=>resolveE3FixPaths(root,{projectRoot:project,mustExist:true}));
 writeFileSync(path.join(p.dataDir,'workbench.sqlite'),'isolated marker fixture, not a DB');
 const marker={schema:1,databaseSchema:9,root,kind:'read-later-workbench-editor-e3-fix',networkBlockedRequired:true};
 writeFileSync(path.join(root,'e3-fix-isolated.json'),JSON.stringify(marker));assert.equal(resolveE3FixPaths(root,{projectRoot:project,mustExist:true}).root,root);
 writeFileSync(path.join(root,'e3-fix-isolated.json'),JSON.stringify({...marker,databaseSchema:8}));assert.throws(()=>resolveE3FixPaths(root,{projectRoot:project,mustExist:true}));
 writeFileSync(path.join(root,'e3-fix-isolated.json'),JSON.stringify(marker));
 const outside=path.join(project,'outside');mkdirSync(outside);symlinkSync(outside,path.join(p.dataDir,'generation-results'),'dir');assert.throws(()=>resolveE3FixPaths(root,{projectRoot:project,mustExist:true}));
 for(const candidate of [root+'/nested',path.join(project,'.acceptance-data/editor-e2/run'),root+'/../run','relative'])assert.throws(()=>resolveE3FixPaths(candidate,{projectRoot:project}));
});
