import { contextBridge, ipcRenderer } from 'electron';
import type { WorkbenchAPI, Platform } from '../shared/contracts.js';
import type { EditorAPI } from '../shared/editor-contracts.js';
import type { OcrAPI } from '../shared/ocr-contracts.js';
import type { AsrAPI } from '../shared/asr-contracts.js';
import type { DigestAPI } from '../shared/digest-contracts.js';
import type { GenerationAPI } from '../shared/generation-contracts.js';
import type { BatchDigestAPI } from '../shared/batch-contracts.js';
const batch:BatchDigestAPI={create:ids=>ipcRenderer.invoke('rlw:batch-create',ids),list:()=>ipcRenderer.invoke('rlw:batch-list'),status:id=>ipcRenderer.invoke('rlw:batch-status',id),pause:id=>ipcRenderer.invoke('rlw:batch-pause',id),resume:id=>ipcRenderer.invoke('rlw:batch-resume',id),retry:(batchId,contentId)=>ipcRenderer.invoke('rlw:batch-retry',batchId,contentId),cancelItem:(batchId,contentId)=>ipcRenderer.invoke('rlw:batch-cancel',batchId,contentId)};
const digestPipeline: DigestAPI = {
  request: (contentId, renewScope) => ipcRenderer.invoke('rlw:digest-request', contentId, renewScope),
  status: contentId => ipcRenderer.invoke('rlw:digest-status', contentId),
  list: () => ipcRenderer.invoke('rlw:digest-list'),
  cancel: contentId => ipcRenderer.invoke('rlw:digest-cancel', contentId),
  retry: contentId => ipcRenderer.invoke('rlw:digest-retry', contentId),
  removeLibrary: contentId => ipcRenderer.invoke('rlw:digest-remove', contentId),
  addManual: contentId => ipcRenderer.invoke('rlw:digest-add-manual', contentId),
  review: contentId => ipcRenderer.invoke('rlw:digest-review', contentId),
  artifact: contentId => ipcRenderer.invoke('rlw:digest-artifact', contentId),
};
const editor: EditorAPI = {
  open: (contentId, initialization) => ipcRenderer.invoke('rlw:editor-open', contentId, initialization),
  load: workspaceId => ipcRenderer.invoke('rlw:editor-load', workspaceId),
  save: requests => ipcRenderer.invoke('rlw:editor-save', requests),
  title: (workspaceId, title) => ipcRenderer.invoke('rlw:editor-title', workspaceId, title),
  resolve: (workspaceId, ref) => ipcRenderer.invoke('rlw:editor-resolve', workspaceId, ref),
  history: workspaceId => ipcRenderer.invoke('rlw:editor-history', workspaceId),
  restore: (...args) => ipcRenderer.invoke('rlw:editor-restore', ...args),
  images: workspaceId => ipcRenderer.invoke('rlw:editor-images', workspaceId),
  selectImage: (workspaceId, mediaId) => ipcRenderer.invoke('rlw:editor-select-image', workspaceId, mediaId),
  assetUrl: (workspaceId, ref) => `rlw-editor://local/${encodeURIComponent(workspaceId)}/${encodeURIComponent(ref.assetId)}/${encodeURIComponent(ref.version)}`,
  preview: (...args) => ipcRenderer.invoke('rlw:editor-preview', ...args),
  previews: () => ipcRenderer.invoke('rlw:editor-previews'),
  previewExportMedia: workspaceId => ipcRenderer.invoke('rlw:editor-export-media-preview', workspaceId),
  cancelExport: operationId => ipcRenderer.invoke('rlw:editor-export-cancel', operationId),
  revealExport: path => ipcRenderer.invoke('rlw:editor-export-reveal', path),
  onExportProgress: listener => { const handler=(_event:unknown,progress:Parameters<Parameters<NonNullable<EditorAPI['onExportProgress']>>[0]>[0])=>listener(progress); ipcRenderer.on('rlw:editor-export-progress',handler);return()=>{ipcRenderer.removeListener('rlw:editor-export-progress',handler);}; },
  export: (...args) => ipcRenderer.invoke('rlw:editor-export', ...args),
  knowledgeCardPng: (payload, target) => ipcRenderer.invoke('rlw:editor-knowledge-card', payload, target),
  ...(process.argv.includes('--rlw-generation-enabled')?{exportXmind:(...args:Parameters<NonNullable<EditorAPI['exportXmind']>>)=>ipcRenderer.invoke('rlw:editor-export-xmind',...args)}:{}),
};
let installHandler:((contentId:number,requestId:string)=>Promise<boolean>)|undefined;
ipcRenderer.on('rlw:generation-before-install',(_event,request:{nonce:string;contentId:number;requestId:string})=>{
  void(async()=>{let allowed=false;try{allowed=installHandler?await installHandler(request.contentId,request.requestId):true;}catch{/* An unresponsive editor protects the current version. */}await ipcRenderer.invoke('rlw:generation-install-response',request.nonce,allowed).catch(()=>{});})();
});
const generation:GenerationAPI={
  configureCredentials:()=>ipcRenderer.invoke('rlw:generation-configure'),
  setCredential:(key:string)=>ipcRenderer.invoke('rlw:generation-set-credential',key),
  status:contentId=>ipcRenderer.invoke('rlw:generation-status',contentId),
  touch:(...args)=>ipcRenderer.invoke('rlw:generation-touch',...args),
  release:(...args)=>ipcRenderer.invoke('rlw:generation-release',...args),
  retry:(...args)=>ipcRenderer.invoke('rlw:generation-retry',...args),
  candidate:contentId=>ipcRenderer.invoke('rlw:generation-candidate',contentId),
  artifact:contentId=>ipcRenderer.invoke('rlw:generation-artifact',contentId),
  adopt:(...args)=>ipcRenderer.invoke('rlw:generation-adopt',...args),
  undoAdoption:(...args)=>ipcRenderer.invoke('rlw:generation-undo-adoption',...args),
  refreshMarkdown:contentId=>ipcRenderer.invoke('rlw:generation-refresh-markdown',contentId),
  assetUrl:(contentId,artifactId,relativePath)=>`rlw-generation://local/${encodeURIComponent(contentId)}/${encodeURIComponent(artifactId)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
  onBeforeInstall:handler=>{installHandler=handler;return()=>{if(installHandler===handler)installHandler=undefined;};},
};
const ocr:OcrAPI={
  list:contentId=>ipcRenderer.invoke('rlw:ocr-list',contentId),
  read:(...args)=>ipcRenderer.invoke('rlw:ocr-read',...args),
  saveCorrection:request=>ipcRenderer.invoke('rlw:ocr-save',request),
  adopt:(...args)=>ipcRenderer.invoke('rlw:ocr-adopt',...args),
  retry:(...args)=>ipcRenderer.invoke('rlw:ocr-retry',...args),
  export:(...args)=>ipcRenderer.invoke('rlw:ocr-export',...args),
  imageUrl:(contentId,resultId)=>`rlw-ocr://local/${encodeURIComponent(contentId)}/${encodeURIComponent(resultId)}`,
};
const asr:AsrAPI={
  list:contentId=>ipcRenderer.invoke('rlw:asr-list',contentId),
  read:(...args)=>ipcRenderer.invoke('rlw:asr-read',...args),
  saveCorrection:request=>ipcRenderer.invoke('rlw:asr-save',request),
  adopt:(...args)=>ipcRenderer.invoke('rlw:asr-adopt',...args),
  retry:(...args)=>ipcRenderer.invoke('rlw:asr-retry',...args),
  export:(...args)=>ipcRenderer.invoke('rlw:asr-export',...args),
  configureCredentials:()=>ipcRenderer.invoke('rlw:asr-configure'),
  setCredential:(key:string)=>ipcRenderer.invoke('rlw:asr-set-credential',key),
  setNetworkAllowed:allowed=>ipcRenderer.invoke('rlw:asr-network',allowed),
  mediaUrl:(contentId,resultId)=>`rlw-asr://local/${encodeURIComponent(contentId)}/${encodeURIComponent(resultId)}`,
};
let closeHandler: (() => Promise<boolean>) | undefined;
ipcRenderer.on('rlw:before-close', (_event, nonce: string) => {
  void (async () => {
    let allow = false;
    try { allow = closeHandler ? await closeHandler() : true; } catch { /* Keep the window and unsaved session alive. */ }
    await ipcRenderer.invoke('rlw:close-response', nonce, allow);
  })();
});
const credentialModal = {
  set: (provider: 'siliconflow' | 'deepseek', value: string) => ipcRenderer.invoke('rlw:credentials-set', provider, value),
  cancel: (provider: 'siliconflow' | 'deepseek') => ipcRenderer.invoke('rlw:credentials-cancel', provider),
  onOpen(handler: (request: { provider: 'siliconflow' | 'deepseek'; label: string; purpose: string }) => void) {
    const listener = (_event: unknown, request: { provider: 'siliconflow' | 'deepseek'; label: string; purpose: string }) => handler(request);
    ipcRenderer.on('rlw:credential-open', listener);
    return () => { ipcRenderer.removeListener('rlw:credential-open', listener); };
  },
};
const api: WorkbenchAPI = {
  credentials: credentialModal,
  ...(process.argv.includes('--rlw-batch-enabled')?{batch,pauseDownloads:()=>ipcRenderer.invoke('rlw:downloads-pause'),resumeDownloads:()=>ipcRenderer.invoke('rlw:downloads-resume'),resumePlatform:(platform:Platform)=>ipcRenderer.invoke('rlw:downloads-resume-platform',platform)}:{}),
  ...(process.argv.includes('--rlw-editor-enabled') ? { editor, digestPipeline } : {}),
  ...(process.argv.includes('--rlw-ocr-enabled')?{ocr}:{}),
  ...(process.argv.includes('--rlw-asr-enabled')?{asr}:{}),
  ...(process.argv.includes('--rlw-generation-enabled')?{generation}:{}),
  onBeforeClose: handler => { closeHandler = handler; return () => { if (closeHandler === handler) closeHandler = undefined; }; },
  state: () => ipcRenderer.invoke('rlw:state'),
  sync: (platform?: Platform) => ipcRenderer.invoke('rlw:sync', platform),
  login: (platform) => ipcRenderer.invoke('rlw:login', platform),
  digest: (id, value) => ipcRenderer.invoke('rlw:digest', id, value),
  review: (id) => ipcRenderer.invoke('rlw:review', id),
  retry: (id, mediaId) => ipcRenderer.invoke('rlw:retry', id, mediaId),
  retryFailures: () => ipcRenderer.invoke('rlw:retryFailures'),
  autoSync: (value) => ipcRenderer.invoke('rlw:autoSync', value),
  setSyncRange: (value) => ipcRenderer.invoke('rlw:setSyncRange', value),
  openOriginal: (id) => ipcRenderer.invoke('rlw:original', id),
  mediaUrl: (id) => `rlw-media://local/${id}`,
  deletePreview: (ids) => ipcRenderer.invoke('rlw:delete-preview', ids),
  deleteContents: (ids) => ipcRenderer.invoke('rlw:delete-contents', ids),
  deletedContents: () => ipcRenderer.invoke('rlw:deleted-contents'),
  restoreDeleted: (id) => ipcRenderer.invoke('rlw:restore-deleted', id),
};
contextBridge.exposeInMainWorld('workbench', api);
