import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, net, powerMonitor, protocol, session, shell } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSources } from './sources.js';
import { createSocialSources } from './social-sources.js';
import { createTwitterSources } from './twitter-source.js';
import { createBatchLogin } from './batch-login.js';
import { PLATFORMS, isPlatform, allowedPlatformUrl } from '../shared/platforms.js';
import { batchBuildMode, resolveBatchPaths, acquireBatchSourceLease } from './batch-isolation.js';
import { BatchDigestCoordinator } from './batch-digest.js';
import { WorkbenchService } from './service.js';
import { mediaResponse, mediaThumbnail } from './media.js';
import type { Platform, SyncRange } from '../shared/contracts.js';
import { resolveE1Paths } from './e1-isolation.js';
import { resolveE11Paths } from './e11-isolation.js';
import { e111BuildMode, resolveE111Paths } from './e111-isolation.js';
import { e2BuildMode, resolveE2Paths } from './e2-isolation.js';
import { e3BuildMode, resolveE3Paths } from './e3-isolation.js';
import { e3FixBuildMode, resolveE3FixPaths } from './e3-fix-isolation.js';
import { e3RealBuildMode, e3RealQaScript, resolveE3RealPaths } from './e3-real-isolation.js';
import { GenerationRepository } from './generation-store.js';
import { GenerationRunner } from './generation-runner.js';
import { DeepSeekGenerationProvider } from './deepseek-generation-provider.js';
import { exportEditorXmind } from './editor-xmind.js';
import { AsrRepository } from './asr-store.js';
import { AsrRunner } from './asr-runner.js';
import { AsrCredentials } from './asr-credentials.js';
import { SiliconFlowAsrProvider, ASR_PROVIDER_CONFIG } from './asr-provider.js';
import { probeMedia, prepareMediaChunks, DEFAULT_ASR_PREPARATION_CONFIG, type AsrMediaProbe, type AsrPreparationConfig, type PreparedAsrChunk } from './asr-media.js';
import { exportAsrMarkdown } from './asr-export.js';
import { asrMediaResponse } from './asr-media-response.js';
import { e112BuildMode, resolveE112Paths } from './e112-isolation.js';
import { OcrRepository } from './ocr-store.js';
import { OcrHelperClient, OcrRunner } from './ocr-runner.js';
import { exportOcrMarkdown } from './ocr-export.js';
import { boundedFile, fixedAssetResponse, readFixedAsset } from './editor-media.js';
import type { EditorRepository } from './editor-store.js';
import { validateKnowledgeCardPayload } from '../shared/knowledge-card.js';
import type { EditorExportKind, EditorExportOptions } from '../shared/editor-contracts.js';
import { exportFilename } from './editor-export.js';
import { exportMarkdownPackage, previewExportMedia } from './editor-media-export.js';
import { PREVIEW_CONFIG, savedPreview } from './editor-preview.js';
import { isRendererFile } from './renderer-origin.js';
import { editorThumbnail } from './editor-image.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName('收藏阅读工作台');
// Chromium diagnostics can include signed CDN URLs. Application errors are
// classified by the source/task layer, so do not echo these raw network logs.
app.commandLine.appendSwitch('log-level', '3');
let batchMode=false,e3RealMode=false,e3FixMode=false,e3Mode=false,e2Mode=false,e112Mode=false, e111Mode=false;
try { batchMode=batchBuildMode(projectRoot,process.env);e3RealMode=e3RealBuildMode(projectRoot,process.env);e3FixMode=e3FixBuildMode(projectRoot,process.env);e3Mode=batchMode||e3RealMode||e3FixMode||e3BuildMode(projectRoot,process.env); e2Mode=e2BuildMode(projectRoot,process.env); e112Mode=e112BuildMode(projectRoot,process.env); e111Mode=e111BuildMode(projectRoot,process.env); }
catch { console.error('隔离构建拒绝正式目录或旧版本配置；请使用对应启动入口与明确的新隔离根。');app.exit(2); }
const e11Mode = e3Mode || e2Mode || e112Mode || e111Mode || process.env.RLW_E11_DIR !== undefined;
const e1Mode = e11Mode || process.env.RLW_E1_ISOLATED === '1' || process.env.RLW_E1_DIR !== undefined;
let e1Paths: ReturnType<typeof resolveE1Paths> | undefined;
let batchPaths: ReturnType<typeof resolveBatchPaths> | undefined;
let releaseSourceLease:(()=>void)|undefined;
let batchLogin:ReturnType<typeof createBatchLogin>|undefined;
const sourceSessions=new Map<Platform,Electron.Session>();
const sourceSessionFor=(platform:Platform):Electron.Session=>sourceSessions.get(platform)??session.fromPartition(`persist:rlw-${platform}`);
try { if(batchMode){batchPaths=resolveBatchPaths(process.env.RLW_BATCH_DIR,{mustExist:true});e1Paths=batchPaths;}else if(e3RealMode)e1Paths=resolveE3RealPaths(process.env.RLW_E3_REAL_DIR,{mustExist:true});else if(e3FixMode)e1Paths=resolveE3FixPaths(process.env.RLW_E3_FIX_DIR,{mustExist:true});else if(e3Mode)e1Paths=resolveE3Paths(process.env.RLW_E3_DIR,{mustExist:true});else if(e2Mode)e1Paths=resolveE2Paths(process.env.RLW_E2_DIR,{mustExist:true});else if (e112Mode) e1Paths = resolveE112Paths(process.env.RLW_E112_DIR, { mustExist: true }); else if (e111Mode) e1Paths = resolveE111Paths(process.env.RLW_E111_DIR, { mustExist: true }); else if (e11Mode) e1Paths = resolveE11Paths(process.env.RLW_E11_DIR, { mustExist: true }); else if (e1Mode) e1Paths = resolveE1Paths(process.env.RLW_E1_DIR, { mustExist: true }); }
catch { console.error('E1隔离配置无效，请先使用准备入口并指定规范绝对RLW_E1_DIR。'); app.exit(2); }
// E1.1 runtime is deliberately confined to the prepared copy; formal rollout needs PM approval.
const ocrEnabled = e11Mode;
const editorEnabled = ocrEnabled || !!e1Paths || process.env.RLW_ENABLE_EDITOR === '1';
const userData = e1Paths?.userDataDir || process.env.RLW_USER_DATA_DIR || path.join(app.getPath('appData'), 'ReadLaterWorkbench');
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
if(batchPaths)app.setPath('sessionData',batchPaths.sourceSessionDataDir);
protocol.registerSchemesAsPrivileged(['rlw-media', 'rlw-editor', 'rlw-digest', 'rlw-ocr', 'rlw-asr', 'rlw-generation'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } })));
let win: BrowserWindow | undefined;
let service: WorkbenchService | undefined;
let ocrRepository: OcrRepository | undefined;
let ocrRunner: OcrRunner | undefined;
let asrRepository: AsrRepository | undefined;
let asrRunner: AsrRunner | undefined;
let asrCredentials: AsrCredentials | undefined;
let generationCredentials: AsrCredentials | undefined;
let asrProvider: SiliconFlowAsrProvider | undefined;
let asrNetworkAllowed=process.env.RLW_ASR_OFFLINE!=='1';
let generationRepository: GenerationRepository | undefined;
let generationRunner: GenerationRunner | undefined;
let batchCoordinator:BatchDigestCoordinator|undefined;
let batchTimer:ReturnType<typeof setInterval>|undefined;
const kickProcessing=()=>{ocrRunner?.kick();asrRunner?.kick();generationRunner?.kick();};
function requestAuthorizedDigest(cid:number,renewed=false){
  const pipeline=service!.store.digestPipeline!;
  if(renewed){const preserveTerminal=pipeline.preservesTerminalHistory();generationRunner?.prepareRenewal(cid,preserveTerminal);asrRunner?.prepareRenewal(cid,preserveTerminal);}
  pipeline.request(cid,renewed);
  asrRepository?.authorize(cid,{preparationConfig:{...DEFAULT_ASR_PREPARATION_CONFIG}});
  generationRepository?.authorize(cid);
  if(renewed)ocrRunner?.cancel(cid);
  kickProcessing();return pipeline.status(cid);
}
function retryAuthorizedDigest(cid:number){
  const pipeline=service!.store.digestPipeline!;pipeline.retry(cid);ocrRepository?.retry(cid);
  if(asrRepository?.list(cid).authorized)asrRepository.retry(cid);
  if(generationRepository?.status(cid).authorized)generationRepository.retry(cid);
  kickProcessing();return pipeline.status(cid);
}
function cancelAuthorizedDigest(cid:number){generationRunner?.cancel(cid);asrRunner?.cancel(cid);const value=service!.store.digestPipeline!.cancel(cid);ocrRunner?.cancel(cid);return value;}
function validateBatchSelection(ids:unknown):number[]{
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('请选择有效的收藏');
  for(const id of ids){
    const content=service!.store.content(id);
    // E4.4 §6：不再要求条目属于本轮最近同步范围；保留下载暂停与重复入批排除。
    if(!content)throw Error('收藏不存在');
    if(service!.recentImport?.isDownloadPaused(id))throw Error('此条自动下载已暂停，不能新建消化任务；已有成果仍可阅读');
  }
  return ids;
}
function batchItemOwner(cid:number){const batch=batchCoordinator?.list().find(batch=>batch.items.some(item=>item.contentId===cid));if(!batch)throw Error('本条尚未加入本轮消化批次');return batch;}

