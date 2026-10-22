/** Isolated synthetic media acceptance. Never imports fixtures into real userData. */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkbenchService } from '../src/main/service.js';
import type { SourceAdapter, Platform } from '../src/shared/contracts.js';
const root = path.resolve('.acceptance-data');
mkdirSync(path.join(root,'fixtures'),{recursive:true});
const image = path.join(root,'fixtures/image.png');
const video = path.join(root,'fixtures/video.mp4');
execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=600x760:rate=1','-frames:v','1',image],{stdio:'ignore'});
execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','6','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',video],{stdio:'ignore'});
const server = createServer((req,res)=>{const file=req.url==='/video'?video:image;const bytes=readFileSync(file);res.writeHead(200,{'content-type':file===video?'video/mp4':'image/png','content-length':bytes.length});res.end(bytes);});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address() as {port:number};
const adapters:SourceAdapter[]=(['xiaohongshu','bilibili'] as Platform[]).map(platform=>({platform,async collect(){return {platform,accountId:'fixture-only',accountName:'测试夹具账号',folders:[{id:'fixture',title:'测试夹具'}],items:[{sourceId:`fixture-${platform}`,title:platform==='xiaohongshu'?'【测试夹具】本地图片与来源正文':'【测试夹具】本地视频与拖动播放',author:'合成数据 · 不计入真实验收',url:platform==='xiaohongshu'?'https://www.xiaohongshu.com/':'https://www.bilibili.com/',kind:platform==='xiaohongshu'?'image':'video',folderIds:['fixture']}],complete:true};},async detail(){return {body:'这是独立验收库中的合成测试内容，用来验证本地保存、重启、离线阅读与媒体播放。它不是从小红书或B站采集的真实收藏，不计入真实链路验收。',bodyComplete:true,media:[{remoteUrl:`http://127.0.0.1:${address.port}/${platform==='bilibili'?'video':'image'}`,kind:platform==='bilibili'?'video':'image',mime:platform==='bilibili'?'video/mp4':'image/png'}]};}}));
const service = new WorkbenchService(path.join(root,'data'),adapters,{connections:()=>[]});
await service.sync();await service.waitForIdle();
const first=service.state().contents.find(c=>c.platform==='xiaohongshu')!;
// Historical synthetic mark for legacy rendering, never authorization to run engines.
service.store.digest(first.id,true,Date.now());
const state=service.state();
const evidence={fixture:true,realAcceptance:false,contents:state.contents.map(c=>({id:c.id,title:c.title,bodyComplete:c.bodyComplete,offline:c.offline,digested:!!c.digestedAt,media:c.media.map(m=>({id:m.id,kind:m.kind,state:m.state,bytes:m.bytes,localPath:m.localPath}))})),today:state.today.length,reviews:state.reviews.length};
mkdirSync(path.join(root,'fixtures'),{recursive:true});writeFileSync(path.join(root,'fixtures','fixture-save.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));service.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
