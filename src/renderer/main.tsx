import { PLATFORMS, PLATFORM_NAMES } from '../shared/platforms';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContentRecord, MediaRecord, Platform, WorkbenchAPI, WorkbenchState } from '../shared/contracts';
import { contentSaveState, currentMedia, hasSaveFailure, mediaLabel, restoreReaderFocus, safeError } from './content-state';
import { EditorWorkspace } from './editor-workspace';
import { CreationWorkspace } from './creation-workspace';
import type { EditorPreview } from '../shared/editor-contracts';
import { activeDigestRequest } from '../shared/digest-contracts';
import { DigestProgress } from './digest-panel';
import { cardAction, cardActionLabel, cardChip, cardChipLabel, digestStateLabel, kindShortName, platformShortName, precheckMissing, precheckNeedsAsr, selectionStats, syncChipText, syncRunLine, syncRunSummary, type PrecheckMissing } from './ui-terms';
import { PrecheckDialog } from './precheck';
import { OcrResultsPanel, type OcrOpenTarget } from './ocr-panel';
import { OcrWorkspace, type OcrReferenceHandler } from './ocr-workspace';
import { AsrResultsPanel, type AsrOpenTarget } from './asr-panel';
import { AsrWorkspace, type AsrReferenceHandler } from './asr-workspace';
import { ProcessingSettings, ProcessingEndpoints } from './processing-settings';
import './styles.css';
import { BatchPanel, RecentSyncSummary, batchSelectionReason, createBatch } from './batch-panel';
import { TopProgress } from './top-progress';
import { DeleteConfirm, DeletedList, SyncRangeConfirm, type DeleteRequest } from './delete-dialog';
import { exportBytes } from './export-dialog-content';
import type { BatchDigestState } from '../shared/batch-contracts';
import { orderCollectionList } from './collection-order';
import { IconHome, IconLibrary, IconDigested, IconSettings, IconSync, IconTheme, IconClose, IconSearch, IconExternal, IconImage, IconVideo, IconAudio, IconText, IconArrowDownLeft, IconQueue, IconMore, IconExport } from './icons';
import { useDevInfo, writeDevInfo } from './dev-info';
import { AvatarImage, AvatarMascot } from './avatar';
import { KnowledgeCardRoute } from './knowledge-card-view';
import { DigestQueue, digestActiveCount, type QueueFix, type QueueRow } from './digest-queue';

declare global { interface Window { workbench: WorkbenchAPI } }
const api = window.workbench;
const platformName = (p: Platform) => PLATFORM_NAMES[p];
const kindName: Record<string, string> = { image: '图文', video: '视频', audio: '音频', text: '文字' };
const date = (t?: number | null) => t ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(t) : '未提供';
const title = (c: ContentRecord) => c.title || '无标题收藏';
const navs = [{ key: 'home', icon: IconHome, label: '首页' }, { key: 'library', icon: IconLibrary, label: '我的收藏夹' }, { key: 'digested', icon: IconDigested, label: '消化库' }, { key: 'settings', icon: IconSettings, label: '设置' }];

