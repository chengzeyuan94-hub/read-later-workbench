// Finite local acceptance controls. Enabled only by the new batch runtime's
// explicit RLW_BATCH_CONTROL=1 flag. All mutations use the real product services.
const fs=require('node:fs'),path=require('node:path');
module.exports=async function({app,win,service,batch,paths,setProcessingAllowed,validateBatchSelection,exportCompleted,sourceDiagnostics,credentials}){
  const root=path.join(paths.evidenceDir,'live');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const command=path.join(root,'command.json');let busy=false,closed=false;
  const save=(name,data)=>{const target=path.join(root,name),tmp=target+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,target);};
  const snapshot=()=>{if(closed)return;try{const state=service.state(),contents=state.contents.map(c=>({id:c.id,platform:c.platform,accountId:c.accountId,sourceId:c.sourceId,title:c.title,kind:c.kind,bodyCharacters:c.body.length,offline:c.offline,bodyComplete:c.bodyComplete,mediaManifestComplete:c.mediaManifestComplete,availability:c.availability,detailState:c.detailState,detailError:c.detailError,media:c.media.map(m=>({id:m.id,kind:m.kind,current:m.current,state:m.state,bytes:m.bytes,durationSeconds:m.durationSeconds,title:m.title,error:m.error,localPath:m.localPath}))}));save('state.json',{at:new Date().toISOString(),pid:process.pid,credentials:credentials(),online:state.online,busy:state.busy,downloadsPaused:state.downloadsPaused,progress:state.progress,recentSync:state.recentSync,connections:state.connections,batches:batch.list(),contents,syncs:state.syncs.slice(0,8)});}catch{save('snapshot-error.json',{at:new Date().toISOString(),reason:'snapshot failed'});}};
  const tick=async()=>{if(closed||busy||!fs.existsSync(command))return;busy=true;let input;
    try{
      const info=fs.lstatSync(command);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024)throw Error('控制文件无效');
      input=JSON.parse(fs.readFileSync(command,'utf8'));
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))throw Error('操作编号无效');
      const receipt=path.join(root,input.id+'.result.json');
      if(fs.existsSync(receipt)){fs.unlinkSync(command);return;}
      fs.renameSync(command,path.join(root,input.id+'.request.json'));
      let result;
      if(input.action==='source-diagnostics')result=await sourceDiagnostics();
      else if(input.action==='sync')result=await service.sync(input.platform);
      else if(input.action==='processing'&&typeof input.allowed==='boolean')result=setProcessingAllowed(input.allowed);
      else if(input.action==='create')result=batch.create(validateBatchSelection(input.contentIds));
      else if(input.action==='pause')result=batch.pause(input.batchId);
      else if(input.action==='resume')result=batch.resume(input.batchId);
      else if(input.action==='retry-digest')result=batch.retry(input.batchId,input.contentId);
      else if(input.action==='pause-downloads')result=service.pauseDownloads();
      else if(input.action==='pause-content-download')result=service.pauseContentDownload(input.contentId,input.reason);
      else if(input.action==='resume-downloads')result=service.resumeDownloads();
      else if(input.action==='retry-download')result=service.retry(input.contentId,input.mediaId);
      else if(input.action==='snapshot')snapshot();
      else if(input.action==='export-completed')result=await exportCompleted(input.contentId);
      else throw Error('未知有限验收操作');
      save(input.id+'.result.json',{at:new Date().toISOString(),ok:true,result:result??null});
    }catch(error){const name=input?.id&&/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)?input.id:'invalid';const message=String(error?.message||'操作失败').replace(/https?:\/\/\S+/g,'[地址已隐藏]').slice(0,400);save(name+'.result.json',{at:new Date().toISOString(),ok:false,error:message});}
    finally{busy=false;snapshot();}
  };
  snapshot();const snapshots=setInterval(snapshot,5000),controls=setInterval(()=>void tick(),1000);snapshots.unref();controls.unref();
  app.once('before-quit',()=>{closed=true;clearInterval(snapshots);clearInterval(controls);});
};
