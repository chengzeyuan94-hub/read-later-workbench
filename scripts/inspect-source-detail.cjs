// Read-only native-session diagnostics. Quit the application before running.
const {app}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const Database=require('better-sqlite3');
app.setPath('userData',process.env.RLW_USER_DATA_DIR||path.join(app.getPath('appData'),'ReadLaterWorkbench'));
if(!app.requestSingleInstanceLock())app.exit(2);
app.commandLine.appendSwitch('log-level','3');
app.whenReady().then(async()=>{
  if(!process.env.RLW_DATA_DIR)throw Error('Set explicit RLW_DATA_DIR and quit the main app first');
  const db=new Database(path.join(process.env.RLW_DATA_DIR,'workbench.sqlite'),{readonly:true,nativeBinding:path.resolve('.runtime/electron.node')});
  const row=db.prepare('select * from contents where id=?').get(Number(process.env.RLW_CONTENT_ID||1));db.close();
  if(!row)throw Error('Content not found');
  const {createSources}=await import(pathToFileURL(path.resolve('dist/main/sources.js')).href);
  const {sanitizeSourceError}=await import(pathToFileURL(path.resolve('dist/main/source-core.js')).href);
  const sources=createSources();let evidence;
  try{
    const result=await sources.adapters.find(a=>a.platform===row.platform).detail({sourceId:row.source_id,title:row.title,author:row.author,url:row.url,kind:row.kind,folderIds:[]});
    evidence={readOnly:true,saved:false,contentId:row.id,platform:row.platform,bodyLength:result.body.length,bodyComplete:result.bodyComplete,media:result.media.map(m=>({kind:m.kind,mime:m.mime||null}))};
  }catch(error){evidence={readOnly:true,saved:false,contentId:row.id,platform:row.platform,error:sanitizeSourceError(error)};process.exitCode=1;}
  finally{sources.dispose();}
  const text=JSON.stringify(evidence,null,2);if(process.env.RLW_PROBE_OUTPUT)fs.writeFileSync(process.env.RLW_PROBE_OUTPUT,text);console.log(text);app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
setTimeout(()=>{console.error('Source detail probe timed out');app.exit(124)},60000).unref();