function App() {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') || 'home');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('all');
  const [status, setStatus] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [continueAll, setContinueAll] = useState(false);
  const [homeCols, setHomeCols] = useState(4);
  useEffect(() => { const el = listEntry.current; if (!el || view !== 'home') return; const measure = () => { const style = getComputedStyle(el); const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); setHomeCols(Math.max(1, Math.floor((width + 20) / 260))); }; measure(); const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect(); }, [view, state === null]);
  const [batchSelection,setBatchSelection]=useState<number[]>([]);
  const [selectMode,setSelectMode]=useState(false);
  const [syncOpen,setSyncOpen]=useState(false);
  const [queueOpen,setQueueOpen]=useState(false);
  const [batchList,setBatchList]=useState<BatchDigestState[]>([]);
  const digestOpen=digestActiveCount(state?.digestStates??[]);
  const digestTitles=useMemo(()=>new Map((state?.contents??[]).map(c=>[c.id,c.title])),[state?.contents]);
  const [precheck,setPrecheck]=useState<{needsAsr:boolean;start:()=>void}|null>(null);
  const [credentialFocus,setCredentialFocus]=useState<'asr'|'generation'|null>(null);
  const [syncNotice,setSyncNotice]=useState('');
  const [deleteRequest,setDeleteRequest]=useState<(DeleteRequest & { after?: () => void }) | null>(null);
  const [deletedListOpen,setDeletedListOpen]=useState(false);
  const [syncRangeConfirm,setSyncRangeConfirm]=useState(false);
  const [sort,setSort]=useState<'newest'|'oldest'>(() => localStorage.getItem('rlw-library-sort') === 'oldest' ? 'oldest' : 'newest');
  const [batchOwnedIds,setBatchOwnedIds]=useState<number[]|null>(null);
  const flash = useCallback((text: string) => { setSyncNotice(text); setTimeout(() => setSyncNotice(''), 5000); }, []);
  const receiveBatchItems=useCallback((ids:number[])=>setBatchOwnedIds(previous=>previous&&previous.length===ids.length&&previous.every((id,index)=>id===ids[index])?previous:ids),[]);
  useEffect(()=>{if(!api.batch||!state)return;setBatchSelection(previous=>{const eligible=previous.filter(id=>!!state.contents.find(item=>item.id===id)&&!(state.deletionBlocked??[]).some(row=>row.contentId===id));return eligible.length===previous.length?previous:eligible;});},[state,batchOwnedIds]);
  const [selectedId, setSelectedId] = useState<number | null>(Number(new URLSearchParams(location.search).get('content')) || null);
  const [theme, setTheme] = useState(localStorage.getItem('rlw-theme') || 'light');
  const devInfo = useDevInfo();
  const [mediaIndex, setMediaIndex] = useState(0);
  const [mediaErrors, setMediaErrors] = useState<Record<number, string>>({});
  const [mediaRefresh, setMediaRefresh] = useState<Record<number, number>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creationId, setCreationId] = useState<number | null>(null), [manualCreation, setManualCreation] = useState(false);
  const [previews, setPreviews] = useState<EditorPreview[]>([]);
  const [previewError, setPreviewError] = useState(false);
  const [digestProgressId, setDigestProgressId] = useState<number | null>(null);
  const [ocrTarget, setOcrTarget] = useState<OcrOpenTarget | null>(null);
  const [asrTarget,setAsrTarget]=useState<AsrOpenTarget|null>(null);
  const asrReturnProgress=useRef(false),asrReference=useRef<{contentId:number;handler:AsrReferenceHandler}|null>(null);
  const ocrReturnProgress = useRef(false), ocrReference = useRef<{ contentId: number; handler: OcrReferenceHandler } | null>(null);
  const leaveGuards = useRef(new Set<() => Promise<boolean>>());
  const returnPosition = useRef({ page: 0, main: 0 });
  const previewEpoch = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const focusIndex = useRef(0);
  const filtersEntry = useRef<HTMLButtonElement>(null);
  const listEntry = useRef<HTMLDivElement>(null);
  const refresh = async () => { try { setState(await api.state()); setLoadError(''); } catch { setLoadError('无法读取本地资料。请重启应用后重试。'); } };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer); }, []);
  useEffect(() => api.onBeforeClose?.(async () => {
    // A native modal occupies the top layer. Release it before presenting the
    // editor's retry/cancel barrier, then restore it if the user stays here.
    const progress = document.querySelector<HTMLDialogElement>('.digest-progress-dialog');
    const restoreProgress = !!progress?.open;
    const ocr = document.querySelector<HTMLDialogElement>('.e11-ocr-workspace'), restoreOcr = !!ocr?.open;
    const asr=document.querySelector<HTMLDialogElement>('.e2-asr-workspace'),restoreAsr=!!asr?.open;
    if (restoreProgress) progress?.close();
    const allow = await runLeaveGuards();
    if(!allow&&restoreAsr&&asr?.isConnected&&!asr.open)asr.showModal();
    if (!allow && restoreOcr && ocr?.isConnected && !ocr.open) ocr.showModal();
    if (!allow && restoreProgress && progress?.isConnected && !progress.open && !ocr?.open) progress.showModal();
    return allow;
  }), []);
  const registerLeaveGuard = useCallback((guard: () => Promise<boolean>) => {
    leaveGuards.current.add(guard);
    return () => { leaveGuards.current.delete(guard); };
  }, []);
  async function runLeaveGuards() { for (const guard of [...leaveGuards.current].reverse()) if (!await guard()) return false; return true; }
  const registerOcrReferenceHandler = useCallback((contentId: number, handler: OcrReferenceHandler) => { const value = { contentId, handler }; ocrReference.current = value; return () => { if (ocrReference.current === value) ocrReference.current = null; }; }, []);
  const registerAsrReferenceHandler=useCallback((contentId:number,handler:AsrReferenceHandler)=>{const value={contentId,handler};asrReference.current=value;return()=>{if(asrReference.current===value)asrReference.current=null;};},[]);
  const openAsr=(target:AsrOpenTarget)=>{asrReturnProgress.current=digestProgressId!==null;setDigestProgressId(null);setAsrTarget(target);};
  const openOcr = (target: OcrOpenTarget) => { ocrReturnProgress.current = digestProgressId !== null; setDigestProgressId(null); setOcrTarget(target); };
  const refreshPreviews = useCallback(async () => {
    if (!api.editor) return;
    const epoch = ++previewEpoch.current;
    try { const result = await api.editor.previews(); if (epoch === previewEpoch.current) { setPreviews(result); setPreviewError(false); } }
    catch { if (epoch === previewEpoch.current) setPreviewError(true); }
  }, []);
  useEffect(() => { if (view === 'digested' && api.editor) void refreshPreviews(); }, [view, refreshPreviews]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('rlw-theme', theme); }, [theme]);
  useEffect(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0); }, [view]);
  useEffect(() => { if (!api.batch) return; let alive = true; const load = async () => { try { const list = await api.batch!.list(); if (alive) { setBatchList(list); receiveBatchItems(list.flatMap(batch => batch.items.map(item => item.contentId))); } } catch {} }; void load(); const timer = setInterval(() => void load(), 4000); return () => { alive = false; clearInterval(timer); }; }, []);
  useEffect(() => { if (!selectMode) return; const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelectMode(false); setBatchSelection([]); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [selectMode]);
  const run = async (label: string, fn: () => Promise<void>) => { setError(''); setAction(label); try { await fn(); await refresh(); } catch (e) { setError(safeError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败，请重试')); } finally { setAction(''); } };
  const digestFor = (item: ContentRecord) => state?.digestStates?.find(s => s.contentId === item.id);
  const inLibrary = (item: ContentRecord) => state?.digestStates ? !!digestFor(item)?.library?.active : !!item.digestedAt;
  const openDelete = useCallback(async (ids: number[], after?: () => void) => {
    if (!api.deletePreview || !ids.length) return;
    try {
      const preview = await api.deletePreview(ids);
      const blockedIds = new Set(preview.blocked.map(row => row.id));
      const free = ids.filter(id => !blockedIds.has(id));
      const digested = free.filter(id => { const c = state?.contents.find(item => item.id === id); return !!c && (inLibrary(c) || c.digestedAt !== null); }).length;
      setDeleteRequest({ ids: free, bytes: preview.bytes, blocked: preview.blocked, digested, after });
    } catch (e) { flash(`删除前检查失败：${safeError(e instanceof Error ? e.message : String(e))}`); }
  }, [state]);
  const confirmDelete = useCallback(async () => {
    const request = deleteRequest; if (!request || !api.deleteContents) return;
    try {
      const result = await api.deleteContents(request.ids);
      setDeleteRequest(null);
      setBatchSelection(previous => previous.filter(id => !result.deleted.includes(id)));
      request.after?.();
      flash(`已删除 ${result.deleted.length} 条，释放约 ${exportBytes(result.bytesFreed)}`);
      void refresh();
    } catch (e) { flash(`删除未完成：${safeError(e instanceof Error ? e.message : String(e))}`); }
  }, [deleteRequest]);
  const restoreDeletedItem = useCallback(async (contentId: number) => {
    if (!api.restoreDeleted) return;
    try { await api.restoreDeleted(contentId); flash('已重新加入下载队列，正文与媒体将自动取回'); void refresh(); }
    catch (e) { flash(`重新导入失败：${safeError(e instanceof Error ? e.message : String(e))}`); }
  }, []);
  const processing = (item: ContentRecord) => { const s = digestFor(item); return !!s && activeDigestRequest(s); };
  const digestLabel = (item: ContentRecord) => digestStateLabel(digestFor(item), !!item.digestedAt);
  const open = (item: ContentRecord) => { focusOrigin.current = document.activeElement as HTMLElement; focusIndex.current = Array.from(document.querySelectorAll<HTMLButtonElement>('.content-card')).findIndex(c => c === focusOrigin.current); setMediaIndex(0); setSelectedId(item.id); if (inLibrary(item)) void run('', () => api.review(item.id)); };
  const close = () => { dialog.current?.close(); setSelectedId(null); requestAnimationFrame(() => restoreReaderFocus(focusOrigin.current, Array.from(document.querySelectorAll<HTMLButtonElement>('.content-card')).map(c => Number(c.dataset.contentId)), focusIndex.current, filtersEntry.current || listEntry.current)); };
  const trapReaderFocus = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], audio[controls], video[controls], [tabindex]:not([tabindex="-1"])') || []).filter(element => element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };
  useEffect(() => { if (selectedId !== null && dialog.current && !dialog.current.open) { dialog.current.showModal(); closeButton.current?.focus(); } }, [selectedId]);
  const selected = state?.contents.find(c => c.id === selectedId);
  const isBusy = !!action || !!state?.busy.length;
  const librarySource = (item: ContentRecord) => digestFor(item)?.library?.source ?? (digestFor(item)?.library?.legacy || item.digestedAt !== null ? 'legacy' : 'ai');
  const filtered = orderCollectionList(state?.contents.filter(c => (view !== 'digested' || inLibrary(c)) && (platform === 'all' || c.platform === platform) && (status === 'all' || (status === 'digested' ? inLibrary(c) : status === 'processing' ? processing(c) : !inLibrary(c))) && (view !== 'digested' || sourceFilter === 'all' || librarySource(c) === sourceFilter) && title(c).toLocaleLowerCase().includes(search.toLocaleLowerCase())) || [], view, platform, state?.recentSync, sort);
  const total = state?.contents.length || 0;
  const digested = state?.contents.filter(inLibrary).length || 0;
  const offline = state?.contents.filter(c => c.offline).length || 0;
  const failedSaves = state?.contents.filter(hasSaveFailure).length || 0;
  const resetFilters = () => { setSearch(''); setPlatform('all'); setStatus('all'); setSourceFilter('all'); };
  const localError = (media: MediaRecord, kind: 'image' | 'av') => setMediaErrors(previous => ({ ...previous, [media.id]: kind === 'image' ? '本地图片无法读取或解码，文件可能缺失或损坏。' : '本地音视频无法读取或解码，文件可能缺失、损坏或格式不支持。' }));
  const retry = (item: ContentRecord, media?: MediaRecord) => void run('重试中', async () => { await api.retry(item.id, media?.id); if (media) { setMediaErrors(previous => { const next = { ...previous }; delete next[media.id]; return next; }); setMediaRefresh(previous => ({ ...previous, [media.id]: (previous[media.id] || 0) + 1 })); } });
  const source = (media: MediaRecord, w?: number) => { const q = new URLSearchParams(); if (mediaRefresh[media.id]) q.set('retry', String(mediaRefresh[media.id])); if (w) q.set('w', String(w)); const s = q.toString(); return api.mediaUrl(media.id) + (s ? `?${s}` : ''); };
  const organize = (item: ContentRecord, recordReview = false) => {
    if (!api.editor) return;
    returnPosition.current = { page: window.scrollY, main: document.querySelector('main')?.scrollTop || 0 };
    dialog.current?.close(); setSelectedId(null);
    if (api.generation) { setManualCreation(!recordReview); setCreationId(item.id); setEditingId(null); } else setEditingId(item.id);
    if (recordReview && inLibrary(item)) void run('', () => api.review(item.id));
  };
  const requestDigest = async (id: number, renew = false) => {
    const item=state?.contents.find(content=>content.id===id);
    const saved=item?digestFor(item):undefined;
    if(item&&!renew&&(inLibrary(item)||saved?.request?.state==='complete'&&!saved.request.synthetic||api.batch&&batchOwnedIds?.includes(id))){organize(item,true);return;}
    if(state?.recentSync?.pausedContentDownloads?.some(entry=>entry.contentId===id)){
      await run('',async()=>{throw Error('此条自动下载已暂停，不能新建消化任务；已有成果仍可阅读');});return;
    }
    const needsAsr = item ? precheckNeedsAsr(item) : false;
    const openWorkspace = () => {
      if (creationId !== id) { returnPosition.current = { page: window.scrollY, main: document.querySelector('main')?.scrollTop || 0 }; focusOrigin.current = document.activeElement as HTMLElement; }
      dialog.current?.close(); setSelectedId(null); setEditingId(null); setManualCreation(false); setCreationId(id); setDigestProgressId(null);
    };
    const sendRequest = () => void run('建立消化请求', async () => {
      if (!api.digestPipeline) throw new Error('当前运行尚未启用消化处理，手动整理仍可使用');
      await api.digestPipeline.request(id, renew);
    });
    // E4.3 §9a: a missing precheck intercepts before any navigation; cancel leaves
    // the user where they were. An already-authorized generation keeps its
    // existing request and opens straight into the workspace.
    const missing = precheckMissing(state?.processingConfiguration, needsAsr);
    // E4.4 §6：重新消化同样先过预检；已有授权请求只对新请求直接打开工作区。
    if (missing && api.generation) {
      if (!renew && (await api.generation.status(id)).authorized) { openWorkspace(); return; }
      setPrecheck({ needsAsr, start: () => { setPrecheck(null); if (!renew) openWorkspace(); sendRequest(); } });
      return;
    }
    if (api.generation) { openWorkspace(); } else setDigestProgressId(id);
    await run('建立消化请求', async () => {
      if (!api.digestPipeline) throw new Error('当前运行尚未启用消化处理，手动整理仍可使用');
      // Opening is tied to the click above, never to a late response after the
      // user has closed progress or moved to another collection.
      if (api.generation && !renew && (await api.generation.status(id)).authorized) return;
      if (missing) { setPrecheck({ needsAsr, start: () => { setPrecheck(null); sendRequest(); } }); return; }
      await api.digestPipeline.request(id, renew);
    });
  };
  const requestBatch = async (ids: number[]) => {
    const selected = state?.contents.filter(c => ids.includes(c.id)) || [];
    const needsAsr = selected.some(precheckNeedsAsr);
    const start = () => void run('建立消化批次', async () => {
      if (!api.batch) throw new Error('当前运行尚未启用批量消化');
      const result = await createBatch(api.batch, selected, api.state, receiveBatchItems);
      setSelectMode(false); setBatchSelection([]);
      if (result.excluded) setError(`已排除 ${result.excluded} 条状态变化的内容，为其余 ${result.created} 条建立消化批次。`);
    });
    if (precheckMissing(state?.processingConfiguration, needsAsr)) setPrecheck({ needsAsr, start: () => { setPrecheck(null); start(); } });
    else start();
  };
  const removeDigest = async (id: number) => run('移出消化库', async () => {
    if (!api.digestPipeline) throw new Error('当前运行尚未启用消化库管理');
    await api.digestPipeline.removeLibrary(id);
  });
  const backFromEditor = async () => {
    if (!await runLeaveGuards()) return;
    setEditingId(null); setCreationId(null); setManualCreation(false); void refreshPreviews();
    requestAnimationFrame(() => {
      window.scrollTo(0, returnPosition.current.page);
      const main = document.querySelector('main'); if (main) main.scrollTop = returnPosition.current.main;
      restoreReaderFocus(focusOrigin.current, Array.from(document.querySelectorAll<HTMLElement>('[data-content-id]')).map(c => Number(c.dataset.contentId)), focusIndex.current, filtersEntry.current || listEntry.current);
    });
  };
  const openCredentialSettings = async (kind:'asr'|'generation') => {
    if (!await runLeaveGuards()) return;
    setPrecheck(null); setSelectedId(null); setEditingId(null); setCreationId(null); setManualCreation(false);
    setView('settings'); setCredentialFocus(kind);
  };
  const discoveryLabel = (item: ContentRecord) => ({ new: '新收藏', unknown: '新旧未确认', historical: '首次导入' } as const)[item.discovery];
  const card = (item: ContentRecord, extraTag?: string, eager?: boolean) => {
    const cover = currentMedia(item).find(m => m.kind === 'image' && m.state === 'succeeded');
    const downloadPause = state?.recentSync?.pausedContentDownloads?.find(entry => entry.contentId === item.id);
    const save = downloadPause ? { text: '自动下载已暂停', failed: false } : contentSaveState(item);
    const hasLocalError = currentMedia(item).some(m => mediaErrors[m.id]);
    const selectionReason=api.batch?batchSelectionReason(item,state,batchOwnedIds):undefined;
    const deleteReason=(state?.deletionBlocked??[]).find(row=>row.contentId===item.id)?.reason;
    const alreadyDigested=inLibrary(item)||digestFor(item)?.request?.state==='complete'&&!digestFor(item)?.request?.synthetic;
    const isProcessing=processing(item);
    const chip=cardChip({failed:hasLocalError||save.failed,processing:isProcessing,paused:!!downloadPause,digested:alreadyDigested,offlineComplete:item.offline&&!hasLocalError});
    const act=cardAction({digested:alreadyDigested,processing:isProcessing,paused:!!downloadPause&&!alreadyDigested});
    const KindIcon=item.kind==='video'?IconVideo:item.kind==='audio'?IconAudio:item.kind==='text'?IconText:IconImage;
    return <article className={`content-card-wrap${selectMode?' selecting':''}${selectMode&&deleteReason?' ineligible':''}`} key={item.id} title={selectMode?deleteReason||undefined:undefined} aria-label={selectMode&&deleteReason?`不可选择：${deleteReason}`:undefined}>{selectMode&&api.batch&&!deleteReason&&<input className="card-check" type="checkbox" aria-label={`选择 ${title(item)}`} checked={batchSelection.includes(item.id)} onChange={event=>setBatchSelection(previous=>event.target.checked?[...previous,item.id]:previous.filter(id=>id!==item.id))}/>}<button className="content-card" data-content-id={item.id} onClick={() => open(item)} aria-label={`打开 ${title(item)}`}>
      {cover && !mediaErrors[cover.id] ? <img className="cover" src={source(cover, 480)} alt={title(item)} loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} decoding="async" onError={() => localError(cover, 'image')} /> : <div className="title-cover"><span className="cover-type">{kindShortName[item.kind]} / {platformName(item.platform)}</span><strong>{title(item)}</strong><span>{cover && mediaErrors[cover.id] ? '原封面读取失败 · 打开后可恢复' : '原封面尚未保存'}</span></div>}
      <div className="card-text"><div className="card-tags"><span className="icon-tag"><KindIcon size={14} />{kindShortName[item.kind]}</span><span>{platformShortName(item.platform)}</span>{extraTag && <span className="icon-tag discovery-tag">{extraTag}</span>}</div>{(cover && !mediaErrors[cover.id]) && <h3>{title(item)}</h3>}<p>{item.author || '作者未提供'}</p></div>
    </button><div className="card-footer">{chip&&<span className={`card-chip ${chip}`}>{chip==='digested'||chip==='processing'?digestLabel(item):cardChipLabel[chip]}</span>}<button className="btn card-digest-action" data-card-digest={item.id} disabled={!!action || !api.digestPipeline || !!downloadPause&&!alreadyDigested} onClick={() => alreadyDigested?organize(item,true):api.generation ? void requestDigest(item.id) : processing(item) ? setDigestProgressId(item.id) : void requestDigest(item.id)}>{downloadPause?'自动下载已暂停':cardActionLabel[act]}</button></div></article>;
  };
  const digestCard = (item: ContentRecord) => {
    const preview = previews.find(p => p.contentId === item.id);
    const candidate = !!api.generation && !!digestFor(item)?.library?.candidate;
    return <article className="digest-preview-card" key={item.id}>
      <button className="digest-open" data-content-id={item.id} onClick={() => { focusOrigin.current = document.activeElement as HTMLElement; focusIndex.current = filtered.findIndex(c => c.id === item.id); organize(item, true); }} aria-label={candidate ? `查看 AI 新版本 ${title(item)}` : `整理 ${preview?.userTitle || title(item)}`}>
        <div className="digest-preview" data-preview-revision={candidate ? undefined : preview?.mapRevision}>
          {candidate ? <span data-testid="digest-candidate-title-card">AI 新版本待查看<br/>{devInfo && <small>请求 {digestFor(item)?.library?.requestId?.slice(-12) || '保留版本'}</small>}</span> : preview?.state === 'ready' && preview.svg ? <div className="saved-map-preview" dangerouslySetInnerHTML={{ __html: preview.svg }} /> : <span>{preview?.state === 'failed' || previewError ? '导图预览暂不可用 · 已保存内容保留' : preview ? '导图预览准备中' : '已消化 · 早期标记，尚未生成导图'}</span>}
        </div>
        <div className="digest-preview-copy"><span className={`icon-tag source-chip source-${digestFor(item)?.library?.source ?? (digestFor(item)?.library?.legacy || item.digestedAt !== null ? 'legacy' : 'ai')}`}>{({ ai: 'AI', manual: '手动', legacy: '早期标记' } as const)[digestFor(item)?.library?.source ?? (digestFor(item)?.library?.legacy || item.digestedAt !== null ? 'legacy' : 'ai')]}</span><small>{platformName(item.platform)} · {kindShortName[item.kind]}</small><h3>{candidate ? title(item) : preview?.userTitle || title(item)}</h3><p>{preview ? `${preview.nodeCount ?? 0} 个节点 · 最近整理 ${date(preview.updatedAt)}` : '创建导图，留下自己的理解'}</p></div>
      </button>
      {!candidate && (preview?.state === 'failed' || previewError) && <button className="text-button preview-retry" onClick={() => { void refreshPreviews(); }}>重试导图预览</button>}
    </article>;
  };
  const empty = (heading: string, text: string, button = true) => <div className="empty-state"><AvatarImage className="empty-avatar" /><h3>{heading}</h3><p>{text}</p>{button && <button className="btn-primary" onClick={() => setView('settings')}>连接我的收藏 <IconExternal size={14} /></button>}</div>;

  const editing = state?.contents.find(c => c.id === editingId);
  const creation = state?.contents.find(c => c.id === creationId);
  const digestDialog = digestProgressId === null ? null : <DigestProgress state={state?.digestStates?.find(s => s.contentId === digestProgressId)} api={api.digestPipeline} ocrApi={api.ocr} onOpenOcr={openOcr} asrApi={api.asr} onOpenAsr={openAsr} contentId={digestProgressId} error={error} busy={!!action} onClose={() => setDigestProgressId(null)} onRequest={renew => { void requestDigest(digestProgressId, renew); }} onCancel={() => void run('取消消化', async () => { await api.digestPipeline?.cancel(digestProgressId); })} onRetry={() => void run('重试中', async () => { await api.digestPipeline?.retry(digestProgressId); })} onRemove={() => { void removeDigest(digestProgressId); }} />;
  const ocrDialog = ocrTarget && api.ocr ? <OcrWorkspace api={api.ocr} target={ocrTarget} title={state?.contents.find(item => item.id === ocrTarget.contentId)?.title || '图片文字'} registerLeaveGuard={registerLeaveGuard} onAddReference={ocrReference.current?.contentId === ocrTarget.contentId ? ocrReference.current.handler : undefined} onClose={() => { const returnId = ocrReturnProgress.current ? ocrTarget.contentId : null; setOcrTarget(null); if (returnId !== null) setDigestProgressId(returnId); }} /> : null;
  const asrDialog=asrTarget&&api.asr?<AsrWorkspace key={`${asrTarget.contentId}:${asrTarget.resultId}:${asrTarget.revision??1}`} api={api.asr} target={asrTarget} title={state?.contents.find(c=>c.id===asrTarget.contentId)?.title||(state?.contents.find(c=>c.id===asrTarget.contentId)?.kind==='audio'?'音频文字稿':'视频文字稿')} registerLeaveGuard={registerLeaveGuard} onAddReference={asrReference.current?.contentId===asrTarget.contentId?asrReference.current.handler:undefined} mediaKind={state?.contents.find(c=>c.id===asrTarget.contentId)?.kind==='audio'?'audio':'video'} onClose={()=>{const id=asrReturnProgress.current?asrTarget.contentId:null;setAsrTarget(null);if(id!==null)setDigestProgressId(id);}}/>:null;
  const deleteDialogs = <>{deleteRequest&&<DeleteConfirm request={deleteRequest} busy={!!action} onCancel={()=>setDeleteRequest(null)} onConfirm={()=>void confirmDelete()}/>}{deletedListOpen&&<DeletedList rows={state?.deleted??[]} busy={!!action} onRestore={id=>void restoreDeletedItem(id)} onClose={()=>setDeletedListOpen(false)}/>}{syncRangeConfirm&&<SyncRangeConfirm busy={!!action} onCancel={()=>setSyncRangeConfirm(false)} onConfirm={()=>{setSyncRangeConfirm(false);void run('开始全量同步',async()=>{await api.setSyncRange!('all');await api.sync();});}}/>}</>;
  const queueFix = (row: QueueRow, fix: QueueFix) => {
    if (fix === 'open') { setQueueOpen(false); const item = state?.contents.find(c => c.id === row.contentId); if (item) { dialog.current?.close(); setSelectedId(item.id); } return; }
    if (fix === 'settings-asr' || fix === 'settings-generation') { setQueueOpen(false); void openCredentialSettings(fix === 'settings-asr' ? 'asr' : 'generation'); return; }
    if (fix === 'enable-network') { void run('开启 AI 处理', async () => { await api.asr?.setNetworkAllowed?.(true); }); return; }
    void run('重试消化', async () => {
      if (row.batchId && api.batch) await api.batch.retry(row.batchId, row.contentId);
      else await api.digestPipeline?.retry(row.contentId);
    });
  };
  const precheckDialog = precheck && <PrecheckDialog config={state?.processingConfiguration} usage={state?.usage} needsAsr={precheck.needsAsr} api={{setNetworkAllowed:api.asr?.setNetworkAllowed?.bind(api.asr),configureAsr:api.asr?.configureCredentials?.bind(api.asr),configureGeneration:api.generation?.configureCredentials?.bind(api.generation)}} busy={!!action} onStart={precheck.start} onCancel={()=>setPrecheck(null)} onOpenSettings={kind=>{void openCredentialSettings(kind);}}/>;
  if (creation && api.editor && api.generation) return <><TopProgress state={state!} inline onOpen={() => { setCreationId(null); setSyncOpen(true); }} /><CreationWorkspace key={creation.id} content={creation} api={api.editor} generation={api.generation} digest={digestFor(creation)} manualEntry={manualCreation} requestError={error} asrApi={api.asr} onOpenAsr={openAsr} registerAsrReferenceHandler={registerAsrReferenceHandler} ocrApi={api.ocr} onOpenOcr={openOcr} registerOcrReferenceHandler={registerOcrReferenceHandler} mediaUrl={id => api.mediaUrl(id)} openOriginal={() => api.openOriginal(creation.id)} onBack={() => { void backFromEditor(); }} onDigestRequest={() => requestDigest(creation.id)} onRemoveFromDigestLibrary={() => removeDigest(creation.id)} onMarkDone={api.digestPipeline?.addManual ? () => run('放进消化库', async () => { await api.digestPipeline!.addManual!(creation.id); }) : undefined} digestStatus={{label:digestLabel(creation),active:processing(creation),inLibrary:inLibrary(creation),legacy:digestFor(creation)?.library?.legacy??!!creation.digestedAt}} registerLeaveGuard={registerLeaveGuard} onSaved={() => { void refreshPreviews(); }} waitingActions={{configure:async()=>{await openCredentialSettings('generation');},enableNetwork:async()=>{await api.asr?.setNetworkAllowed?.(true)},retryMedia:()=>api.retry(creation.id)}} onCancel={() => run('取消本条处理',async()=>{await api.digestPipeline?.cancel(creation.id);})} onRetryExtraction={async()=>{await api.digestPipeline?.retry(creation.id);}} onRenew={() => requestDigest(creation.id,true)} moreMenu={<button onClick={()=>void openDelete([creation.id],()=>setCreationId(null))}>删除这条收藏…</button>}/>{ocrDialog}{asrDialog}{precheckDialog}{deleteDialogs}</>;
  if (editing && api.editor) return <><TopProgress state={state!} inline onOpen={() => { setEditingId(null); setSyncOpen(true); }} /><EditorWorkspace key={editing.id} content={editing} api={api.editor} asrApi={api.asr} onOpenAsr={openAsr} registerAsrReferenceHandler={registerAsrReferenceHandler} ocrApi={api.ocr} onOpenOcr={openOcr} registerOcrReferenceHandler={registerOcrReferenceHandler} mediaUrl={id => api.mediaUrl(id)} openOriginal={() => api.openOriginal(editing.id)} onBack={() => { void backFromEditor(); }} onDigestRequest={() => requestDigest(editing.id)} onDigestProgress={() => setDigestProgressId(editing.id)} onRemoveFromDigestLibrary={() => removeDigest(editing.id)} onMarkDone={api.digestPipeline?.addManual ? () => run('放进消化库', async () => { await api.digestPipeline!.addManual!(editing.id); }) : undefined} digestStatus={{label:digestLabel(editing),active:processing(editing),inLibrary:inLibrary(editing),legacy:digestFor(editing)?.library?.legacy??!!editing.digestedAt}} registerLeaveGuard={registerLeaveGuard} onSaved={() => { void refreshPreviews(); }} moreMenu={<button onClick={()=>void openDelete([editing.id],()=>setEditingId(null))}>删除这条收藏…</button>}/>{digestDialog}{ocrDialog}{asrDialog}{precheckDialog}{deleteDialogs}</>;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-avatar"><AvatarMascot /></span><div><b>收藏阅读</b><small>WORKBENCH / 01</small></div></div><p className="sidebar-intro">把收藏，变成自己的。<br/>本地保存 · 慢慢消化</p><nav aria-label="主导航">{navs.map(n => <button key={n.key} className={view === n.key ? 'active' : ''} onClick={() => { setView(n.key); resetFilters(); }} aria-current={view === n.key ? 'page' : undefined}><span className="nav-icon"><n.icon size={20} /></span>{n.label}{n.key === 'library' && <small>{total}</small>}{n.key === 'digested' && <small>{digested}</small>}</button>)}</nav><div className="sidebar-note"><span className="note-pin"><AvatarImage /></span><p>收藏是起点。<br/><b>成果留给自己。</b></p><small>不用急，一次读一点。</small></div><div className="sidebar-footer"><span className="network-dot" data-online={state?.online !== false}/>{state?.online === false ? '离线模式 · 本地资料可用' : '本地优先 · 资料留在本机'}<button aria-label="切换深浅主题" title="切换深浅主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><IconTheme size={20} /></button></div></aside>
    <main><header className="topbar"><span>L叔的阅读工作台 <span className="muted">/ {navs.find(n => n.key === view)?.label}</span></span><div className="topbar-chips">
      {state?.recentSync && <span className="chip-host"><button className="chip" aria-expanded={syncOpen} aria-haspopup="dialog" title={syncChipText(state) || '同步进度'} aria-label={syncChipText(state) || '同步进度'} onClick={() => { setQueueOpen(false); setSyncOpen(open => !open); }}><IconSync size={14} /><span className="chip-text">{syncChipText(state) || '同步进度'}</span></button>{syncOpen && <div className="chip-popover" role="dialog" aria-label="同步进度"><button className="chip-close icon-button" aria-label="关闭同步进度" onClick={() => setSyncOpen(false)}><IconClose size={14} /></button><RecentSyncSummary scope={state.recentSync} contents={state.contents} deleted={state.deleted} paused={!!state.downloadsPaused} progress={state.progress} syncLine={syncRunLine(state.syncs,date)} syncRange={state.syncRange} onToggle={()=>void run('更新下载队列',async()=>{if(state.downloadsPaused)await api.resumeDownloads?.();else await api.pauseDownloads?.();})} onResumePlatform={(p)=>void run('更新下载队列',async()=>api.resumePlatform?.(p as Platform))} onLogin={(p)=>{setSyncOpen(false);setView('settings');void run('打开登录',()=>api.login(p as Platform));}}/></div>}</span>}
      {(digestOpen > 0 || (api.batch && batchList.length > 0)) && <span className="chip-host"><button className="chip" data-testid="digest-queue-chip" aria-expanded={queueOpen} aria-haspopup="dialog" onClick={() => { setSyncOpen(false); setQueueOpen(open => !open); }}><IconQueue size={14} />{digestOpen > 0 ? `消化中 ${digestOpen}` : '处理队列'}</button></span>}
      <button className="btn" onClick={() => void (async () => { await run('同步中', () => api.sync()); const next = await api.state().catch(() => null); const run2 = next ? syncRunSummary(next.syncs) : null; if (run2) { setSyncNotice(`同步完成：新增 ${run2.saved} 条${run2.limited ? '（部分平台受限）' : ''}`); setTimeout(() => setSyncNotice(''), 5000); } })()} disabled={isBusy || state?.online === false}>{isBusy ? '正在处理' : <><IconSync size={14} /> 同步收藏</>}</button></div>{syncNotice && <div className="notice-bar" role="status">{syncNotice}</div>}{state && <TopProgress state={state} onOpen={() => setSyncOpen(true)} />}</header>
      {error && <div className="error-banner" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}><IconClose size={16} /></button></div>}
      {!state ? <div className="page">{loadError ? <div role="alert">{loadError}<button className="btn" onClick={() => void refresh()}>重试</button></div> : <p role="status">正在加载本地收藏…</p>}</div> : <div className="page" ref={listEntry} tabIndex={-1}>
      {queueOpen&&(api.batch||digestOpen>0)&&<div className="queue-drawer" role="dialog" aria-label="处理队列"><div className="queue-drawer-head"><h2>处理队列</h2><button className="icon-button" aria-label="关闭处理队列" onClick={()=>setQueueOpen(false)}><IconClose size={16}/></button></div><DigestQueue digests={state?.digestStates??[]} batches={batchList} config={state?.processingConfiguration} online={state?.online} busy={!!action} titles={digestTitles} onOpen={id=>{setQueueOpen(false);const item=state?.contents.find(c=>c.id===id);if(item)organize(item,true);}} onFix={(row,fix)=>queueFix(row,fix)}/>{api.batch&&<BatchPanel embedded api={api.batch} selected={state?.contents.filter(c=>batchSelection.includes(c.id))??[]} onClear={()=>setBatchSelection([])} onOpen={id=>{setQueueOpen(false);const item=state?.contents.find(c=>c.id===id);if(item)organize(item,true);}} onRefresh={()=>void refresh()} onBatchItems={receiveBatchItems} readState={api.state}/>}</div>}
      {view === 'home' && <><div className="page-heading"><div><p className="eyebrow">YOUR DAILY READING</p><h1>今天，读一点。</h1><p className="subtitle">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(Date.now())} <span> / 给收藏留一点时间</span></p></div><div className="page-index">01<span>/ 阅读日常</span></div></div><div className="stats"><div><b>{total.toString().padStart(2, '0')}</b><span>份收藏</span></div><div><b>{offline.toString().padStart(2, '0')}</b><span>份可离线</span></div><div><b>{digested.toString().padStart(2, '0')}</b><span>份已消化</span></div><p>点「消化」，AI 帮你整理成导图和文稿。<br/>完成后放进消化库。 <span><IconArrowDownLeft size={20} /></span></p></div><section><div className="section-heading"><h2><i className="orange-square"/>继续 <small>{state.continueItems.length} / 8</small></h2><span>正在处理、需要处理或写了一半</span>{state.continueItems.length > homeCols && <button className="text-button" onClick={() => setContinueAll(v => !v)}>{continueAll ? '收起' : `查看全部 ${state.continueItems.length}`}</button>}</div>{state.continueItems.length ? <div className="home-row" style={{ '--home-cols': homeCols } as React.CSSProperties}>{(continueAll ? state.continueItems : state.continueItems.slice(0, homeCols)).map((item, index) => card(item, undefined, index < 12))}</div> : null}</section><section><div className="section-heading"><h2><i className="orange-square"/>最近同步到的 <small>{state.recent.length} / 12</small></h2><span>近7天发现 · 尚未消化</span>{state.recent.length > homeCols && <button className="text-button" onClick={() => { setView('library'); setStatus('pending'); setPlatform('all'); setSearch(''); }}>{`查看全部 ${state.recent.length}`}</button>}</div>{state.recent.length ? <div className="home-row" style={{ '--home-cols': homeCols } as React.CSSProperties}>{state.recent.slice(0, homeCols).map((item, index) => card(item, discoveryLabel(item), index < 12))}</div> : null}</section><section><div className="section-heading"><h2><i className="yellow-square"/>该回顾了 <small>{state.reviews.length} / 20</small></h2><span>近14天已消化 · 优先最久未回顾</span>{state.reviews.length > homeCols && <button className="text-button" onClick={() => { setView('digested'); resetFilters(); }}>{`查看全部 ${state.reviews.length}`}</button>}</div>{state.reviews.length ? <div className="home-row" style={{ '--home-cols': homeCols } as React.CSSProperties}>{state.reviews.slice(0, homeCols).map((item, index) => card(item, undefined, index < 12))}</div> : null}</section>{!state.continueItems.length && !state.recent.length && !state.reviews.length && empty('这里会慢慢长出你的阅读日常', '同步收藏后，正在处理与待回顾的内容会出现在这里。', !total)}</>}
      {(view === 'library' || view === 'digested') && <><div className="page-heading"><div><p className="eyebrow">{view === 'library' ? 'MY COLLECTION' : 'MADE IT MINE'}</p><h1>{view === 'library' ? '我的收藏夹' : '消化库'}</h1><p className="subtitle">{view === 'library' ? '从手机里的一次收藏，到随时能读的本地资料。' : '你消化过的收藏：AI 整理、手动整理和早期标记都在这里。'}</p></div><div className="page-index">{view === 'library' ? '02' : '03'}<span>/ {view === 'library' ? `${total} 份收藏` : `${digested} 份已消化`}</span></div></div><div className="filters"><div className="segmented" aria-label="平台筛选">{[['all','全部来源'],...(api.batch?PLATFORMS:['xiaohongshu','bilibili'] as Platform[]).map(p=>[p,platformName(p)])].map(([value,label])=><button aria-pressed={platform === value} className={platform === value ? 'selected' : ''} key={value} ref={value==='all'?filtersEntry:undefined} onClick={()=>setPlatform(value)}>{label}</button>)}</div>{view==='library'?<select aria-label="消化状态筛选" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">全部状态</option><option value="pending">未消化</option><option value="processing">正在消化</option><option value="digested">已消化</option></select>:<select aria-label="来源筛选" value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}><option value="all">全部</option><option value="ai">AI</option><option value="manual">手动</option><option value="legacy">早期标记</option></select>}<select aria-label="排序" value={sort} onChange={e=>{setSort(e.target.value as 'newest'|'oldest');localStorage.setItem('rlw-library-sort',e.target.value);}}><option value="newest">最新收藏</option><option value="oldest">最旧收藏</option></select><label className="search"><span><IconSearch size={18} /></span><input aria-label="搜索标题" placeholder="搜索收藏标题…" value={search} onChange={e=>setSearch(e.target.value)}/></label>{view==='library'&&api.batch&&<button className="btn" aria-pressed={selectMode} onClick={()=>{setSelectMode(mode=>!mode);if(selectMode)setBatchSelection([]);}}>{selectMode?'退出选择':'批量选择'}</button>}</div><div className="results-line"><span>{filtered.length} 份{view === 'digested' ? '已消化' : '收藏'}{(search || platform !== 'all' || status !== 'all' || (view === 'digested' && sourceFilter !== 'all')) && ' · 已筛选'}</span><span>正文与资源独立保存 · {offline}/{total} 份完整可离线</span></div>{filtered.length ? view === 'digested' && api.editor ? <div className="digested-grid">{filtered.map(digestCard)}</div> : <div className="masonry">{filtered.map((item, index) => card(item, undefined, index < 12))}</div> : (search || platform !== 'all' || status !== 'all') ? <div className="empty-state"><AvatarImage className="empty-avatar" /><h3>没有符合条件的收藏</h3><p>试试其他关键词，或者清除筛选。</p><button className="btn" onClick={resetFilters}>清除筛选</button></div> : view === 'digested' ? empty('把成果留进消化库', '点击收藏的「消化」建立请求。完整处理成功后进入消化库；当前识别和生成能力尚未就绪，手动整理仍可使用。', false) : state.syncs.some(s=>s.state==='failed') ? empty('还没有采集到收藏', '最近一次采集失败。请到设置查看连接状态，完成登录后重试。') : empty('你的收藏，值得被读完', api.batch?'连接账号，同步收藏。':'连接小红书和B站，首次合计导入最多30条真实收藏。')}</>}
      {view === 'settings' && <><div className="page-heading"><div><p className="eyebrow">CONNECTIONS & LOCAL DATA</p><h1>设置</h1><p className="subtitle">独立登录，独立保存。每一次同步都有记录。</p></div><div className="page-index">04<span>/ 本地与连接</span></div></div><div className="section-heading"><h2>平台账号</h2>{api.batch&&<button className="btn" disabled={!!action} onClick={()=>void run('打开登录',async()=>{for(const p of PLATFORMS)await api.login(p);})}>打开五个平台登录</button>}<span>{state.connections.some(c=>c.method.includes('Chrome'))?'Chrome Bridge 对照 · 应用内登录另行验证':'应用内消费者会话 · 只读收藏'}</span></div><div className="connections">{(api.batch?PLATFORMS:['xiaohongshu','bilibili'] as Platform[]).map(p=>{const c=state.connections.find(x=>x.platform===p);return <article className="connection" key={p}><div className={`platform-logo ${p}`}>{p==='bilibili'?'bili':platformName(p)}</div><div className="connection-main"><h3>{platformName(p)} <span className="badge">{c?.state==='connected'?'已连接':c?.state==='expired'?'登录已失效':c?.state==='error'?'连接异常':'等待登录'}</span></h3><p>{c?.accountName || '在独立的应用窗口中登录你的账号'}</p><small>{safeError(c?.message) || '尚未验证登录，请登录后同步验证。'}</small>{devInfo && <small>实际采集：{c?.method || 'Electron 独立会话（应用内）'}</small>}</div><div className="connection-actions"><button className="btn" disabled={!!action} onClick={()=>void run('打开登录',()=>api.login(p))}>{c?.state==='connected'?'管理登录':<>平台登录 <IconExternal size={12} /></>}</button><button className="text-button" disabled={isBusy || !state.online} onClick={()=>void run('同步中',()=>api.sync(p))}>{state.busy.includes(p)?'同步中…':'同步此平台'}</button></div></article>;})}</div><div className="settings-grid"><section className="settings-block"><h2>AI 处理</h2><ProcessingSettings asr={api.asr} generation={api.generation} configuration={state.processingConfiguration} usage={state.usage} busy={!!action} run={run} focus={credentialFocus}/></section><section className="settings-block"><h2>同步</h2><div className="setting-row"><div><b>每30分钟自动检查</b><p>应用运行时检查；休眠或离线暂停，恢复后补查。</p></div><button role="switch" aria-checked={state.autoSync} className={`switch ${state.autoSync?'on':''}`} aria-label="自动同步" onClick={()=>void run('',()=>api.autoSync(!state.autoSync))}><span/></button></div>{api.batch&&<div className="setting-row"><div><b>同步范围</b><p>每次同步检查各平台最近 N 条收藏；已导入的内容不会因范围变小而删除。</p></div><div className="segmented" role="group" aria-label="同步范围">{([['10','最近 10 条'],['30','最近 30 条'],['100','最近 100 条'],['all','全部']] as const).map(([value,label])=><button key={value} aria-pressed={state.syncRange===value} className={state.syncRange===value?'selected':''} onClick={()=>{if(value==='all')setSyncRangeConfirm(true);else void run('更新同步范围',()=>api.setSyncRange!(value));}}>{label}</button>)}</div></div>}<dl className="scheduler-status"><dt>最近检查</dt><dd>{date(state.scheduler?.lastCheckAt)}</dd><dt>下次检查</dt><dd>{!state.autoSync?'自动检查已关闭':state.scheduler?.paused?'休眠 / 离线暂停':state.scheduler?.nextCheckAt?date(state.scheduler.nextCheckAt):'等待安排'}</dd>{!!state.scheduler?.pending.length&&<><dt>恢复补查</dt><dd>{state.scheduler.pending.map(platformName).join('、')}，等待旧任务释放</dd></>}</dl><p className="rule-note">退出应用后不在后台运行，也不会唤醒 Mac。<br/>{api.batch?'应用运行时每 30 分钟检查一次各平台最近收藏；同步与下载不会自动消化。':'首次两个平台合计最多30条，默认各15条。平台数量不足时分配剩余额度；首批标记为历史，未确认的新旧内容不会进入今日必读。'}</p></section><section className="settings-block"><h2>本地数据</h2><dl><dt>数据库与任务</dt><dd>{state.dataDir}</dd><dt>媒体目录</dt><dd>{state.mediaDir}</dd><dt>首页日期</dt><dd>Asia/Shanghai</dd><dt>已删除的收藏</dt><dd>{state.deleted?.length ?? 0} 条 · 累计释放约 {exportBytes((state.deleted ?? []).reduce((n, d) => n + d.bytesFreed, 0))} {!!state.deleted?.length && <button className="text-button" onClick={() => setDeletedListOpen(true)}>查看</button>}</dd></dl><p className="rule-note">「可离线」仅在正文与所需媒体全部保存后显示。阅读器只加载本地媒体。</p></section><section className="settings-block"><h2>高级</h2><div className="setting-row"><div><b>显示开发者信息</b><p>请求 ID、版本号、SHA 与端点等工程信息。</p></div><button role="switch" aria-checked={devInfo} className={`switch ${devInfo?'on':''}`} aria-label="显示开发者信息" onClick={()=>writeDevInfo(!devInfo)}><span/></button></div>{devInfo&&<><ProcessingEndpoints asr={api.asr} generation={api.generation}/><div className="setting-row"><div><b>实际采集方式</b>{(api.batch?PLATFORMS:['xiaohongshu','bilibili'] as Platform[]).map(p=>{const c=state.connections.find(x=>x.platform===p);return <p key={p}>{platformName(p)}：{c?.method || 'Electron 独立会话（应用内）'}</p>})}</div></div><p className="rule-note">处理密钥在「AI 处理」粘贴保存，独立保存在本机安全存储；页面只接收配置状态。</p></>}</section></div><section className="settings-block task-progress" aria-label="保存任务进度"><h2>本地保存进度</h2><p>内容：{state.progress?.offline ?? offline}/{state.progress?.contents ?? total} 份完整可离线 · 正文待完成 {state.progress?.bodyPending ?? state.contents.filter(c=>!c.bodyComplete).length} 份 · 媒体清单待完成 {state.progress?.manifestMissing ?? state.contents.filter(c=>c.mediaManifestComplete===false).length} 份</p><p>媒体文件：已保存 {state.progress?.mediaSaved ?? state.contents.flatMap(currentMedia).filter(m=>m.state==='succeeded').length} · 排队 {state.progress?.mediaQueued ?? state.contents.flatMap(currentMedia).filter(m=>m.state==='queued').length} · 下载中 {state.progress?.mediaRunning ?? state.contents.flatMap(currentMedia).filter(m=>m.state==='running').length} · 失败 {state.progress?.mediaFailed ?? state.contents.flatMap(currentMedia).filter(m=>m.state==='failed').length}</p><p>保存失败或清单缺失 {failedSaves} 份{failedSaves>0&&<button className="btn retry-failed-saves" data-action="retry-failed-saves" disabled={!state.online||!!action} onClick={()=>void run('重排失败任务',()=>api.retryFailures())}>重试失败保存</button>}</p><small>点击只重排本地失败任务；内容已消化不代表资源已经保存。历史覆盖与新增确认分别记录。</small></section><section><div className="section-heading"><h2>最近同步记录</h2><span>收藏同步与资源下载分别处理</span></div>{state.syncs.length ? <div className="sync-log">{state.syncs.slice(0,12).map(s=><article key={s.id}><div><b>{platformName(s.platform)}</b><span className={`badge ${s.state==='failed'?'error':''}`}>{({running:'进行中',succeeded:'完成',partial:'部分成功',failed:'失败'})[s.state]}</span><time>{date(s.startedAt)}</time></div><p>{safeError(s.message) || '正在读取收藏列表'}</p><small>历史覆盖：{s.state==='succeeded'?'本次列表完整':s.state==='partial'?'部分覆盖':s.state==='running'?'检查中':'未完成'} · 本次新增：{s.incrementalStatus==='confirmed'?`已确认 ${s.incrementalNew ?? 0} 条`:s.incrementalStatus==='baseline'?'建立基线，不计新增':'待确认'}</small>{s.incrementalReason&&<small className="sync-reason">{safeError(s.incrementalReason)}</small>}<small>列表观察 {s.discovered} · 去重 {s.deduplicated} · 内容入库 {s.saved} · 采集失败 {s.failed}（不含媒体下载）</small></article>)}</div> : <div className="quiet-empty"><AvatarImage className="empty-avatar" />还没有同步记录。完成登录后，点击「同步收藏」。</div>}</section></>}
      {selectMode&&batchSelection.length>0&&(()=>{const stats=selectionStats(state.contents.filter(c=>batchSelection.includes(c.id)));const digestible=batchSelection.filter(id=>{const c=state.contents.find(item=>item.id===id);return !!c&&!batchSelectionReason(c,state,batchOwnedIds);});return <div className="selection-bar" role="region" aria-label="批量选择"><span>已选 {stats.count} 条 · 图片 {stats.images} 张{stats.avMinutes > 0 ? ` · 已知音视频 ${stats.avMinutes.toFixed(1)} 分钟` : ''}</span><button className="btn" onClick={()=>setBatchSelection([])}>清空</button><button className="btn btn-danger" data-testid="batch-delete-selected" onClick={()=>void openDelete(batchSelection)}>删除所选 {stats.count}</button><button className="btn-primary" data-testid="batch-create-selected" disabled={!digestible.length} onClick={()=>void requestBatch(digestible)}>可消化 {digestible.length}</button></div>;})()}
      <footer className="page-footer"><span className="footer-brand"><AvatarImage className="footer-avatar" />L叔 · 收藏阅读工作台</span><span>原文有出处，理解归自己。</span></footer>
      </div>}
    </main>
    <dialog ref={dialog} className="reader" aria-labelledby="reader-title" onKeyDown={trapReaderFocus} onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===dialog.current)close();}}>{selected && <div className="reader-inner">
      <div className="reader-toolbar"><span>{platformName(selected.platform)} / {kindName[selected.kind]} <b>{currentMedia(selected).some(m=>mediaErrors[m.id])?'本地资源读取失败':contentSaveState(selected).text}</b></span><button className="icon-button" ref={closeButton} aria-label="关闭阅读卡片" onClick={close}><IconClose size={18} /></button></div>
      <div className="reader-columns"><div className="reader-media">{(()=>{
        const media = currentMedia(selected);
        const av = media.filter(m=>m.kind==='video'||m.kind==='audio');
        const images = media.filter(m=>m.kind==='image');
        const playing = av[mediaIndex] || av[0];
        const canRetry = !action && !!state?.online;
        const failedMedia = (m: MediaRecord, index: number) => <div className="media-unavailable media-error" role="alert" data-media-error={m.id}><strong>{mediaLabel(m,index)} · {mediaErrors[m.id]?'本地文件读取失败':m.state==='failed'?'下载失败':m.state==='running'?'正在下载':'排队下载'}</strong><p>{safeError(mediaErrors[m.id] || m.error) || (m.state==='running'?'资源正在保存到本机，请稍候。':m.state==='queued'?'资源已进入保存队列。':'平台未提供错误详情，请重试保存。')}</p>{(m.state==='failed'||mediaErrors[m.id])&&<><button className="btn" disabled={!canRetry} onClick={()=>retry(selected,m)}>重新下载{mediaLabel(m,index)}</button>{!state?.online&&<p>联网后可重新下载，本地其他资料仍可阅读。</p>}</>}</div>;
        return <>
          {(selected.kind==='video'||selected.kind==='audio')&&!av.length&&<div className="media-unavailable manifest-missing" role="status"><strong>{selected.kind==='video'?'视频':'音频'}清单尚未取得</strong><p>{safeError(selected.manifestError || selected.detailError) || '尚未确认可保存的播放资源。下方图片仅为封面，不能用于播放。'}</p><button className="btn" disabled={!canRetry} onClick={()=>retry(selected)}>重新获取{selected.kind==='video'?'视频':'音频'}清单</button></div>}
          {av.length>1&&<label className="part-select">选择播放资源 <select aria-label="选择视频分P或音频" value={Math.min(mediaIndex,av.length-1)} onChange={e=>setMediaIndex(Number(e.target.value))}>{av.map((m,i)=><option value={i} key={m.id}>{mediaLabel(m,i)} · {m.state==='succeeded'?'已保存':m.state==='failed'?'下载失败':m.state==='running'?'下载中':'排队中'}</option>)}</select></label>}
          {playing&&(playing.state==='succeeded'&&!mediaErrors[playing.id]?<div className="local-player"><p className="media-note">{mediaLabel(playing,av.indexOf(playing))} · 本地{playing.kind==='video'?'视频':'音频'}</p>{playing.kind==='video'?<video key={`${playing.id}:${mediaRefresh[playing.id]||0}`} controls preload="metadata" src={source(playing)} onError={()=>localError(playing,'av')}/>:<audio key={`${playing.id}:${mediaRefresh[playing.id]||0}`} controls preload="metadata" src={source(playing)} onError={()=>localError(playing,'av')}/>}</div>:failedMedia(playing,av.indexOf(playing)))}
          {av.filter(m=>m.id!==playing?.id&&(m.state!=='succeeded'||mediaErrors[m.id])).map(m=><React.Fragment key={m.id}>{failedMedia(m,av.indexOf(m))}</React.Fragment>)}
          {images.length>0&&(selected.kind==='video'||selected.kind==='audio')&&<p className="media-note cover-note">以下为来源封面 / 图片；音视频保存状态见上方。</p>}
          {images.map((m,i)=><div className="reader-image" key={m.id}>{m.state==='succeeded'&&!mediaErrors[m.id]?<img src={source(m)} alt={mediaLabel(m,i)} onError={()=>localError(m,'image')}/>:failedMedia(m,i)}</div>)}
          {!av.length&&!images.length&&selected.kind!=='video'&&selected.kind!=='audio'&&<div className="media-unavailable large"><span><IconImage size={40} /></span><h3>原媒体尚未保存</h3><p>正文与媒体获取状态见右侧。</p></div>}
          {media.some(m=>m.state!=='succeeded')&&<p className="media-note">只加载已保存的本地媒体。</p>}
          {(api.asr && (selected.kind === 'video' || selected.kind === 'audio')) && <AsrResultsPanel pipelineComplete={!!api.generation && digestFor(selected)?.request?.state === 'complete'} api={api.asr} contentId={selected.id} onOpen={openAsr} onConfigure={async()=>{await openCredentialSettings('asr');}}/>}
          {(api.ocr && currentMedia(selected).some(m => m.kind === 'image')) && <OcrResultsPanel pipelineComplete={!!api.generation && digestFor(selected)?.request?.state === 'complete'} waitingAsr={selected.kind === 'video' || selected.kind === 'audio'} api={api.ocr} contentId={selected.id} onOpen={openOcr} onProgress={() => setDigestProgressId(selected.id)} />}
        </>;
      })()}</div><article className="reader-copy">
        <div className="reader-tags"><span>{selected.discovery==='historical'?'历史导入':selected.discovery==='new'?'新增收藏':'发现时间状态未知'}</span><span>{digestLabel(selected)}</span></div><h2 id="reader-title">{title(selected)}</h2><p className="reader-author">{selected.author || '作者未提供'}</p>
        <div className="reader-actions"><button className="btn-primary" data-digest-request={selected.id} disabled={!!action||!api.digestPipeline} title={!api.digestPipeline?'此运行尚未启用消化处理':undefined} onClick={()=>inLibrary(selected)?organize(selected,true):api.generation?void requestDigest(selected.id):processing(selected)?setDigestProgressId(selected.id):void requestDigest(selected.id)}>{inLibrary(selected)?'打开笔记':processing(selected)?'查看进度':'消化'}</button><button className="text-button" onClick={()=>void run('',()=>api.openOriginal(selected.id))}>查看原链接 <IconExternal size={12} /></button><details className="reader-menu"><summary className="icon-button" aria-label="更多操作"><IconMore size={18} /></summary><div className="reader-menu-list">{api.editor&&<button data-organize={selected.id} onClick={()=>organize(selected)}>手动整理</button>}{inLibrary(selected)&&<button disabled={!!action||!api.digestPipeline} onClick={()=>void removeDigest(selected.id)}>从消化库移出</button>}<button onClick={()=>void openDelete([selected.id],()=>{dialog.current?.close();setSelectedId(null);})}>删除这条收藏…</button></div></details></div>
        {error&&<p className="inline-error" role="alert">{error}</p>}<p className="reader-dates-line muted"><span className="reader-date-pair">发布 {date(selected.publishedAt)}</span><span className="reader-date-pair">收藏 {date(selected.collectedAt)}</span></p><details className="reader-dates-detail"><summary>详情</summary><dl className="reader-dates"><dt>原内容发布</dt><dd>{date(selected.publishedAt)}</dd><dt>平台收藏时间</dt><dd>{date(selected.collectedAt)}</dd><dt>本地首次发现</dt><dd>{date(selected.firstDiscoveredAt)}</dd>{selected.digestedAt&&<><dt>早期消化时间</dt><dd>{date(selected.digestedAt)}</dd></>}</dl></details>
        <div className="body-copy">{selected.body ? <><h3>来源正文 / 简介</h3><p>{selected.body}</p></> : <p className="unavailable">{selected.detailState==='queued'?'正文等待获取。':selected.detailState==='running'?'正在获取来源正文。':selected.availability==='unavailable'?'来源已失效，未取得正文。':'尚未取得来源正文。'}</p>}{selected.subtitle ? <><h3>已取得的字幕</h3><p>{selected.subtitle}</p></> : (selected.kind==='video'||selected.kind==='audio')&&<p className="unavailable">{api.asr?'尚未取得平台字幕，转录状态见左侧音视频转录。':`尚未取得转录或字幕。`}</p>}</div>
        {(!selected.offline||currentMedia(selected).some(m=>mediaErrors[m.id]))&&<div className="save-status" aria-label="内容保存状态"><b>{contentSaveState(selected).text}</b><dl><dt>来源正文</dt><dd>{selected.bodyComplete?'已完整保存':selected.detailState==='queued'?'排队获取':selected.detailState==='running'?'正在获取':selected.detailState==='failed'?'获取失败':'尚未完整'}</dd><dt>当前媒体清单</dt><dd>{selected.mediaManifestComplete?'已确认完整':'尚未完整取得'}</dd><dt>本地资源</dt><dd>{currentMedia(selected).filter(m=>m.state==='succeeded'&&!mediaErrors[m.id]).length}/{currentMedia(selected).length} 个已保存；{currentMedia(selected).filter(m=>m.state==='failed').length} 个下载失败</dd></dl>{(selected.detailError||selected.manifestError)&&<p>{safeError(selected.detailError||selected.manifestError)}</p>}{selected.availability==='unavailable'&&<p>平台内容已失效或当前账号无法访问；本地资料保留。</p>}{selected.availability==='unsupported'&&<p>平台当前未提供受支持的完整媒体格式；本地资料保留。</p>}<button className="btn" disabled={!!action||!state?.online} onClick={()=>retry(selected)}>重新检查并重试保存</button>{!state?.online&&<p>当前离线，联网后可重试。</p>}</div>}
      </article></div>
    </div>}</dialog>{digestDialog}{ocrDialog}{asrDialog}{precheckDialog}{deleteDialogs}
  </div>;
}
const rootElement = createRoot(document.getElementById('root')!);
if (location.hash === '#knowledge-card') {
  const renderCard = () => rootElement.render(<KnowledgeCardRoute />);
  window.addEventListener('knowledge-card-data', renderCard);
  renderCard();
} else rootElement.render(<App/>);
