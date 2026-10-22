import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createE3Paths,e3BuildMode,resolveE3Paths} from '../src/main/e3-isolation.js';
test('E3 compiled entry refuses missing, formal and old-version environments',()=>{
 assert.equal(e3BuildMode('/workspace/dist/editor-e3',{RLW_E3_DIR:'/selected'}),true);
 for(const env of [{},{RLW_E3_DIR:'/selected',RLW_E2_DIR:'/old'},{RLW_E3_DIR:'/selected',RLW_DATA_DIR:'/formal'}])assert.throws(()=>e3BuildMode('/workspace/dist/editor-e3',env));
 assert.throws(()=>e3BuildMode('/workspace/dist/editor-e2',{RLW_E3_DIR:'/selected'}));
});
test('E3 root is a new direct child, rejects aliases and requires schema9 marker plus DB',()=>{
 const project=path.resolve('.acceptance-data/editor-e3',`isolation-test-${randomUUID()}`),root=path.join(project,'.acceptance-data/editor-e3/run');
 const p=createE3Paths(root,{projectRoot:project});
 assert.throws(()=>createE3Paths(root,{projectRoot:project}));assert.throws(()=>resolveE3Paths(root,{projectRoot:project,mustExist:true}));
 writeFileSync(path.join(p.dataDir,'workbench.sqlite'),'isolated marker fixture, not a DB');
 const marker={schema:1,databaseSchema:9,root,kind:'read-later-workbench-editor-e3',networkBlockedRequired:true};
 writeFileSync(path.join(root,'e3-isolated.json'),JSON.stringify(marker));assert.equal(resolveE3Paths(root,{projectRoot:project,mustExist:true}).root,root);
 writeFileSync(path.join(root,'e3-isolated.json'),JSON.stringify({...marker,databaseSchema:8}));assert.throws(()=>resolveE3Paths(root,{projectRoot:project,mustExist:true}));
 writeFileSync(path.join(root,'e3-isolated.json'),JSON.stringify(marker));
 const outside=path.join(project,'outside');mkdirSync(outside);symlinkSync(outside,path.join(p.dataDir,'generation-results'),'dir');assert.throws(()=>resolveE3Paths(root,{projectRoot:project,mustExist:true}));
 for(const candidate of [root+'/nested',path.join(project,'.acceptance-data/editor-e2/run'),root+'/../run','relative'])assert.throws(()=>resolveE3Paths(candidate,{projectRoot:project}));
});
