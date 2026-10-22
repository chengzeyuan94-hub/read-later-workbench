const {app,BrowserWindow,protocol,session}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const root=path.resolve('.acceptance-data');
const real=process.env.RLW_REAL_PLAYBACK==='1';
const videoPlatform=process.env.RLW_PLAY_VIDEO_PLATFORM||'bilibili';
if(!['xiaohongshu','bilibili'].includes(videoPlatform))throw Error('Unknown video platform');
if(real&&!process.env.RLW_DATA_DIR)throw Error('Real playback requires explicit RLW_DATA_DIR; quit the application first');
app.setPath('userData',path.join(root,'playback-userData'));
protocol.registerSchemesAsPrivileged([{scheme:'rlw-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.whenReady().then(async()=>{
  const {Store}=await import(pathToFileURL(path.resolve('dist/main/store.js')).href);
  const {mediaResponse}=await import(pathToFileURL(path.resolve('dist/main/media.js')).href);
  let store;
  if(real){
    // Coexist safely with the main application: no task recovery/migration writes.
    const Database=require('better-sqlite3');const mediaDir=path.join(path.resolve(process.env.RLW_DATA_DIR),'media');
    const db=new Database(path.join(path.resolve(process.env.RLW_DATA_DIR),'workbench.sqlite'),{readonly:true,nativeBinding:path.resolve('.runtime/electron.node')});
    const media=db.prepare('select id,content_id,kind,state,local_path,mime from media order by id').all().map(m=>({id:m.id,contentId:m.content_id,kind:m.kind,state:m.state,localPath:m.local_path,mime:m.mime}));
    const rows=db.prepare('select id,platform,kind,digested_at,body_complete,detail_state from contents order by id').all();
    const contents=rows.map(c=>{const all=media.filter(m=>m.contentId===c.id);return {id:c.id,platform:c.platform,kind:c.kind,digestedAt:c.digested_at,media:all,offline:!!c.body_complete&&c.detail_state==='succeeded'&&all.some(m=>m.kind===c.kind)&&all.every(m=>m.state==='succeeded'&&m.localPath&&fs.existsSync(path.join(mediaDir,m.localPath)))};});
    store={mediaDir,contents:()=>contents,media:id=>media.find(m=>m.id===id),close:()=>db.close()};
  }else store=new Store(path.join(root,'data'));
  let blocked=0;let served=0;let ranges=0;
  session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_d,cb)=>{blocked++;cb({cancel:true});});
  protocol.handle('rlw-media',r=>{served++;if(r.headers.has('range'))ranges++;return mediaResponse(r,store.mediaDir,store.media(Number(new URL(r.url).pathname.slice(1))));});
  const contents=store.contents();const imageOwner=contents.find(c=>(!real||c.platform==='xiaohongshu')&&c.kind==='image'&&c.offline);const videoOwner=contents.find(c=>(!real||c.platform===videoPlatform)&&c.kind==='video'&&c.offline);const image=imageOwner?.media.find(m=>m.kind==='image'&&m.state==='succeeded');const video=videoOwner?.media.find(m=>m.kind==='video'&&m.state==='succeeded');
  if(!image||!video)throw Error('Run fixture:prepare first');
  const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,autoplayPolicy:'no-user-gesture-required'}});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<img id="i" src="rlw-media://local/${image.id}"><video id="v" muted src="rlw-media://local/${video.id}"></video>`));
  const result=await win.webContents.executeJavaScript(`(async()=>{const i=document.querySelector('#i'),v=document.querySelector('#v');await Promise.all([i.complete&&i.naturalWidth?Promise.resolve():new Promise((r,j)=>{i.onload=r;i.onerror=j;}),v.readyState>=2?Promise.resolve():new Promise((r,j)=>{v.onloadeddata=r;v.onerror=()=>j(Error('video decode error '+v.error?.code));})]);await v.play();await new Promise(r=>setTimeout(r,1100));const progressed=v.currentTime;v.currentTime=4;await new Promise(r=>v.addEventListener('seeked',r,{once:true}));const seeked=v.currentTime;let networkBlocked=false;try{await fetch('https://example.com/offline-probe')}catch{networkBlocked=true;}return {imageWidth:i.naturalWidth,imageHeight:i.naturalHeight,videoDuration:v.duration,progressed,seeked,networkBlocked,videoError:v.error?.code??null}})()`);
  if(!(result.imageWidth>0&&result.progressed>.5&&result.seeked>=4&&result.networkBlocked))throw Error('Playback assertion failed');
  const evidence={fixture:!real,realAcceptance:real,restartedProcess:true,chromiumRequestBlock:true,...result,blockedExternalRequests:blocked,servedLocalRequests:served,rangeRequests:ranges,imageContentId:imageOwner.id,videoContentId:videoOwner.id,videoPlatform:videoOwner.platform,persistedContents:contents.length,persistedDigested:contents.filter(c=>c.digestedAt).length,offline:contents.filter(c=>c.offline).length,electron:process.versions.electron,node:process.versions.node};
  fs.mkdirSync('.acceptance-data/fixtures',{recursive:true});fs.writeFileSync(`.acceptance-data/fixtures/${real?(videoPlatform==='xiaohongshu'?'real-xhs':'real'):'fixture'}-offline-playback.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));store.close();win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1);});
setTimeout(()=>{console.error('Playback smoke timeout');app.exit(2)},25000).unref();
