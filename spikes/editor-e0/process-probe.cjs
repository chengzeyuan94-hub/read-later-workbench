const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runProcessProbe(win, {root, mode}) {
  const evaluate = text => win.webContents.executeJavaScript(text, true);
  const invoke = (name,...args) => evaluate(`window.e0Probe[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  for (let i=0;i<200;i++) { if(await evaluate('Boolean(window.e0Probe?.snapshot().state)'))break;await delay(30);if(i===199)throw Error('No E0 editor'); }
  const evidence = path.join(root,'evidence');
  if(mode==='export-fixture') {
    const bundle=await evaluate(`window.e0.load('e0-a-workspace')`);
    const canvasExpected=path.join(evidence,'e01-saved-bundle.json');
    if(fs.existsSync(canvasExpected)) {
      assert.deepEqual(bundle,JSON.parse(fs.readFileSync(canvasExpected)));
      fs.writeFileSync(path.join(evidence,'e01-process-reopened.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,root,synthetic:true,exactSavedCanvasBundleRestored:true,nodeCount:Object.keys(bundle.map.nodes).length,draftRevision:bundle.draft.revision,mapRevision:bundle.map.revision,passed:true},null,2));
    }
    const result=await evaluate(`window.e0.exportXmind('e0-a-workspace')`);
    fs.writeFileSync(path.join(evidence,'xmind-source-bundle.json'),JSON.stringify(bundle,null,2));
    fs.writeFileSync(path.join(evidence,'draft-sample.md'),await invoke('markdown'));
    await evaluate(`Promise.all([...document.images].map(image=>image.decode()))`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await delay(150);
    fs.writeFileSync(path.join(evidence,'editor-fixture.png'),(await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(evidence,'xmind-export.json'),JSON.stringify({at:new Date().toISOString(),fromActualIsolatedSQLite:true,workspaceId:bundle.workspace.id,mapRevision:bundle.map.revision,...result},null,2));
    return {exit:true,exported:result.path};
  }
  const interrupted = mode.includes('interruption'); const prefix = interrupted ? 'interruption' : 'normal-close';
  const file = path.join(evidence,prefix+'-expected.json');
  if(mode.startsWith('prepare-')) {
    const baseline = await evaluate(`window.e0.load('e0-a-workspace')`);
    await invoke('bodySelect','e0-a-draft-p1',0);await invoke('insertBody',`已落盘边界🧠 ${prefix} `);
    await invoke('command',{type:'rename',nodeId:'e0-a-n5',title:[{text:'进程恢复节点🧩 ',bold:true},{text:prefix}]});
    assert.equal(await invoke('save'),true);
    const durable = await evaluate(`window.e0.load('e0-a-workspace')`);
    if(interrupted) {
      fs.writeFileSync(file,JSON.stringify({baseline,durable,unsavedToken:'未落盘的最后按键🧨'},null,2));
      await invoke('bodySelect','e0-a-draft-p1',0);await invoke('insertBody','未落盘的最后按键🧨');
      const pending=await invoke('snapshot');assert.notEqual(pending.session.edit,pending.session.savedEdit);
      fs.writeFileSync(path.join(evidence,'interruption-ready.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,root,durableRevisions:{draft:durable.draft.revision,map:durable.map.revision},pendingUnsaved:true,networkBlocked:true},null,2));
      return {exit:false,readyToInterrupt:true};
    }
    await invoke('bodySelect','e0-a-draft-p1',0);await invoke('insertBody','关闭时尚未保存📝');
    const snapshot=await invoke('snapshot'); const body=await invoke('bodyBlocks');
    fs.writeFileSync(file,JSON.stringify({baseline,durable,closeDraftBlocks:body,closeMap:snapshot.state.map,unsavedBeforeNormalClose:true},null,2));
    await evaluate('window.e0.requestClose()');await delay(100);
    assert.equal(await evaluate('Boolean(document.querySelector("[role=dialog]"))'),true);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await delay(150);
    fs.writeFileSync(path.join(evidence,'normal-close-prompt.png'),(await win.webContents.capturePage()).toPNG());
    await evaluate('void window.e0Probe.close("saved")');
    return {exit:false,waitingForSaveAndClose:true};
  }
  if(!mode.startsWith('verify-'))throw Error('Unknown process probe');
  const expected=JSON.parse(fs.readFileSync(file));const loaded=await evaluate(`window.e0.load('e0-a-workspace')`);
  if(interrupted) { assert.deepEqual(loaded,expected.durable);assert.ok(!JSON.stringify(loaded).includes(expected.unsavedToken)); }
  else { assert.deepEqual(loaded.draft.blocks,expected.closeDraftBlocks);assert.deepEqual(loaded.map.nodes,expected.closeMap.nodes);assert.ok(loaded.draft.revision>expected.durable.draft.revision);assert.deepEqual(loaded.sources,expected.durable.sources);assert.deepEqual(loaded.assets,expected.durable.assets); }
  const images=await evaluate(`Promise.all([...document.querySelectorAll('img')].map(async image=>{await image.decode();return{src:image.src,width:image.naturalWidth,height:image.naturalHeight}}))`);
  assert.ok(images.length>=3&&images.every(image=>image.width===320&&image.height===180&&image.src.startsWith('e0-asset:')));
  const blocked=await evaluate(`fetch('https://example.com/e0-restart-check').then(()=>false,()=>true)`);assert.equal(blocked,true);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await delay(150);
  const result={at:new Date().toISOString(),pid:process.pid,mode,root,synthetic:true,httpBlocked:true,httpsBlocked:true,restoredIds:Object.keys(loaded.map.nodes),draftRevision:loaded.draft.revision,mapRevision:loaded.map.revision,refs: Object.values(loaded.map.nodes).flatMap(node=>node.sourceRefs),images,unsavedLastKeysGuaranteed:false,passed:true};
  fs.writeFileSync(path.join(evidence,prefix+'-verified.json'),JSON.stringify(result,null,2));
  fs.writeFileSync(path.join(evidence,prefix+'-reopened.png'),(await win.webContents.capturePage()).toPNG());
  return {...result,exit:true};
}
module.exports={runProcessProbe};