let generationNetworkAllowed=process.env.RLW_GENERATION_OFFLINE!=='1'&&asrNetworkAllowed;
function setProcessingAllowed(allowed:boolean){if(batchMode)service?.store.setSetting('processingNetworkAllowed',String(allowed));asrNetworkAllowed=allowed;generationNetworkAllowed=allowed;asrRunner?.setNetworkAllowed(allowed&&net.isOnline());generationRunner?.setNetworkAllowed(allowed&&net.isOnline());return{allowed};}
const installGuards=new Map<string,{contentId:number;requestId:string;resolve:(allowed:boolean)=>void;timer:ReturnType<typeof setTimeout>}>();
async function beforeGenerationInstall(contentId:number,requestId:string):Promise<boolean>{
  if(quitting)return false;
  if(!win||win.isDestroyed())return true;
  return await new Promise<boolean>(resolve=>{const nonce=randomUUID();const finish=(allowed:boolean)=>{const pending=installGuards.get(nonce);if(!pending)return;clearTimeout(pending.timer);installGuards.delete(nonce);resolve(allowed);};const timer=setTimeout(()=>finish(false),5000);installGuards.set(nonce,{contentId,requestId,resolve:finish,timer});win!.webContents.send('rlw:generation-before-install',{nonce,contentId,requestId});});
}
let sources: ReturnType<typeof createSources> | undefined;
let bridgeFetch: ((url: string, init?: RequestInit, platform?: Platform) => Promise<Response>) | undefined;
let networkTimer: ReturnType<typeof setInterval> | undefined;
let evidenceTimer: ReturnType<typeof setInterval> | undefined;
const verifiedConnections = new Map<Platform, number>();
function refreshLoginVerification(): void {
  for (const connection of sources?.connections() ?? []) {
    if (connection.state === 'connected' && connection.verifiedAt && connection.verifiedAt > (verifiedConnections.get(connection.platform) ?? 0)) {
      service?.loginVerified(connection.platform, connection.verifiedAt);
      verifiedConnections.set(connection.platform, connection.verifiedAt);
    }
  }
}
function evidence(event: string, fields: Record<string, unknown> = {}): void {
  if (!e1Paths && !process.env.RLW_EVIDENCE_DIR) return;
  const dir = e1Paths?.evidenceDir || path.resolve(process.env.RLW_EVIDENCE_DIR!);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, 'runtime.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields }) + '\n');
}
const blocked = (e1Mode && !batchMode) || process.env.RLW_BLOCK_NETWORK === '1';
let quitting = false;
let closeApproved = false;
let closeRequest: string | undefined;
const thumbnails = new Map<string, Buffer>();
function requestShutdown(): void {
  if (quitting || closeRequest) return;
  if (!win || win.isDestroyed()) { closeApproved = true; app.quit(); return; }
  closeRequest = randomUUID();
  evidence('close-barrier-request');
  win.webContents.send('rlw:before-close', closeRequest);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  if(batchPaths){try{releaseSourceLease=acquireBatchSourceLease(batchPaths);}catch{console.error('本轮登录会话尚未释放，未打开任何平台。');app.exit(2);}}
  app.on('second-instance', () => { if (!quitting && win && !win.isDestroyed()) { win.show(); win.focus(); } });
  void app.whenReady().then(async () => {
    // Native text controls need the system edit roles (including Select All and
    // Paste); the app quit role still passes through the same save barrier.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    const dataDir = e1Paths?.dataDir || path.resolve(process.env.RLW_DATA_DIR || path.join(userData, 'data'));
    if(batchMode&&batchPaths){
      for(const platform of PLATFORMS){const value=session.fromPartition(`persist:rlw-${platform}`);if(value.storagePath!==batchPaths.sourcePartitions[platform])throw Error('独立登录会话路径不一致');sourceSessions.set(platform,value);evidence('batch-source-session',{platform,expected:batchPaths.sourcePartitions[platform],actual:value.storagePath});}
      batchLogin=createBatchLogin(sourceSessionFor);
      const probeOnStart=process.env.RLW_BLOCK_NETWORK!=='1';
      const legacy=createSources({sessionFor:sourceSessionFor,probeOnStart});
      const social=createSocialSources({sessionFor:sourceSessionFor,probeOnStart});
      const twitter=await createTwitterSources({sessionFor:sourceSessionFor,probeOnStart});
      sources={adapters:[...legacy.adapters,...social.adapters,...twitter.adapters],connections:()=>[...legacy.connections(),...social.connections(),...twitter.connections()],login:async platform=>{if(platform==='weibo'||platform==='zhihu')return social.login(platform);if(platform==='twitter')return twitter.login(platform);return legacy.login(platform);},dispose:()=>{legacy.dispose();social.dispose();twitter.dispose();}};
    } else if (e1Mode) {
      // This path does not even construct consumer sessions or a Chrome bridge.
      sources = { adapters: [], connections: () => [], login: async () => { throw new Error('隔离整理验收不提供平台登录'); }, dispose: () => {} };
    } else if (process.env.RLW_SOURCE_MODE === 'bridge') {
      const bridgeModule = './source-bridge.js';
      const { createBridgeSources } = await import(bridgeModule);
      const bridge = createBridgeSources(process.env.RLW_BRIDGE_PROFILE || 'default');
      sources = bridge;
      bridgeFetch = bridge.fetch;
    } else sources = createSources();
    if (blocked) {
      // Reproducible offline acceptance: block HTTP(S) at Chromium's request layer
      // for the UI and both consumer sessions, in addition to disabling sync.
      for (const s of e1Mode&&!batchMode ? [session.defaultSession] : [session.defaultSession, ...PLATFORMS.map(sourceSessionFor)]) {
        s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      }
      if (e1Mode) {
        let denied = false;
        try { await session.defaultSession.fetch('https://example.invalid/e1-network-block-check'); } catch { denied = true; }
        if (!denied) throw new Error('离线阻断校验失败，拒绝继续验收');
        evidence('network-block-probe', { blocked: denied, method: 'Electron defaultSession.fetch intercepted before HTTP(S)' });
      }
    }
    service = new WorkbenchService(dataDir, sources!.adapters, {
      editorEnabled, ocrEnabled, asrEnabled:e2Mode||e3Mode, generationEnabled:e3Mode, editorAssetsDir: e1Paths?.assetsDir, backgroundDisabled: e1Mode&&!batchMode,
      ...(batchMode?{recentImport:{batchId:path.basename(e1Paths!.root),limit:100}}:{}),
      connections: sources!.connections,
      evidence: (event, fields) => evidence(event, fields),
      fetch: async (url, init, platform) => {
        if (blocked) throw new Error('offline: application network requests are blocked');
        if (bridgeFetch) return bridgeFetch(url, init, platform);
        const sourceSession = platform ? sourceSessionFor(platform) : session.defaultSession;
        const headers = new Headers(init?.headers);
        const referrer = headers.get('referer');
        headers.delete('referer');
        return sourceSession.fetch(url, { ...init, headers, ...(referrer ? { referrer, referrerPolicy: 'unsafe-url' as const } : {}) });
      },
    });
    // E4.16: the user's「允许 AI 处理联网」choice survives restarts in daily batch use.
    if(batchMode&&!blocked){const saved=service.store.setting('processingNetworkAllowed','');if(saved)setProcessingAllowed(saved==='true');}
    if(batchMode){batchCoordinator=new BatchDigestCoordinator(service.store.db,{getContent:cid=>service!.store.content(cid),statusDigest:cid=>service!.store.digestPipeline!.status(cid),requestDigest:requestAuthorizedDigest,retryDigest:retryAuthorizedDigest,cancelDigest:cancelAuthorizedDigest,kickRunners:kickProcessing,evidence:(event,fields)=>evidence(event,fields)});}
    if(ocrEnabled){
      if(!service.store.editor||!service.store.digestPipeline)throw new Error('图片文字需要已迁移的编辑与消化存储');
      ocrRepository=new OcrRepository(service.store.db,dataDir,service.store.editor,service.store.digestPipeline,e3Mode||e2Mode||e112Mode||e111Mode?{normalizationPolicy:'imageio-decode-v2'}:undefined);
      ocrRunner=new OcrRunner(ocrRepository,new OcrHelperClient(path.join(projectRoot,'native/ocr-helper')),batchCoordinator?.hooks('ocr'));
      await ocrRunner.probe(); // Metadata/capability only, never image recognition.
      ocrRunner.start(); // Resumes only explicitly requested, still-valid frozen scopes.
    }
    if(e2Mode||e3Mode){
      if(!service.store.digestPipeline)throw Error('转录需要隔离消化存储');
      asrCredentials=new AsrCredentials(userData,'siliconflow',batchPaths?[batchPaths.credentialUserDataDirs.siliconflow]:[]);
      asrProvider=new SiliconFlowAsrProvider({apiKey:()=>asrCredentials?.read(),networkAllowed:()=>asrNetworkAllowed&&net.isOnline()});
      asrRepository=new AsrRepository(service.store.db,dataDir,service.store.digestPipeline,ASR_PROVIDER_CONFIG);
      asrRunner=new AsrRunner(asrRepository,{
        probe:async input=>await probeMedia(input) as unknown as Record<string,unknown>,
        prepare:input=>prepareMediaChunks({...input,probe:input.probe as unknown as AsrMediaProbe,config:input.config as unknown as AsrPreparationConfig}),
      },{configured:()=>asrProvider!.configured(),transcribe:input=>asrProvider!.transcribe({...input,chunk:input.chunk as PreparedAsrChunk})},ASR_PROVIDER_CONFIG,{batch:batchCoordinator?.hooks('asr'),networkAllowed:asrNetworkAllowed&&net.isOnline(),changed:()=>{service?.store.digestPipeline?.setASRCapability(!!asrCredentials?.read(),'音视频真实转录已接入，配置与联网条件见逐项状态');generationRunner?.kick();}});
      service.store.digestPipeline.setASRCapability(asrProvider.configured(),asrProvider.configured()?'音视频真实转录已接入，等待明确请求':'音视频转录等待安全配置');
      asrRunner.start(); // Only E2 authorizations exist in this queue; legacy requests cannot upload.
    }
    if(e3Mode){
      if(!service.store.editor||!service.store.digestPipeline)throw Error('阅读创作需要明确 E3 隔离存储');
      generationRepository=new GenerationRepository(service.store.db,dataDir,service.store.editor,service.store.digestPipeline,{ocr:ocrRepository,asr:asrRepository});
      generationCredentials=new AsrCredentials(userData,'deepseek',batchPaths?[batchPaths.credentialUserDataDirs.deepseek]:[]);
      const generationProvider=new DeepSeekGenerationProvider({apiKey:()=>generationCredentials?.read(),networkAllowed:()=>generationNetworkAllowed&&net.isOnline()});
      generationRunner=new GenerationRunner(generationRepository,generationProvider,{batch:batchCoordinator?.hooks('generation'),networkAllowed:generationNetworkAllowed&&net.isOnline(),beforeInstall:beforeGenerationInstall});
      service.store.digestPipeline.setGenerationCapability(generationProvider.configured(),generationProvider.configured()?'官方 DeepSeek 生成已接入；仅对明确新请求核实模型并处理':'等待官方 DeepSeek 生成安全配置与账户模型核验');
      generationRunner.start(); // Resumes only authorizations already created by an explicit click.
      generationRepository.unstickInputLimit((event,fields)=>evidence(event,fields)); // One-shot e415InputLimitReplan: release requests stuck on the old 12-chunk input-limit.
      generationRepository.unstickInvalidOutput((event,fields)=>evidence(event,fields)); // One-shot e416InvalidOutputRetry: requeue requests failed on a first invalid-output.
    }
    if (!e1Mode && process.env.RLW_RETRY_CONTENT) {
      const retryId = Number(process.env.RLW_RETRY_CONTENT);
      if (!Number.isSafeInteger(retryId) || retryId <= 0) throw new Error('重试内容ID无效');
      service.retry(retryId);
    }
    if(batchCoordinator){batchTimer=setInterval(()=>{if(!quitting){batchCoordinator?.tick();kickProcessing();}},2000);batchTimer.unref();}
    service.setOnline(!blocked && net.isOnline());
    evidence('boot', { mode: process.env.RLW_SOURCE_MODE || 'electron', networkBlocked: blocked, dataDir });
    let lastSyncState = '';
    const recordState = () => {
      if (quitting || !service) return;
      const state = service.state();
      const syncs = state.syncs.slice(0, 6).map(s => ({ id: s.id, platform: s.platform, startedAt: s.startedAt, finishedAt: s.finishedAt, trigger: s.trigger, state: s.state, discovered: s.discovered, saved: s.saved, incrementalStatus: s.incrementalStatus, incrementalNew: s.incrementalNew }));
      const key = JSON.stringify(syncs);
      if (key !== lastSyncState) { evidence('sync-state', { syncs }); lastSyncState = key; }
      evidence('heartbeat', { online: state.online, autoSync: state.autoSync, scheduler: state.scheduler, progress: state.progress });
    };
    if (e1Paths || process.env.RLW_EVIDENCE_DIR) { recordState(); evidenceTimer = setInterval(recordState, 30_000); evidenceTimer.unref(); }
    protocol.handle('rlw-media', async request => {
      if (quitting || !service) return new Response(null, { status: 503 });
      const url = new URL(request.url);
      if (url.hostname !== 'local' || !/^\/\d+$/.test(url.pathname)) return new Response(null, { status: 404 });
      const record = service.getMedia(Number(url.pathname.slice(1)));
      const mediaDir = service.store.mediaDir;
      const thumb = record ? await mediaThumbnail(mediaDir, record, Number(url.searchParams.get('w')) || 0) : null;
      return mediaResponse(request, mediaDir, thumb ? { ...record!, localPath: path.relative(await realpath(mediaDir), thumb), mime: 'image/jpeg' } : record);
    });
    const platform = (value: unknown): Platform => { if (!isPlatform(value)||!batchMode&&!['xiaohongshu','bilibili'].includes(value)) throw new Error('未知平台'); return value; };
    const id = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('无效内容ID'); return value; };
    const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('无效设置'); return value; };
    const uiFile = path.join(projectRoot, 'renderer/index.html');
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (event.sender !== win?.webContents || event.senderFrame !== win?.webContents.mainFrame || !isRendererFile(event.senderFrame.url, uiFile)) throw new Error('禁止访问本地应用接口');
    };
    const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(`rlw:${name}`, async (event, ...args) => {
      // Renderer polling can already be in flight when capture-and-exit or a
      // window close destroys the BrowserWindow. Ignore only closing requests
      // before touching webContents, checking senderFrame, or entering SQLite.
      if (quitting || !win || win.isDestroyed() || event.sender.isDestroyed() || !service) return;
      trusted(event);
      try { return await fn(...args); }
      catch (error) {
        if (!name.startsWith('editor-') && !name.startsWith('digest-') && !name.startsWith('ocr-') && !name.startsWith('asr-') && !name.startsWith('generation-')) throw error;
        evidence('editor-operation-failed', { operation: name });
        const message = error instanceof Error ? error.message : '';
        throw new Error(/^[\u3400-\u9fff]/.test(message) && !/https?:|cookie|token|authorization|\n/i.test(message) ? message.slice(0, 180) : '整理操作未完成，当前内容保留，请重试');
      }
    });
    handle('state', () => { refreshLoginVerification(); return { ...service!.state(), editorEnabled, isolationMode: e1Mode, ...(asrCredentials ? { processingConfiguration: { asrConfigured:asrCredentials.status().configured, asrNetworkAllowed:asrNetworkAllowed&&net.isOnline(), ...(generationCredentials ? { generationConfigured:generationCredentials.status().configured, generationNetworkAllowed:generationNetworkAllowed&&net.isOnline() } : {}) } } : {}), ...(e1Mode && !batchMode ? { autoSync: false } : {}) }; });
    if(batchCoordinator){
      const batchId=(value:unknown)=>{if(typeof value!=='string'||!/^batch-[a-z0-9-]+$/.test(value))throw Error('批次编号无效');return value;};
      handle('batch-create',ids=>batchCoordinator!.create(validateBatchSelection(ids)));
      handle('batch-list',()=>batchCoordinator!.list());
      handle('batch-status',value=>batchCoordinator!.status(batchId(value)));
      handle('batch-pause',value=>batchCoordinator!.pause(batchId(value)));
      handle('batch-resume',value=>batchCoordinator!.resume(batchId(value)));
      handle('batch-retry',(value,cid)=>batchCoordinator!.retry(batchId(value),id(cid)));
      handle('batch-cancel',(value,cid)=>batchCoordinator!.cancelItem(batchId(value),id(cid)));
      handle('downloads-pause',()=>service!.pauseDownloads());
      handle('downloads-resume',()=>service!.resumeDownloads());
      handle('downloads-resume-platform',value=>service!.resumePlatform(platform(value)));
    }
    const idList=(value:unknown):number[]=>{if(!Array.isArray(value)||!value.length)throw Error('收藏列表无效');return value.map(v=>id(v));};
    handle('delete-preview',value=>service!.deletePreview(idList(value)));
    handle('delete-contents',value=>service!.deleteContents(idList(value)));
    handle('deleted-contents',()=>service!.deletedContents());
    handle('restore-deleted',value=>service!.restoreDeleted(id(value)));
    const requireCollection = () => { if (e1Mode&&!batchMode) throw new Error('隔离整理验收已停用登录、采集与下载队列'); };
    handle('sync', value => { requireCollection(); return service!.sync(value === undefined ? undefined : platform(value)); });
    handle('login', value => { requireCollection(); if(batchLogin){void sources!.login(platform(value)).catch(()=>undefined);return;}return sources!.login(platform(value)); });
    handle('digest', (contentId, value) => { const cid=id(contentId),enabled=boolean(value);if(batchCoordinator&&enabled){batchCoordinator.create(validateBatchSelection([cid]));return;}if(!enabled){generationRunner?.cancel(cid);asrRunner?.cancel(cid);}service!.digest(cid,enabled);if(enabled){if(asrRepository){asrRepository.authorize(cid,{preparationConfig:{...DEFAULT_ASR_PREPARATION_CONFIG}});asrRunner?.kick();}if(generationRepository){generationRepository.authorize(cid);generationRunner?.kick();}ocrRunner?.kick();}else ocrRunner?.cancel(cid); });
    const pipeline = () => { if (!service?.store.digestPipeline) throw new Error('消化流程尚未启用，请先完成明确的备份与升级安排'); return service.store.digestPipeline; };
    handle('digest-request', (contentId, renew) => {const cid=id(contentId),renewed=renew===undefined?false:boolean(renew);if(batchCoordinator){const owned=batchCoordinator.list().flatMap(batch=>batch.items.filter(item=>item.contentId===cid));const open=owned.some(item=>!['complete','candidate','failed','result-unknown','cancelled'].includes(item.state));if(open)return pipeline().status(cid);if(!renewed&&owned.some(item=>item.state==='complete'||item.state==='candidate'))return pipeline().status(cid);batchCoordinator.create(validateBatchSelection([cid]),renewed);return pipeline().status(cid);}return requestAuthorizedDigest(cid,renewed);});
    handle('digest-status', contentId => pipeline().status(id(contentId)));
    handle('digest-list', () => pipeline().list());
    handle('digest-cancel',contentId=>{const cid=id(contentId);if(batchCoordinator){batchCoordinator.cancelItem(batchItemOwner(cid).id,cid);return pipeline().status(cid);}return cancelAuthorizedDigest(cid);});
    handle('digest-retry',contentId=>{const cid=id(contentId);if(batchCoordinator){batchCoordinator.retry(batchItemOwner(cid).id,cid);return pipeline().status(cid);}return retryAuthorizedDigest(cid);});
    handle('digest-remove', contentId => {const cid=id(contentId);generationRunner?.cancel(cid);asrRunner?.cancel(cid);const value=pipeline().removeLibrary(cid);ocrRunner?.cancel(cid);return value;});
    handle('digest-add-manual', contentId => pipeline().addManual(id(contentId)));
    handle('digest-review', contentId => pipeline().review(id(contentId), Date.now()));
    handle('digest-artifact', contentId => pipeline().artifact(id(contentId)));
    const generation=()=>{if(!e3Mode||!generationRepository)throw Error('阅读创作只在明确 E3 隔离副本启用');return generationRepository;};
    handle('generation-configure',async()=>{generation();if(!generationCredentials)throw Error('官方 DeepSeek 生成配置尚未启用');const value=await generationCredentials.configure();pipeline().setGenerationCapability(value.configured,value.configured?'官方 DeepSeek 生成已配置，仅处理明确的新请求':'生成等待官方 DeepSeek 安全配置');generationRunner?.kick();return value;});
    handle('generation-set-credential',key=>{generation();if(!generationCredentials)throw Error('官方 DeepSeek 生成配置尚未启用');const value=generationCredentials.store(key);pipeline().setGenerationCapability(value.configured,value.configured?'官方 DeepSeek 生成已配置，仅处理明确的新请求':'生成等待官方 DeepSeek 安全配置');generationRunner?.kick();return value;});
    handle('generation-status',contentId=>generation().status(id(contentId)));
    handle('generation-touch',(contentId,sessionId,dirty)=>generation().touch(id(contentId),sessionId,dirty===undefined?true:boolean(dirty)));
    handle('generation-release',(contentId,sessionId)=>generation().release(id(contentId),sessionId));
    handle('generation-retry',(contentId,acknowledgeUnknown)=>{if(batchCoordinator){const cid=id(contentId);batchCoordinator.retry(batchItemOwner(cid).id,cid);return generation().status(cid);}const value=generation().retry(id(contentId),acknowledgeUnknown===undefined?false:boolean(acknowledgeUnknown));generationRunner?.kick();return value;});
    handle('generation-candidate',contentId=>generation().candidate(id(contentId)));
    handle('generation-artifact',contentId=>generation().artifact(id(contentId)));
    handle('generation-adopt',(contentId,candidateId,expected)=>generation().adopt(id(contentId),candidateId,expected));
    handle('generation-undo-adoption',(contentId,expected)=>generation().undoAdoption(id(contentId),expected));
    handle('generation-refresh-markdown',contentId=>generation().refreshMarkdown(id(contentId)));
    handle('generation-install-response',(nonce,allowed)=>{const guard=installGuards.get(nonce);if(!guard||typeof allowed!=='boolean')throw Error('生成保存屏障已失效');guard.resolve(allowed);});
    protocol.handle('rlw-generation',request=>{
      if(quitting||!generationRepository)return new Response(null,{status:503});
      if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
      try{const url=new URL(request.url),parts=url.pathname.split('/').slice(1).map(decodeURIComponent);if(url.hostname!=='local'||parts.length!==4||!/^\d+$/.test(parts[0])||parts.some(p=>!p||/[\\/]/.test(p)))throw Error();const value=generationRepository.readAttachment(id(Number(parts[0])),parts[1],parts.slice(2).join('/'));return new Response(request.method==='HEAD'?null:new Uint8Array(value.bytes),{headers:{'Content-Type':value.mime,'Content-Length':String(value.bytes.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{return new Response('生成附件缺失或与确切版本不符',{status:404});}
    });
    const ocr=()=>{if(!ocrRepository)throw new Error('本地图片文字尚未启用；已保存的手工稿保持');return ocrRepository;};
    handle('ocr-list',contentId=>ocr().list(id(contentId)));
    handle('ocr-read',(contentId,resultId,revision)=>ocr().read(id(contentId),resultId,revision));
    handle('ocr-save',request=>ocr().saveCorrection(request));
    handle('ocr-adopt',(contentId,resultId,version)=>ocr().adopt(id(contentId),resultId,version));
    handle('ocr-retry',(contentId,mediaId)=>{if(batchCoordinator){const cid=id(contentId);batchCoordinator.retry(batchItemOwner(cid).id,cid);return ocr().list(cid);}const value=ocr().retry(id(contentId),mediaId===undefined?undefined:id(mediaId));ocrRunner?.kick();return value;});
    handle('ocr-export',async(contentId,selection)=>{
      const repository=ocr(),cid=id(contentId);
      if(!Array.isArray(selection)||!selection.length||selection.length>1000)throw new Error('请选择已保存的图片文字版本');
      // Freeze the complete exact selection before the user opens an external save panel.
      for(const item of selection)repository.read(cid,item.resultId,item.version?.kind==='correction'?item.version.revision:undefined);
      const chosen=await dialog.showSaveDialog(win!,{title:'导出图片文字资料',buttonLabel:'导出',message:'仅导出所选已保存的原始识别／校对版本及原图；不是自动成稿。音视频不包含。',defaultPath:path.join(e1Paths?.exportsDir||app.getPath('documents'),'图片文字资料.md'),filters:[{name:'Markdown',extensions:['md']}],properties:['createDirectory','dontAddToRecent']});
      if(chosen.canceled||!chosen.filePath)return{status:'cancelled'};
      return exportOcrMarkdown(repository,cid,selection,chosen.filePath);
    });
    const asr=()=>{if(!(e2Mode||e3Mode)||!asrRepository)throw Error('真实转录只在明确隔离副本启用');return asrRepository;};
    handle('asr-list',contentId=>asr().list(id(contentId)));
    handle('asr-read',(contentId,resultId,revision)=>asr().read(id(contentId),resultId,revision));
    handle('asr-save',request=>asr().saveCorrection(request));
    handle('asr-adopt',(contentId,resultId,version)=>asr().adopt(id(contentId),resultId,version));
    handle('asr-retry',(contentId,mediaId,acknowledgeUnknown)=>{if(batchCoordinator){const cid=id(contentId);batchCoordinator.retry(batchItemOwner(cid).id,cid);return asr().list(cid);}const value=asr().retry(id(contentId),mediaId===undefined?undefined:id(mediaId),acknowledgeUnknown===undefined?false:boolean(acknowledgeUnknown));asrRunner?.kick();return value;});
    handle('asr-configure',async()=>{asr();const value=await asrCredentials!.configure();pipeline().setASRCapability(value.configured,value.configured?'SiliconFlow 音视频转录已配置，等待明确请求':'音视频转录等待 SiliconFlow 安全配置');asrRunner?.kick();return value;});
    handle('asr-set-credential',key=>{asr();const value=asrCredentials!.store(key);pipeline().setASRCapability(value.configured,value.configured?'SiliconFlow 音视频转录已配置，等待明确请求':'音视频转录等待 SiliconFlow 安全配置');asrRunner?.kick();return value;});
    handle('asr-network',allowed=>{asr();return setProcessingAllowed(boolean(allowed));});
    handle('asr-export',async(contentId,selection)=>{
      const repository=asr(),cid=id(contentId);
      if(!Array.isArray(selection)||!selection.length||selection.length>1000)throw Error('请选择已保存的转录版本');
      for(const item of selection)repository.read(cid,item.resultId,item.version?.revision);
      const chosen=await dialog.showSaveDialog(win!,{title:'导出转录来源 Markdown',buttonLabel:'导出',message:'导出所选确切原稿／校对版本、分P与覆盖说明；不是E3完整清洗成稿。原音视频不复制。',defaultPath:path.join(e1Paths!.exportsDir,'音视频转录.md'),filters:[{name:'Markdown',extensions:['md']}],properties:['createDirectory','dontAddToRecent']});
      if(chosen.canceled||!chosen.filePath)return{status:'cancelled'};
      return exportAsrMarkdown(repository,cid,selection,chosen.filePath);
    });
    protocol.handle('rlw-asr',async request=>{
      if(quitting||!asrRepository)return new Response(null,{status:503});
      try{const url=new URL(request.url),parts=url.pathname.split('/').slice(1).map(decodeURIComponent);if(url.hostname!=='local'||parts.length!==2||!/^\d+$/.test(parts[0])||!/^asr-result-[-a-zA-Z0-9]+$/.test(parts[1]))throw Error();return await asrMediaResponse(request,asrRepository,id(Number(parts[0])),parts[1]);}catch{return new Response('固定转录原件不存在或身份不符',{status:404});}
    });
    protocol.handle('rlw-ocr',request=>{
      if(quitting||!ocrRepository)return new Response(null,{status:503});
      if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
      try{const url=new URL(request.url),parts=url.pathname.split('/').slice(1).map(decodeURIComponent);
        if(url.hostname!=='local'||parts.length!==2||!/^\d+$/.test(parts[0])||!/^ocr-result-[-a-zA-Z0-9]+$/.test(parts[1]))throw new Error();
        const value=ocrRepository.image(id(Number(parts[0])),parts[1]);
        return new Response(request.method==='HEAD'?null:new Uint8Array(value.bytes),{headers:{'Content-Type':value.mime,'Content-Length':String(value.bytes.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }catch{return new Response('固定原图缺失、损坏或不属于此收藏',{status:404});}
    });

    protocol.handle('rlw-digest', request => {
      if (quitting || !editorEnabled) return new Response(null, { status: 503 });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      try {
        const url = new URL(request.url), parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
        if (url.hostname !== 'local' || parts.length !== 3 || !/^\d+$/.test(parts[0]) || parts.slice(1).some(p => !p || /[\\/]/.test(p))) return new Response(null, { status: 404 });
        const resource = pipeline().artifactResource(id(Number(parts[0])), parts.slice(1).join('/'));
        if (!resource) return new Response(null, { status: 404 });
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(resource.bytes), { headers: { 'Content-Type': resource.mime, 'Content-Length': String(resource.bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response('成稿附件缺失或版本不符', { status: 404 }); }
    });
    handle('review', contentId => service!.review(id(contentId)));
    handle('retry', (contentId, mediaId) => { requireCollection(); return service!.retry(id(contentId), mediaId === undefined ? undefined : id(mediaId)); });
    handle('retryFailures', () => { requireCollection(); return service!.retryFailures(); });
    handle('autoSync', value => { requireCollection(); return service!.autoSync(boolean(value)); });
    handle('setSyncRange', value => { requireCollection(); return service!.setSyncRange(value as SyncRange); });
    handle('close-response', (nonce, allow) => {
      if (nonce !== closeRequest || typeof allow !== 'boolean') throw new Error('离开确认已失效');
      closeRequest = undefined;
      evidence(allow ? 'close-barrier-approved' : 'close-barrier-cancelled');
      if (allow) { closeApproved = true; app.quit(); }
    });
    const editor = (): EditorRepository => {
      if (!editorEnabled || !service?.store.editor) throw new Error('整理功能尚未启用，请先完成明确的备份与升级安排');
      return service.store.editor;
    };
    protocol.handle('rlw-editor', async request => {
      if (quitting || !editorEnabled) return new Response(null, { status: 503 });
      try {
        const url = new URL(request.url), parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
        if (url.hostname !== 'local' || parts.length !== 3 || parts.some(p => !p || p.length > 200 || /[\\/]/.test(p))) return new Response(null, { status: 404 });
        const repository = editor();
        const asset = repository.asset(parts[0], { assetId: parts[1], version: parts[2] });
        if (url.searchParams.get('thumbnail') === '1') {
          if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
          if (!asset) return new Response(null, { status: 404 });
          const original = readFixedAsset(repository.assetsDir, asset); // Do not let cache conceal missing originals.
          const key = `${parts[0]}:${asset.id}:${asset.version}:256-v1`;
          let bytes = thumbnails.get(key);
          if (!bytes) {
            bytes = await editorThumbnail(boundedFile(repository.assetsDir, asset.relativePath), original);
            if (thumbnails.size >= 64) thumbnails.delete(thumbnails.keys().next().value!);
            thumbnails.set(key, bytes);
          }
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        return fixedAssetResponse(request, repository.assetsDir, asset);
      } catch { return new Response('本地资源不存在或不属于此工作区', { status: 404 }); }
    });
    handle('editor-open', (contentId, initialization) => editor().open(id(contentId), initialization));
    handle('editor-load', workspaceId => editor().load(workspaceId));
    const updateMarkdown=(workspaceId:string)=>{if(!generationRepository)return;try{generationRepository.refreshMarkdown(editor().load(workspaceId).contentId);}catch{evidence('markdown-projection-pending');}};
    handle('editor-save', requests => {const value=editor().save(requests);for(const workspaceId of new Set((Array.isArray(requests)?requests:[requests]).map((request:any)=>request?.workspaceId).filter(Boolean)))updateMarkdown(String(workspaceId));return value;});
    handle('editor-title', (workspaceId, title) => {const value=editor().title(workspaceId, title);updateMarkdown(workspaceId);return value;});
    handle('editor-resolve', (workspaceId, reference) => editor().resolve(workspaceId, reference));
    handle('editor-history', workspaceId => editor().history(workspaceId));
    handle('editor-restore', (workspaceId, kind, revision, expectedRevision, sessionId, requestId) => {const value=editor().restore(workspaceId, kind, revision, expectedRevision, sessionId, requestId);updateMarkdown(workspaceId);return value;});
    handle('editor-images', workspaceId => editor().images(workspaceId));
    handle('editor-select-image', async (workspaceId, mediaId) => {
      const repository = editor(), record = repository.load(workspaceId);
      const content = service!.store.content(record.contentId);
      const media = content?.media.find(m => m.id === id(mediaId) && m.kind === 'image' && m.state === 'succeeded');
      if (!media?.localPath) throw new Error('图片不属于此收藏或尚未保存');
      const file = boundedFile(service!.store.mediaDir, media.localPath);
      await editorThumbnail(file, readFileSync(file));
      return repository.selectImage(workspaceId, media.id);
    });
    handle('editor-preview', (workspaceId, revision, configKey = PREVIEW_CONFIG) => savedPreview(editor(), workspaceId, revision, configKey));
    handle('editor-previews', () => {
      const repository = editor();
      return repository.list().map(record => ({
        ...savedPreview(repository, record.bundle.workspace.id, record.bundle.map.revision),
        contentId: record.contentId, userTitle: record.bundle.workspace.userTitle, updatedAt: record.updatedAt, nodeCount: Object.keys(record.bundle.map.nodes).length,
      }));
    });
    const exportControllers=new Map<string,AbortController>(),exportedPaths=new Set<string>();
    const exportIdentity=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw Error('导出操作无效');return value;};
    handle('editor-export-media-preview',workspaceId=>previewExportMedia(editor(),workspaceId));
    handle('editor-export-cancel',operationId=>{exportControllers.get(exportIdentity(operationId))?.abort();});
    handle('editor-export-reveal',exportPath=>{if(typeof exportPath!=='string'||!exportedPaths.has(exportPath))throw Error('只能查看本次应用成功导出的文件');shell.showItemInFolder(exportPath);});
    handle('editor-export', async (workspaceId, kind: EditorExportKind, expected, options:EditorExportOptions={}) => {
      const repository = editor(), record = repository.load(workspaceId);
      if (!['draft', 'map', 'both'].includes(kind)) throw new Error('请选择导出内容');
      if (!expected || !Number.isSafeInteger(expected.draftRevision) || !Number.isSafeInteger(expected.mapRevision)) throw new Error('导出版本无效');
      if(typeof options!=='object'||options===null||Object.keys(options).some(key=>!['includeLocalMedia','operationId'].includes(key))||options.includeLocalMedia!==undefined&&typeof options.includeLocalMedia!=='boolean')throw Error('导出选项无效');
      const operationId=exportIdentity(options.operationId??randomUUID());if(exportControllers.has(operationId))throw Error('该导出正在进行');
      const controller=new AbortController();exportControllers.set(operationId,controller);
      try{
      const selected = await dialog.showSaveDialog(win!, { title: '导出 Markdown', buttonLabel: '导出', message: options.includeLocalMedia?'将当前已保存正文、必要图片和所列本地音视频导出为新目录包。缺失资源将停止导出；同名目标会安全另存。':'仅导出所选已保存版本。有图片时创建新目录包及 assets；音视频文件未包含。同名目标会安全另存。', defaultPath: path.join(e1Paths?.exportsDir || app.getPath('documents'), exportFilename(record.bundle.workspace.userTitle) + '.md'), filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['createDirectory', 'dontAddToRecent'] });
      if (selected.canceled || !selected.filePath) return { status: 'cancelled' };
      if(controller.signal.aborted)return{status:'cancelled'};
      const result=await exportMarkdownPackage(repository,workspaceId,kind,expected,selected.filePath,{...options,operationId,signal:controller.signal,onProgress:progress=>{if(win&&!win.isDestroyed())win.webContents.send('rlw:editor-export-progress',progress);}});
      if(result.status==='exported'&&result.path)exportedPaths.add(result.path);return result;
      }finally{exportControllers.delete(operationId);}
    });
    handle('editor-export-xmind',async(workspaceId,expected)=>{
      if(!e3Mode)throw Error('可编辑导图导出仅在 E3 隔离副本启用');
      const repository=editor(),record=repository.load(workspaceId);
      if(!expected||record.bundle.draft.revision!==expected.draftRevision||record.bundle.map.revision!==expected.mapRevision)throw Error('当前稿件版本已变化，请先保存后导出');
      const selected=await dialog.showSaveDialog(win!,{title:'导出可编辑思维导图',buttonLabel:'导出',message:'导出当前保存版本的基础 XMind 文件。同名目标另存；官方客户端兼容范围以验收报告为准。',defaultPath:path.join(e1Paths!.exportsDir,exportFilename(record.bundle.workspace.userTitle)+'.xmind'),filters:[{name:'XMind',extensions:['xmind']}],properties:['createDirectory','dontAddToRecent']});
      if(selected.canceled||!selected.filePath)return{status:'cancelled'};
      const result=await exportEditorXmind(repository,workspaceId,expected,selected.filePath);if(result.status==='exported'&&result.path)exportedPaths.add(result.path);return result;
    });
    const renderKnowledgeCard=async(card:ReturnType<typeof validateKnowledgeCardPayload>):Promise<Buffer>=>{
      const cardWin=new BrowserWindow({show:false,width:1080,height:1440,useContentSize:true,backgroundColor:'#ffffff',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,zoomFactor:1}});
      try{
        await cardWin.loadFile(uiFile,{hash:'knowledge-card'});
        cardWin.webContents.setZoomFactor(1);
        await cardWin.webContents.executeJavaScript(`window.__knowledgeCard=JSON.parse(${JSON.stringify(JSON.stringify(card))});window.dispatchEvent(new Event('knowledge-card-data'));void 0`);
        await cardWin.webContents.executeJavaScript("document.fonts.ready.then(()=>Promise.all(Array.from(document.images).map(img=>img.complete?Promise.resolve():img.decode().catch(()=>{}))).then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))))");
        const image=await cardWin.webContents.capturePage();
        const size=image.getSize();
        if(size.width!==1080||size.height!==1440)throw new Error(`知识卡片尺寸异常：${size.width}×${size.height}`);
        const factors=image.getScaleFactors();
        return factors.length===1&&factors[0]===1?image.toPNG():image.resize({width:1080,height:1440}).toPNG();
      }finally{cardWin.destroy();}
    };
    handle('editor-knowledge-card',async(payload:unknown,target:unknown)=>{
      const card=validateKnowledgeCardPayload(payload);
      if(target!=='save'&&target!=='copy')throw new Error('知识卡片操作无效');
      const png=await renderKnowledgeCard(card);
      if(target==='copy'){await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(png)],{type:'image/png'})})]);return{status:'copied'};}
      const exportsDir=batchPaths?.exportsDir??e1Paths?.exportsDir??app.getPath('documents');
      const selected=await dialog.showSaveDialog(win!,{title:'导出知识卡片',buttonLabel:'导出',message:'将当前编辑的知识卡片导出为 PNG 图片。同名目标会安全另存。',defaultPath:path.join(exportsDir,`知识卡片-${card.number}.png`),filters:[{name:'PNG',extensions:['png']}],properties:['createDirectory','dontAddToRecent']});
      if(selected.canceled||!selected.filePath)return{status:'cancelled'};
      writeFileSync(selected.filePath,png);exportedPaths.add(selected.filePath);return{status:'exported',path:selected.filePath};
    });
    handle('original', async contentId => {
      const content = service!.store.content(id(contentId));
      if (!content) throw new Error('内容不存在');
      const url = new URL(content.url);
      if (!allowedPlatformUrl(content.platform,url.href)) throw new Error('来源链接无效');
      if (blocked) throw new Error('当前为阻网验收副本，原链接仅作来源说明');
      await shell.openExternal(url.href);
    });
    const windowTitle=batchMode?'收藏阅读工作台 · 批量同步与消化':e3RealMode&&path.basename(e1Paths!.root).startsWith('e41-')?'收藏阅读工作台 · E4.1导出验收副本':e3RealMode?'收藏阅读工作台 · E3真实成稿验收副本':e3FixMode?'收藏阅读工作台 · E3补修隔离副本':e3Mode?'收藏阅读工作台 · E3阅读创作隔离副本':e2Mode?'收藏阅读工作台 · E2转录隔离副本':'收藏阅读工作台';
    win = new BrowserWindow({ width: 1380, height: 940, minWidth: 720, minHeight: 600, title: windowTitle, backgroundColor: '#f5f4ef', show: false,
      webPreferences: { preload: path.join(projectRoot, 'main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, additionalArguments: [...(batchMode?['--rlw-batch-enabled']:[]),...(e3Mode?['--rlw-generation-enabled']:[]),...(e2Mode||e3Mode?['--rlw-asr-enabled']:[]),...(editorEnabled?['--rlw-editor-enabled']:[]),...(ocrEnabled?['--rlw-ocr-enabled']:[])] } });
    win.on('close', event => { if (!closeApproved) { event.preventDefault(); requestShutdown(); } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if(e2Mode||e3Mode)win.on('page-title-updated',event=>{event.preventDefault();win?.setTitle(windowTitle);});
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.once('ready-to-show', () => { if (!quitting && win && !win.isDestroyed()) win.show(); });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('[renderer]', message); });
    await win.loadFile(uiFile, { query: { ...(process.env.RLW_VIEW ? { view: process.env.RLW_VIEW } : {}), ...(process.env.RLW_OPEN_CONTENT ? { content: process.env.RLW_OPEN_CONTENT } : {}) } });
    powerMonitor.on('suspend', () => service?.pause());
    powerMonitor.on('resume', () => service?.resume());
    networkTimer = setInterval(() => { service?.setOnline(!blocked && net.isOnline()); if(e2Mode||e3Mode)asrRunner?.setNetworkAllowed(asrNetworkAllowed&&net.isOnline());generationRunner?.setNetworkAllowed(generationNetworkAllowed&&net.isOnline()); refreshLoginVerification(); }, 5000);
    networkTimer.unref();
    console.log(JSON.stringify({ event: 'ready', userData, dataDir, mode: batchMode ? 'batch-e42-copy' : e3RealMode ? 'e3-real-acceptance-copy' : e3Mode ? 'e3-isolated-creation-copy' : e2Mode ? 'e2-isolated-asr-copy' : e112Mode ? 'e112-offline-ocr-copy' : e111Mode ? 'e111-offline-ocr-copy' : e11Mode ? 'e11-offline-ocr-copy' : e1Mode ? 'e1-offline-copy' : process.env.RLW_SOURCE_MODE || 'electron', networkBlocked: blocked }));
    if (!e1Mode && (process.env.RLW_LOGIN === 'xiaohongshu' || process.env.RLW_LOGIN === 'bilibili')) await sources!.login(process.env.RLW_LOGIN);
    if (process.env.RLW_CAPTURE) {
      setTimeout(() => { void (async () => {
        if (process.env.RLW_CAPTURE_SECTION === 'tasks') await win!.webContents.executeJavaScript("document.querySelector('.task-progress')?.scrollIntoView({block:'start'})");
        const screenshot = await win!.webContents.capturePage();
        mkdirSync(path.dirname(process.env.RLW_CAPTURE!), { recursive: true });
        writeFileSync(process.env.RLW_CAPTURE!, screenshot.toPNG());
        console.log('Screenshot saved');
        if (process.env.RLW_EXIT_AFTER_CAPTURE === '1') app.quit();
      })(); }, Math.min(60000, Math.max(1000, Number(process.env.RLW_CAPTURE_DELAY_MS) || 3000)));
    }
    const exportBatchCompleted = async (value:unknown) => {
      if(!batchPaths||!batchCoordinator)throw Error('仅本轮导出');
      const cid=id(value),item=batchCoordinator.list().flatMap(b=>b.items).find(i=>i.contentId===cid);
      if(!item||item.state!=='complete')throw Error('仅导出本轮已完成成果');
      const repository=editor(),owner=repository.db.prepare('SELECT id FROM editor_workspaces WHERE content_id=?').get(cid) as {id:string}|undefined;
      if(!owner)throw Error('已完成工作区不存在');
      const record=repository.load(owner.id),expected={draftRevision:record.bundle.draft.revision,mapRevision:record.bundle.map.revision};
      const stem=`e42-${cid}-${randomUUID()}`;
      const markdown=await exportMarkdownPackage(repository,owner.id,'both',expected,path.join(batchPaths.exportsDir,stem+'.md'),{includeLocalMedia:true,operationId:randomUUID()});
      const xmind=await exportEditorXmind(repository,owner.id,expected,path.join(batchPaths.exportsDir,stem+'.xmind'));
      return{contentId:cid,workspaceId:owner.id,expected,markdown,xmind};
    };
    if(batchMode&&batchPaths&&process.env.RLW_BATCH_CONTROL==='1'){const harness=await import(pathToFileURL(path.join(projectRoot,'qa/batch-live-control.cjs')).href);await harness.default({app,win,service,batch:batchCoordinator,paths:batchPaths,setProcessingAllowed,validateBatchSelection,exportCompleted:exportBatchCompleted,sourceDiagnostics:async()=>{const result=[];for(const [platform,value] of sourceSessions){const names: string[]=({bilibili:['SESSDATA','bili_jct','DedeUserID'],xiaohongshu:['web_session','a1'],weibo:['SUB'],zhihu:['z_c0'],twitter:['auth_token','twid']})[platform];const cookies=await value.cookies.get({});result.push({platform,storagePath:value.storagePath,cookieCount:cookies.length,auth:names.map(name=>({name,present:cookies.some(cookie=>cookie.name===name),unexpired:cookies.some(cookie=>cookie.name===name&&(!cookie.expirationDate||cookie.expirationDate>Date.now()/1000))}))});}return result;},credentials:()=>({asr:asrCredentials?.status().configured??false,generation:generationCredentials?.status().configured??false})});}
    if(e3RealMode&&e1Paths&&process.env.RLW_E3_REAL_QA){const mode=process.env.RLW_E3_REAL_QA;const harness=await import(pathToFileURL(path.resolve(process.cwd(),e3RealQaScript(mode))).href);await harness.default({app,win,service,repository:editor(),ocr:ocrRepository,ocrRunner,asr:asrRepository,asrRunner,generation:generationRepository,generationRunner,paths:e1Paths,dialog,mode});}
    else if(e3FixMode&&e1Paths&&process.env.RLW_E3_FIX_QA){const harness=await import(pathToFileURL(path.resolve(process.cwd(),'scripts/editor-e3-pm-fix-ui.cjs')).href);await harness.default({app,win,service,repository:editor(),ocr:ocrRepository,ocrRunner,asr:asrRepository,asrRunner,generation:generationRepository,generationRunner,paths:e1Paths,dialog,mode:process.env.RLW_E3_FIX_QA});}
    else if(!batchMode&&!e3RealMode&&!e3FixMode&&e3Mode&&e1Paths&&process.env.RLW_E3_QA){const harness=await import(pathToFileURL(path.resolve(process.cwd(),'scripts/editor-e3-ui.cjs')).href);await harness.default({app,win,service,repository:editor(),ocr:ocrRepository,ocrRunner,asr:asrRepository,asrRunner,generation:generationRepository,generationRunner,credentials:asrCredentials,paths:e1Paths,dialog,mode:process.env.RLW_E3_QA});}
    else if(e2Mode&&e1Paths&&process.env.RLW_E2_FIX_QA){const harness=await import(pathToFileURL(path.resolve(process.cwd(),'scripts/editor-e2-fix-ui.cjs')).href);await harness.default({app,win,service,repository:editor(),ocr:ocrRepository,ocrRunner,asr:asrRepository,asrRunner,credentials:asrCredentials,paths:e1Paths,dialog,mode:process.env.RLW_E2_FIX_QA});}
    else if(e2Mode&&e1Paths&&process.env.RLW_E2_QA){const harness=await import(pathToFileURL(path.resolve(process.cwd(),'scripts/editor-e2-ui-acceptance.cjs')).href);await harness.default({app,win,service,repository:editor(),ocr:ocrRepository,ocrRunner,asr:asrRepository,asrRunner,credentials:asrCredentials,paths:e1Paths,dialog,mode:process.env.RLW_E2_QA});}
    if(!e3Mode&&!e2Mode&&e11Mode&&e1Paths&&(e112Mode?process.env.RLW_E112_QA:e111Mode?process.env.RLW_E111_QA:process.env.RLW_E11_QA)){
      const harness=await import(pathToFileURL(path.resolve(process.cwd(),e112Mode?'scripts/editor-e112-ui-acceptance.cjs':e111Mode?'scripts/editor-e111-ui-acceptance.cjs':'scripts/editor-e11-ui-acceptance.cjs')).href);
      await harness.default({app,win,service,repository:editor(),ocr:ocrRepository,runner:ocrRunner,paths:e1Paths,dialog,mode:e112Mode?process.env.RLW_E112_QA:e111Mode?process.env.RLW_E111_QA:process.env.RLW_E11_QA});
    }
    if (!e11Mode && e1Paths && process.env.RLW_E1_QA) {
      const harness = await import(pathToFileURL(path.resolve(projectRoot, '..', 'scripts/editor-e1-ui-acceptance.cjs')).href);
      await harness.default({ app, win, service, repository: editor(), paths: e1Paths, dialog, mode: process.env.RLW_E1_QA });
    }
  }).catch(error => { releaseSourceLease?.(); console.error('启动失败', error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    if (!closeApproved && win && !win.isDestroyed()) { event.preventDefault(); requestShutdown(); return; }
    quitting = true;
    if (networkTimer) clearInterval(networkTimer);
    if (evidenceTimer) clearInterval(evidenceTimer);
    if (batchTimer) clearInterval(batchTimer);
    ocrRunner?.stop();
    asrRunner?.stop();
    generationRunner?.stop();
    for(const guard of installGuards.values())guard.resolve(false);
    asrCredentials?.dispose();
    generationCredentials?.dispose();
    evidence('shutdown');
    // Stop renderer polling before closing SQLite.
    if (win && !win.isDestroyed()) win.destroy();
    batchLogin?.dispose(); sources?.dispose(); service?.close(); releaseSourceLease?.();
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
}
