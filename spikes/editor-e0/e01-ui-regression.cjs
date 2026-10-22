const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Native Chromium input events into the actual isolated renderer; setup probes are identified. */
async function runCanvasRegression(win, { root, evidenceDir }) {
  const startedAt = new Date().toISOString(), results = [], observations = {}; let captureCount = 0;
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const probe = (name, ...args) => evaluate(`window.e0Probe[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const snapshot = () => probe('snapshot');
  const hash=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  async function wait(fn, message, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if(value) return value; await delay(30); } throw Error(`Timeout: ${message}`); }
  async function settle() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await delay(80); }
  async function check(name, action) { const at = performance.now(); const detail = await action(); results.push({ name, passed:true, elapsedMs:performance.now()-at, ...(detail ? { detail } : {}) }); }
  async function box(selector) { return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()`); }
  async function mouse(type, point, extra = {}) { win.webContents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),...extra}); }
  async function click(selector) { const r=await box(selector), p={x:r.x+r.width/2,y:r.y+r.height/2}; await mouse('mouseDown',p,{button:'left',clickCount:1}); await mouse('mouseUp',p,{button:'left',clickCount:1}); await settle(); }
  async function key(keyCode,modifiers=[]) { win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await settle(); }
  async function wheel(point,deltaX,deltaY,modifiers=[]) { await mouse('mouseWheel',point,{deltaX,deltaY,modifiers,canScroll:true});await settle(); }
  async function canvas() { return probe('canvasSnapshot'); }
  async function signature() { const s=await snapshot(), poll=await evaluate('window.e0.poll()');return {map:hash(s.state.map),draft:hash(s.state.draft),past:hash(s.state.history.past),pastCount:s.state.history.past.length,future:hash(s.state.history.future),futureCount:s.state.history.future.length,dirty:s.state.dirty,edit:s.session.edit,savedEdit:s.session.savedEdit,status:s.session.status,saveRequests:poll.saveRequestCount}; }
  async function blank() { return evaluate(`(()=>{const c=document.querySelector('[data-testid="canvas"]'),r=c.getBoundingClientRect();for(let y=r.top+12;y<r.bottom-10;y+=19)for(let x=r.left+12;x<r.right-10;x+=23){const e=document.elementFromPoint(x,y);if(e&&c.contains(e)&&!e.closest('[data-node-id],button,.ProseMirror'))return{x,y};}throw Error('No canvas background');})()`); }
  async function viewport() { return (await snapshot()).state.view.viewport; }
  async function setScaleByControl(target) { await click('[data-testid="zoom-reset"]');for(let i=0;i<20;i++){const v=await viewport();if(v.zoom<=target+0.001)break;await click('[data-testid="zoom-out"]');} }
  async function drag(sourceId,targetId,kind,{cancel,scale}={}) {
    if(scale)await setScaleByControl(scale);const moveCount=(await canvas()).metrics.moveCommits;
    // Selection setup only; the structure mutation below must come from real mouse events.
    await probe('command',{type:'select',selection:{kind:'node',nodeId:sourceId}});
    await click('[data-testid="center-selected"]');
    const a=await box(`[data-node-id="${sourceId}"]`),c=await box('[data-testid="canvas"]');
    const title=await box(`[data-node-id="${sourceId}"] .node-title`);const start={x:title.x+title.width/2,y:title.y+title.height/2};
    const targetPoint=async()=>{const b=await box(`[data-node-id="${targetId}"]`);return{x:b.x+b.width*.62,y:b.y+b.height*(kind==='before'?.12:kind==='after'?.88:.5)}};
    let end=await targetPoint(),pannedWhileHeld=false;
    await mouse('mouseDown',start,{button:'left',clickCount:1});await settle();
    if(end.x<c.x+10||end.x>c.x+c.width-10||end.y<c.y+10||end.y>c.y+c.height-10){
      await mouse('mouseMove',{x:start.x+12,y:start.y+10},{button:'left'});await settle();
      // An actual wheel gesture during capture makes distant targets reachable at a readable scale.
      await wheel({x:c.x+c.width/2,y:c.y+c.height/2},c.x+c.width/2-end.x,c.y+c.height/2-end.y);
      end=await targetPoint();pannedWhileHeld=true;
    }
    assert.ok(end.x>c.x&&end.x<c.x+c.width&&end.y>c.y&&end.y<c.y+c.height,`target visible: ${targetId} ${JSON.stringify({end,c})}`);
    for(let i=1;i<=12;i++){await mouse('mouseMove',{x:start.x+(end.x-start.x)*i/12,y:start.y+(end.y-start.y)*i/12},{button:'left'});await delay(18);}
    await settle();const preview=await canvas(); const previewFile=`drop-${String(++captureCount).padStart(2,"0")}-${kind}.png`;fs.writeFileSync(path.join(evidenceDir,previewFile),(await win.webContents.capturePage()).toPNG());
    if(cancel==='escape')await key('Escape');
    else if(cancel==='pointercancel')await evaluate(`document.querySelector('[data-testid="canvas"]').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))`);
    await mouse('mouseUp',end,{button:'left',clickCount:1});await settle();
    const atRelease=await canvas();assert.equal(atRelease.metrics.moveCommits,moveCount+(preview.drop?.allowed&&!cancel?1:0));return {preview,previewFile,atRelease,pannedWhileHeld};
  }
  function equalViewport(a,b,epsilon=.05){assert.ok(Math.abs(a.x-b.x)<epsilon&&Math.abs(a.y-b.y)<epsilon&&Math.abs(a.zoom-b.zoom)<1e-6,JSON.stringify({a,b}));}
  try {
    await wait(()=>evaluate(`Boolean(window.e0Probe?.canvasSnapshot&&document.querySelector('[data-testid="canvas"]'))`),'canvas ready');
    await evaluate(`window.__e01FrameLatency=[];document.addEventListener('wheel',event=>{const began=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__e01FrameLatency.push({eventTrusted:event.isTrusted,deltaMs:performance.now()-began,method:'event handler entry to second requestAnimationFrame; not full paint or SLA'})))},{capture:true})`);await evaluate('document.fonts.ready');await evaluate('Promise.all([...document.images].map(i=>i.decode()))');await settle();
    const initial=await snapshot();observations.nodeCount=Object.keys(initial.state.map.nodes).length;
    await check('measured fit includes all nodes and local images, without overlapping nodes or detached SVG endpoints',async()=>{
      await click('[data-testid="fit-all"]');
      const measured=await evaluate(`(()=>{const c=document.querySelector('[data-testid="canvas"]').getBoundingClientRect();const nodes=[...document.querySelectorAll('[data-node-id]')].map(e=>({id:e.dataset.nodeId,...Object.fromEntries(['x','y','width','height'].map(k=>[k,e.getBoundingClientRect()[k]]))}));const overlaps=[];for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=nodes[i],b=nodes[j];if(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>.5&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>.5)overlaps.push([a.id,b.id]);}return{container:{x:c.x,y:c.y,width:c.width,height:c.height},nodes,overlaps,paths:document.querySelectorAll('[data-testid="viewport-world"] svg path').length};})()`);
      assert.equal(measured.nodes.length,observations.nodeCount);assert.equal(measured.overlaps.length,0);assert.equal(measured.paths,observations.nodeCount-1);
      for(const r of measured.nodes){assert.ok(r.x>=measured.container.x-1&&r.y>=measured.container.y-1&&r.x+r.width<=measured.container.x+measured.container.width+1&&r.y+r.height<=measured.container.y+measured.container.height+1,`fit clipped ${r.id}`);}
      const edges=await evaluate(`(()=>{const out=[];for(const p of document.querySelectorAll('[data-edge-child]')){const child=p.dataset.edgeChild,map=window.e0Probe.snapshot().state.map,parent=map.nodes[child].parentId,a=document.querySelector('[data-node-id=\"'+parent+'\"]').getBoundingClientRect(),b=document.querySelector('[data-node-id=\"'+child+'\"]').getBoundingClientRect(),m=p.getScreenCTM(),s=p.getPointAtLength(0).matrixTransform(m),e=p.getPointAtLength(p.getTotalLength()).matrixTransform(m);out.push({child,startError:Math.hypot(s.x-a.right,s.y-(a.top+a.height/2)),endError:Math.hypot(e.x-b.left,e.y-(b.top+b.height/2))});}return out;})()`);assert.ok(edges.every(e=>e.startError<2&&e.endError<2));observations.edges=edges;observations.measured=measured;return {nodes:measured.nodes.length,paths:measured.paths};
    });
    await check('background drag threshold, pointer capture and wheel pan transform HTML and SVG together without content/history/save changes',async()=>{
      await probe('command',{type:'rename',nodeId:'e0-a-n1',title:[{text:'temporary redo setup'}]});await probe('command',{type:'undo'});assert.ok((await snapshot()).state.history.future.length);const before=await signature(),v0=await viewport(),p=await blank();
      await mouse('mouseDown',p,{button:'left',clickCount:1});await mouse('mouseMove',{x:p.x+2,y:p.y+2},{button:'left'});await mouse('mouseUp',{x:p.x+2,y:p.y+2},{button:'left',clickCount:1});await settle();equalViewport(await viewport(),v0);
      const worldBefore=await box('[data-testid="viewport-world"]');
      await mouse('mouseDown',p,{button:'left',clickCount:1});await mouse('mouseMove',{x:p.x+70,y:p.y+45},{button:'left'});await mouse('mouseUp',{x:p.x+70,y:p.y+45},{button:'left',clickCount:1});await settle();
      const v1=await viewport();assert.ok(Math.abs(v1.x-v0.x)>20);const worldAfter=await box('[data-testid="viewport-world"]');assert.ok(Math.abs(worldAfter.x-worldBefore.x)>20);
      const c=await box('[data-testid="canvas"]'),outside={x:Math.max(2,c.x-12),y:c.y+80},grab=await blank();await mouse('mouseDown',grab,{button:'left',clickCount:1});await settle();await mouse('mouseMove',outside,{button:'left'});await mouse('mouseUp',outside,{button:'left',clickCount:1});await settle();assert.equal((await canvas()).gesture,null);await wheel(await blank(),23,-37);const v2=await viewport();assert.notDeepEqual(v2,v1);assert.deepEqual(await signature(),before);
      return {before:v0,drag:v1,wheel:v2,pageZoom:win.webContents.getZoomFactor()};
    });
    await check('modifier wheel anchors at cursor, clamps finite zoom, controls use canvas only and preserve body focus/selection',async()=>{
      const p=await blank(),r=await box('[data-testid="canvas"]'),before=await viewport(),local={x:p.x-r.x,y:p.y-r.y},world={x:(local.x-before.x)/before.zoom,y:(local.y-before.y)/before.zoom};
      await wheel(p,0,45,['control']);const after=await viewport();assert.notEqual(after.zoom,before.zoom);assert.ok(Math.abs(world.x*after.zoom+after.x-local.x)<1);assert.ok(Math.abs(world.y*after.zoom+after.y-local.y)<1);
      await probe('bodySelect','e0-a-draft-p1',0,3);const s=await snapshot();const sig=await signature();
      await click('[data-testid="zoom-in"]');await click('[data-testid="zoom-out"]');await click('[data-testid="zoom-reset"]');await click('[data-testid="fit-all"]');await click('[data-testid="center-selected"]');
      assert.deepEqual((await snapshot()).editorSelection,s.editorSelection);assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`),'我的整理稿');assert.deepEqual(await signature(),sig);
      await wheel(await blank(),0,100000,['meta']);const firstLimit=(await viewport()).zoom;await wheel(await blank(),0,-100000,['control']);const secondLimit=(await viewport()).zoom;assert.deepEqual([firstLimit,secondLimit].sort((a,b)=>a-b),[.01,2.5]);assert.equal(win.webContents.getZoomFactor(),1);
      await key('+',['meta']);assert.equal(win.webContents.getZoomFactor(),1);await evaluate(`document.querySelector('[data-testid="zoom-reset"]').focus()`);await settle();win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await settle();assert.equal((await viewport()).zoom,1);const bodyRect=await box('.body-editor'),canvasBeforeBodyWheel=await viewport();await wheel({x:bodyRect.x+20,y:bodyRect.y+20},0,-60);equalViewport(await viewport(),canvasBeforeBodyWheel);assert.equal(win.webContents.getZoomFactor(),1);return {cursorAnchor:true,min:.01,max:2.5};
    });
    await check('workspace view is cached independently; poll, late save, image load and resize never refit a manual view',async()=>{
      await click('[data-testid="fit-all"]');await wheel(await blank(),32,47);const a=await viewport();await probe('switchWorkspace','e0-b-workspace');await settle();await wheel(await blank(),-25,-30);const b=await viewport();await probe('switchWorkspace','e0-a-workspace');await settle();equalViewport(await viewport(),a);
      await delay(1600);equalViewport(await viewport(),a);await evaluate(`window.__e01Image=document.querySelector('[data-node-id] img');window.__e01ImageURL=window.__e01Image.src;window.__e01Image.removeAttribute('src')`);await settle();await wheel(await blank(),3,5);const imagePending=await viewport();await evaluate(`window.__e01Image.src=window.__e01ImageURL;window.__e01Image.decode()`);await settle();equalViewport(await viewport(),imagePending);
      await probe('command',{type:'rename',nodeId:'e0-a-n1',title:[{text:'晚回包与视野 🧠'}]});const requestsBefore=(await evaluate('window.e0.poll()')).saveRequestCount;await evaluate('window.e0.setFault({saveDelayMs:600})');await evaluate('void window.e0Probe.save()');await wait(async()=>(await snapshot()).session.status==='saving','actual save in flight');assert.equal((await evaluate('window.e0.poll()')).saveRequestCount,requestsBefore+1);await wheel(await blank(),14,17);const pending=await viewport();await wait(async()=>(await snapshot()).session.status==='saved','late save acknowledgement');equalViewport(await viewport(),pending);await evaluate('window.e0.setFault({saveDelayMs:0})');
      const old=(await canvas()).container,center={x:(old.width/2-pending.x)/pending.zoom,y:(old.height/2-pending.y)/pending.zoom};const [w,h]=win.getSize();win.setSize(w-140,h-60);await settle();const resized=(await canvas()).container,v=await viewport();assert.ok(Math.abs((resized.width/2-v.x)/v.zoom-center.x)<2);assert.ok(Math.abs((resized.height/2-v.y)/v.zoom-center.y)<2);win.setSize(w,h);await settle();await click('[data-testid="fit-all"]');
      return {a,b,afterLateSave:pending};
    });
    await check('native pointer drags before/after and across parent at two non-100% scales commit exactly once with stable references/images',async()=>{
      const before=await snapshot();
      let step=await drag('e0-a-n6','e0-a-n5','before',{scale:.65});let after=await snapshot();assert.deepEqual(after.state.map.nodes['e0-a-n2'].children.slice(0,2),['e0-a-n6','e0-a-n5']);observations.beforeDrop=step;
      step=await drag('e0-a-n6','e0-a-n5','after',{scale:.45});after=await snapshot();assert.deepEqual(after.state.map.nodes['e0-a-n2'].children.slice(0,2),['e0-a-n5','e0-a-n6']);observations.afterDrop=step;
      const previous=after;step=await drag('e0-a-n6','e0-a-n5','child',{scale:.65});after=await snapshot();assert.equal(after.state.map.nodes['e0-a-n6'].parentId,'e0-a-n5');assert.equal(after.state.history.past.length,previous.state.history.past.length+1);
      for(const [id,node]of Object.entries(before.state.map.nodes)){assert.equal(after.state.map.nodes[id].id,node.id);assert.deepEqual(after.state.map.nodes[id].sourceRefs,node.sourceRefs);assert.deepEqual(after.state.map.nodes[id].image,node.image);}
      const currentView=await viewport();await probe('command',{type:'undo'});equalViewport(await viewport(),currentView);assert.equal((await snapshot()).state.map.nodes['e0-a-n6'].parentId,'e0-a-n2');await probe('command',{type:'redo'});equalViewport(await viewport(),currentView);assert.equal((await snapshot()).state.map.nodes['e0-a-n6'].parentId,'e0-a-n5');observations.childDrop=step;
      return {moves:3,scales:[observations.beforeDrop.preview.viewport.zoom,observations.afterDrop.preview.viewport.zoom],historyOnePerMove:true};
    });
    await check('root/self/descendant/blank drops and Escape/pointercancel leave content, save counters and history unchanged',async()=>{
      const sig=await signature();await drag('e0-a-n6','e0-a-n11','child',{cancel:'escape'});assert.deepEqual(await signature(),sig);await drag('e0-a-n6','e0-a-n11','child',{cancel:'pointercancel'});assert.deepEqual(await signature(),sig);
      await drag('e0-a-n5','e0-a-n6','child');assert.deepEqual(await signature(),sig);await drag('e0-a-n6','e0-a-n6','child');assert.deepEqual(await signature(),sig);await drag('e0-a-n2','e0-a-n1','before',{scale:.45});assert.deepEqual(await signature(),sig);
      await probe('command',{type:'select',selection:{kind:'node',nodeId:'e0-a-n6'}});await click('[data-testid="center-selected"]');const moving=await box('[data-node-id="e0-a-n6"] .node-title'),start={x:moving.x+moving.width/2,y:moving.y+moving.height/2};await mouse('mouseDown',start,{button:'left',clickCount:1});await mouse('mouseMove',{x:start.x+40,y:start.y+30},{button:'left'});await settle();assert.ok((await canvas()).gesture?.active);await probe('switchWorkspace','e0-b-workspace');await settle();assert.equal((await canvas()).gesture,null);await mouse('mouseUp',start,{button:'left',clickCount:1});await probe('switchWorkspace','e0-a-workspace');await settle();assert.deepEqual(await signature(),sig);
      await probe('command',{type:'select',selection:{kind:'node',nodeId:'e0-a-n1'}});await click('[data-testid="center-selected"]');const rootBox=await box('[data-node-id="e0-a-n1"] .node-title'),p={x:rootBox.x+rootBox.width/2,y:rootBox.y+rootBox.height/2},q=await blank();await mouse('mouseDown',p,{button:'left',clickCount:1});await mouse('mouseMove',q,{button:'left'});await mouse('mouseUp',q,{button:'left',clickCount:1});await settle();assert.deepEqual(await signature(),sig);
      return {pointercancelEvidence:'synthetic PointerEvent, separate from native mouse/Escape',invalidNativeDrops:true};
    });
    await check('native ASCII input and synthetic composition survive viewport changes; Space still edits a title',async()=>{
      await probe('command',{type:'select',selection:{kind:'node',nodeId:'e0-a-n8'}});await click('[data-testid="center-selected"]');await key(' ');await wait(()=>evaluate('Boolean(document.querySelector(".title-editor .ProseMirror"))'),'title editor');const count=Object.keys((await snapshot()).state.map.nodes).length;
      await probe('titleSelect',0);win.webContents.sendInputEvent({type:'char',keyCode:'A'});await settle();await probe('composition','title','start');await wheel(await blank(),8,12);assert.equal((await snapshot()).state.view.inputSession.composing,true);await probe('syntheticKey','title','Enter',{isComposing:true});assert.equal(Object.keys((await snapshot()).state.map.nodes).length,count);await probe('composition','title','end');await delay(100);await key('Enter');assert.ok((await snapshot()).state.map.nodes['e0-a-n8'].title[0].text.startsWith('A'));
      await probe('bodySelect','e0-a-draft-p1',0);win.webContents.sendInputEvent({type:'char',keyCode:'B'});await wheel(await blank(),5,10);win.webContents.sendInputEvent({type:'char',keyCode:'C'});await settle();assert.ok((await snapshot()).editorText.includes('BC'));return {nativeAscii:true,syntheticComposition:true,realMacOSIME:'separate manual run required'};
    });
    await check('saved moved structure and all nodes/refs/assets survive actual renderer reload with no remote fallback',async()=>{
      observations.wheelToSecondFrame=await evaluate('window.__e01FrameLatency');observations.beforeReloadCanvas=await canvas();assert.equal(await probe('save'),true);const before=await evaluate(`window.e0.load('e0-a-workspace')`);const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await loaded;await wait(()=>evaluate('Boolean(window.e0Probe?.canvasSnapshot&&window.e0Probe.snapshot().state)'),'reload');await evaluate('Promise.all([...document.images].map(i=>i.decode()))');const after=await evaluate(`window.e0.load('e0-a-workspace')`);assert.deepEqual(after,before);fs.writeFileSync(path.join(evidenceDir,'e01-saved-bundle.json'),JSON.stringify(after,null,2));assert.equal(Object.keys(after.map.nodes).length,observations.nodeCount);assert.equal(await evaluate(`fetch('https://example.com/e01').then(()=>false,()=>true)`),true);return {revision:after.map.revision,nodeCount:observations.nodeCount};
    });
    await click('[data-testid="fit-all"]');await settle();
    observations.canvas=await canvas();observations.appProcessMetrics=require('electron').app.getAppMetrics().map(({pid,type,memory,cpu})=>({pid,type,memory,cpu}));observations.hardware={platform:process.platform,arch:process.arch,cpus:require('node:os').cpus()[0]?.model,totalMemoryBytes:require('node:os').totalmem()};observations.mainProcessMemoryKB=await process.getProcessMemoryInfo();observations.rendererPerformanceMemory=await evaluate('performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:null');
    fs.writeFileSync(path.join(evidenceDir,'canvas-final.png'),(await win.webContents.capturePage()).toPNG());
    const output={startedAt,finishedAt:new Date().toISOString(),root,synthetic:true,inputMethod:'Electron webContents.sendInputEvent mouse/wheel/keyboard into real renderer; setup probes and synthetic composition separately identified',passed:results.length,failed:0,results,observations,electron:process.versions.electron,node:process.versions.node};fs.writeFileSync(path.join(evidenceDir,'e01-ui-regression.json'),JSON.stringify(output,null,2));return output;
  }catch(error){fs.writeFileSync(path.join(evidenceDir,'e01-ui-regression.json'),JSON.stringify({startedAt,failed:1,passed:results.length,error:error.stack||String(error),results,observations},null,2));fs.writeFileSync(path.join(evidenceDir,'canvas-failure.png'),(await win.webContents.capturePage()).toPNG());throw error;}
}
module.exports={runCanvasRegression};
