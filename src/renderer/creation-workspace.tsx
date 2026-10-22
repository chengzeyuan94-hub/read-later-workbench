import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorGenerationBarrier, EditorWorkspaceProps } from './editor-workspace.js';
import { EditorWorkspace } from './editor-workspace.js';
import type { EditorWorkspaceRecord } from '../shared/editor-contracts.js';
import { activeDigestRequest, type DigestContentState } from '../shared/digest-contracts.js';
import type { GenerationAPI, GenerationArtifactView, GenerationState } from '../shared/generation-contracts.js';
import { plainText, type AssetRef } from '../editor-core/model.js';
import { DraftReading } from './draft-reading.js';
import { OcrResultsPanel } from './ocr-panel.js';
import { AsrResultsPanel } from './asr-panel.js';
import { creationStageLabel, generationReplacementBarrier, hasReadableCreationDocument, mayInstallGeneration } from './creation-workspace-helpers.js';
import { digestBlockReasons, digestReady } from './content-state.js';
import { useDevInfo } from './dev-info.js';
import { IconExternal, IconCheck } from './icons.js';
import './creation-workspace.css';

export interface CreationWorkspaceProps extends EditorWorkspaceProps {
 generation: GenerationAPI;
 digest?: DigestContentState;
 manualEntry?: boolean;
 requestError?: string;
 /** E4.3 §9b inline fixes for waiting states; wired from the shell's workbench APIs. */
 waitingActions?: { configure?(): Promise<unknown>; enableNetwork?(): Promise<unknown>; retryMedia?(): Promise<unknown> };
 onCancel(): Promise<void>;
 onRetryExtraction(): Promise<void>;
 onRenew(): Promise<void>;
}
function readableError(error: unknown): string {
 const value = error instanceof Error ? error.message : String(error);
 return value.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 700) || '操作未完成，已有稿件保持原样。';
}
/** A request view is not an editor document. System placeholders are never rendered as results. */
export function CreationWorkspace(props: CreationWorkspaceProps) {
 const { content, generation, api } = props, callbacks = useRef(props); callbacks.current = props;
 const devInfo = useDevInfo();
 const sessionId = useRef(`creation-${crypto.randomUUID()}`), mounted = useRef(true), requestId = useRef<string | null>(props.digest?.request?.id ?? null);
 const manualIntent = useRef(false), compositionActive = useRef(false), installRequest = useRef<string | null>(null), generationBarrier = useRef<EditorGenerationBarrier | null>(null), leaseHeld = useRef(false), leasePending = useRef<Promise<boolean> | null>(null);
 const [state, setState] = useState<GenerationState | null>(null), stateRef = useRef<GenerationState | null>(null);
 const [record, setRecord] = useState<EditorWorkspaceRecord | null>(null), recordRef = useRef<EditorWorkspaceRecord | null>(null);
 const [sourceRecord, setSourceRecord] = useState<EditorWorkspaceRecord | null>(null);
 const [artifact, setArtifact] = useState<GenerationArtifactView | null>(null), [candidate, setCandidate] = useState<GenerationArtifactView | null>(null);
 const [artifactError, setArtifactError] = useState(''), [candidateError, setCandidateError] = useState('');
 const [showCandidate, setShowCandidate] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
 const [startInEditMode, setStartInEditMode] = useState(false), [editorEpoch, setEditorEpoch] = useState(0), [renewPrompt, setRenewPrompt] = useState(false), [unknownPrompt, setUnknownPrompt] = useState(false);
 const [sourceTab, setSourceTab] = useState<'body' | 'images' | 'ocr' | 'asr'>('body');
 const [waitingSource, setWaitingSource] = useState(false);
 const saveBarrier = useRef<(() => Promise<boolean>) | null>(null), refreshPending = useRef(false), loadEpoch = useRef(0), artifactIdentity = useRef<string | null>(null), sourceIdentity = useRef<string | null>(null);
 const registerGenerationBarrier = useCallback((barrier: EditorGenerationBarrier) => { generationBarrier.current = barrier; return () => { if (generationBarrier.current === barrier) generationBarrier.current = null; }; }, []);
 const registerSaveBarrier = useCallback((barrier: () => Promise<boolean>) => { saveBarrier.current = barrier; return () => { if (saveBarrier.current === barrier) saveBarrier.current = null; }; }, []);
 function assignRecord(next: EditorWorkspaceRecord) { recordRef.current = next; setRecord(next); }
 async function refresh() {
  if (refreshPending.current) return; refreshPending.current = true;
  try {
   const next = await generation.status(content.id); if (!mounted.current) return;
   stateRef.current = next; requestId.current = next.requestId ?? callbacks.current.digest?.request?.id ?? null; setState(next);
   if (!next.authorized && !recordRef.current) {
    const existing = await api.open(content.id); if (!mounted.current) return;
    // Authorization may create a placeholder during open(). Read its origin again.
    const current = await generation.status(content.id); if (!mounted.current) return;
    if (existing.initialized) { setSourceRecord(existing); if (!current.authorized || hasReadableCreationDocument(current)) assignRecord(existing); }
   }
   // The canonical saved pair has its own validation and is independent of a
   // generated package's Markdown, manifest and provenance availability.
   if (next.target) {
    const target = next.target, current = recordRef.current;
    const changed = !current || current.bundle.workspace.id !== target.workspaceId || current.bundle.draft.revision !== target.draftRevision || current.bundle.map.revision !== target.mapRevision;
    const needsCurrent = hasReadableCreationDocument(next) && changed && (!current || !manualIntent.current);
    const needsSources = sourceIdentity.current !== `${target.workspaceId}:${next.sourceRevisionId}`;
    if (needsCurrent || needsSources) {
     try {
      const fresh = await api.load(target.workspaceId); if (!mounted.current) return;
      setSourceRecord(fresh); sourceIdentity.current = `${target.workspaceId}:${next.sourceRevisionId}`;
      if (needsCurrent && (!recordRef.current || !manualIntent.current)) {
       const barrier = generationBarrier.current;
       if (recordRef.current && barrier) {
        if (installRequest.current || barrier.lock()) {
         try { if (await barrier.reload(fresh)) assignRecord(fresh); }
         finally { barrier.unlock(); installRequest.current = null; }
        }
       } else { assignRecord(fresh); setEditorEpoch(value => value + 1); }
      }
     } catch (error) { if (mounted.current) setError(readableError(error)); }
    }
   }
   if (next.candidate && candidate?.id !== next.candidate.id) {
    try { const pair = await generation.candidate(content.id); if (mounted.current) { setCandidate(pair); setCandidateError(''); } }
    catch (error) { if (mounted.current) setCandidateError(`生成候选包无法读取：${readableError(error)} 当前保存稿仍可阅读和编辑。`); }
   } else if (!next.candidate && mounted.current) { setCandidate(null); setCandidateError(''); }
   if (next.currentArtifactId && artifactIdentity.current !== next.currentArtifactId) {
    try {
     const pair = await generation.artifact(content.id); if (!mounted.current) return;
     if (!pair?.installed || pair.id !== next.currentArtifactId) throw new Error('生成包与当前确切成果身份不符。');
     setArtifact(pair); artifactIdentity.current = pair.id; setArtifactError('');
    } catch (error) { if (mounted.current) { setArtifact(null); setArtifactError(`最近生成包无法读取：${readableError(error)} 当前保存稿独立保留；可保存或导出正文，并从确切保存正文重试更新内部 .md。`); } }
   }
   if (installRequest.current && (next.requestId !== installRequest.current || next.candidate || ['succeeded', 'cancelled', 'failed'].includes(next.state))) {
    generationBarrier.current?.unlock(); installRequest.current = null;
   }
  } catch (error) { if (mounted.current) setError(readableError(error)); }
  finally { refreshPending.current = false; }
 }
 const refreshRef = useRef(refresh); refreshRef.current = refresh;
 useEffect(() => { mounted.current = true; void refreshRef.current(); const timer = setInterval(() => void refreshRef.current(), 1200);
  return () => { mounted.current = false; ++loadEpoch.current; clearInterval(timer); void generation.release(content.id, sessionId.current).catch(() => {}); };
 }, [content.id, generation]);
 useEffect(() => { requestId.current = props.digest?.request?.id ?? stateRef.current?.requestId ?? null; }, [props.digest?.request?.id]);
 useEffect(() => generation.onBeforeInstall?.(async (contentId, incomingRequestId) => {
  if (contentId !== content.id) return true;
  if (manualIntent.current || compositionActive.current) return false;
  installRequest.current = incomingRequestId; let permitted = false;
  let barrier = generationBarrier.current;
  try {
   // A manual-entry record can have committed before its editor's registration.
   // Block new entry now, then let that commit install its synchronous input guard.
   if (recordRef.current && !barrier) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); barrier = generationBarrier.current; }
   if (recordRef.current && (!barrier || !barrier.lock())) return false;
   if (leasePending.current) await leasePending.current;
   if (manualIntent.current || compositionActive.current) return false;
   if (leaseHeld.current) { await generation.release(content.id, sessionId.current); leaseHeld.current = false; }
   // A cached stage may finish before the UI poll sees the authorization.
   const fresh = await generation.status(contentId);
   const allowed = fresh.state !== 'cancelled' && mayInstallGeneration(content.id, contentId, fresh.requestId, incomingRequestId, manualIntent.current || compositionActive.current);
   permitted = allowed;
   if (allowed) return true; // Keep input frozen until the installed pair is loaded.
   return false;
  } catch (error) { if (mounted.current) setError(readableError(error)); return false; }
  finally { if (!permitted) { barrier?.unlock(); installRequest.current = null; } }
 }), [content.id, generation]);

 async function protectEditingSession(): Promise<boolean> {
  if (installRequest.current) return false;
  if (leaseHeld.current) return true;
  if (leasePending.current) return leasePending.current;
  const operation = generation.touch(content.id, sessionId.current, false).then(() => {
   if (!mounted.current) return false; leaseHeld.current = true; return true;
  }).catch(error => { if (mounted.current) setError(readableError(error)); return false; }).finally(() => { if (leasePending.current === operation) leasePending.current = null; });
  leasePending.current = operation; return operation;
 }
 async function protectManualIntent(): Promise<boolean> {
  // Actual changes are sticky immediately, including the interval before IPC.
  const firstChange = !manualIntent.current; manualIntent.current = true;
  if (!firstChange && leaseHeld.current) return true;
  const previous = leasePending.current;
  const operation = (async () => {
   if (previous) await previous;
   await generation.touch(content.id, sessionId.current, true);
   if (!mounted.current) return false; leaseHeld.current = true; return true;
  })().catch(error => { if (mounted.current) setError(readableError(error)); return false; }).finally(() => { if (leasePending.current === operation) leasePending.current = null; });
  leasePending.current = operation; return operation;
 }
 function compositionActivity(active: boolean) {
  compositionActive.current = active;
  if (active) {
   if (manualIntent.current || leaseHeld.current || leasePending.current) return;
   const operation = generation.touch(content.id, sessionId.current, false).then(() => { leaseHeld.current = true; return true; }).catch(error => { if (mounted.current) setError(readableError(error)); return false; }).finally(() => { if (leasePending.current === operation) leasePending.current = null; });
   leasePending.current = operation;
  } else if (!manualIntent.current) {
   void (async () => { if (leasePending.current) await leasePending.current; if (!manualIntent.current && !compositionActive.current) { await generation.release(content.id, sessionId.current); leaseHeld.current = false; } })().catch(error => { if (mounted.current) setError(readableError(error)); });
  }
 }
 async function openManual() {
  if (busy || installRequest.current) return; const epoch = ++loadEpoch.current; setBusy(true); setError('');
  try {
   const opened = recordRef.current ?? await api.open(content.id, 'blank');
   if (!opened.initialized) throw new Error('尚未建立手工工作稿，请重试。');
   if (!await protectEditingSession() || !mounted.current || epoch !== loadEpoch.current || installRequest.current) return;
   assignRecord(opened); setStartInEditMode(true); setEditorEpoch(value => value + 1);
   setNotice('已进入编辑，修改会自动保存。');
  } catch (error) { if (mounted.current) setError(readableError(error)); } finally { if (mounted.current) setBusy(false); }
 }
 const initialManualEntry = useRef(false);
 useEffect(() => { if (props.manualEntry && !initialManualEntry.current) { initialManualEntry.current = true; void openManual(); } }, [props.manualEntry]);
 async function action(fn: () => Promise<unknown>) {
  if (busy) return; setBusy(true); setError(''); try { await fn(); await refreshRef.current(); }
  catch (error) { if (mounted.current) setError(readableError(error)); } finally { if (mounted.current) setBusy(false); }
 }
 async function adoptCandidate() {
  const pair = candidate; if (!pair || !stateRef.current?.target) return;
  // A source dialog may own an unsaved correction; use all leave guards as well as
  // the editor barrier before replacing the current pair (the parent runs guards on back).
  if (!await generationReplacementBarrier({ save: saveBarrier.current ?? undefined, protect: protectManualIntent, release: async () => { await generation.release(content.id, sessionId.current); leaseHeld.current = false; } })) { setError('当前稿尚未保存，请先完成中文输入并重试保存。没有替换或导出旧版本。'); return; }
  const fresh = await generation.status(content.id);
  if (!fresh.target || fresh.candidate?.id !== pair.id) throw new Error('候选或当前目标版本已变化，请重新查看后替换。');
  // Manual epoch remains sticky. The view is inert while this exact target is read.
  const protectedState = await generation.status(content.id); if (!protectedState.target) throw new Error('当前工作稿不可用。');
  await generation.adopt(content.id, pair.id, protectedState.target);
  const next = await generation.status(content.id); if (!next.target || !mounted.current) return;
  const opened = await api.load(next.target.workspaceId); if (!mounted.current) return;
  assignRecord(opened); setEditorEpoch(value => value + 1); setShowCandidate(false); setStartInEditMode(false);
  artifactIdentity.current = null; setNotice('已换成新版本；替换前的图与文稿保留，可恢复上一版。');
 }
 async function undoAdoption() {
  if (!generation.undoAdoption) return;
  if (!await generationReplacementBarrier({ save: saveBarrier.current ?? undefined, release: async () => { if (leasePending.current) await leasePending.current; await generation.release(content.id, sessionId.current); leaseHeld.current = false; } })) throw new Error('当前稿尚未保存，不能恢复上一版。');
  const fresh = await generation.status(content.id); if (!fresh.target) return;
  await generation.undoAdoption(content.id, fresh.target);
  const next = await generation.status(content.id); if (!next.target || !mounted.current) return;
  assignRecord(await api.load(next.target.workspaceId)); setEditorEpoch(value => value + 1); artifactIdentity.current = null;
  setNotice('已恢复上一版；本次生成版本和引用仍然保留。');
 }
 const label = creationStageLabel(state, props.digest), tasks = state?.tasks ?? [], completed = tasks.filter(task => task.state === 'succeeded').length;
 const terminal = state?.state === 'succeeded' || state?.state === 'cancelled';
 const canRetry = !!props.digest?.request && !terminal && !['preparing', 'queued', 'running', 'publishing'].includes(state?.state ?? '');
 // 一条状态只显示一条信息：其余消息、工程元数据和次级操作都收进「详情」。
 const messages = ([
  props.requestError ? { role: 'alert', text: props.requestError } : null,
  error ? { role: 'alert', text: error } : null,
  artifactError ? { role: 'alert', text: artifactError, testId: 'creation-artifact-error' } : null,
  candidateError ? { role: 'alert', text: candidateError, testId: 'creation-candidate-error' } : null,
  state?.error ? { role: 'alert', text: state.error } : null,
  notice ? { role: 'status', text: notice } : null,
 ] as ({ role: string; text: string; testId?: string } | null)[]).filter((m): m is NonNullable<typeof m> => !!m);
 const [firstMessage, ...restMessages] = messages;
 const retry = () => { if (state?.state === 'result-unknown') setUnknownPrompt(true); else void action(async () => { await props.onRetryExtraction(); await generation.retry(content.id); }); };
 const waitingState = props.digest?.stages.find(stage => stage.state.startsWith('waiting-'))?.state ?? (props.digest?.request?.state.startsWith('waiting-') ? props.digest.request.state : undefined);
 const waitingFix = waitingState && state?.errorCode !== 'input-limit' && (waitingState === 'waiting-configuration' || (waitingState as string) === 'waiting-model' ? props.waitingActions?.configure && { label: '去配置', apply: props.waitingActions.configure } : waitingState === 'waiting-network' ? props.waitingActions?.enableNetwork && { label: '开启 AI 处理', apply: props.waitingActions.enableNetwork } : waitingState === 'waiting-files' ? props.waitingActions?.retryMedia && { label: '重新下载资源', apply: props.waitingActions.retryMedia } : undefined);
 const details = <details className="e3-processing-details"><summary>详情</summary><div>
  {restMessages.map((m, index) => <p key={index} role={m.role as 'alert' | 'status'} {...(m.testId ? { 'data-testid': m.testId } : {})}>{m.text}</p>)}
  {props.digest?.request?.sourceUpdated && <p>来源已更新；本次请求范围保持不变。需要新资料时，请明确按当前资料重新消化。</p>}
  {state && state.markdown.state === 'failed' && <p className="e3-file-status"><span>导出可能不是最新版本</span>{generation.refreshMarkdown && <button disabled={busy} onClick={() => void action(async () => { if (saveBarrier.current && !await saveBarrier.current()) throw new Error('正文保存尚未完成，请重试保存。'); await generation.refreshMarkdown!(content.id); })}>重试</button>}</p>}
  {state?.target && <p>当前稿：{state.currentArtifactId ? 'AI 整理稿，可编辑校对' : state.target.managed && state.target.manualEpoch === 0 ? hasReadableCreationDocument(state) ? '已保存稿件' : '等待生成' : '人工稿受保护'}</p>}
  {!state?.model && <p>尚未选定可用生成模型。</p>}
  {devInfo && state && <p>请求 {state.requestId ?? '尚未建立'} · 来源 {state.sourceRevisionId ?? '准备中'}</p>}
  {devInfo && state?.target && <p>当前正文版本 {state.target.draftRevision} / 导图版本 {state.target.mapRevision}</p>}
  {devInfo && state?.model && <p>生成模型 {state.model.model} · 配置 {state.model.configurationSha256}</p>}
  {devInfo && artifact && <p>最近一次生成 {artifact.id} · 来源 {artifact.artifact.sourceRevisionId}</p>}
  <div className="e3-stage-actions">
   {props.digest && activeDigestRequest(props.digest) && <button disabled={busy} onClick={() => void action(props.onCancel)}>取消处理</button>}
   {canRetry && <button disabled={busy} onClick={retry}>重试</button>}
   <button disabled={busy} onClick={() => setRenewPrompt(true)}>重新消化</button>
   {generation.undoAdoption && state?.canRestorePrevious && <button className="e3-undo-adoption" disabled={busy} onClick={() => void action(undoAdoption)}>恢复上一版</button>}
  </div>
 </div></details>;
 const failed = state?.state === 'failed' || state?.state === 'result-unknown';
 const processingState = !!state && !terminal && !failed;
 const statusBar = candidate ? <div className="notice-bar" data-testid="creation-status" data-generation-state={state?.state ?? 'pending'}>
   <span>AI 新版本已生成，你的修改保持不变。</span>{firstMessage && <span role={firstMessage.role as 'alert' | 'status'} {...(firstMessage.testId ? { 'data-testid': firstMessage.testId } : {})}>{firstMessage.text}</span>}
   <button className="btn-primary" data-testid="creation-candidate-switch" disabled={busy} onClick={() => void action(adoptCandidate)}>切换到 AI 新版本</button><button className="btn" data-testid="creation-candidate-open" disabled={busy} onClick={() => setShowCandidate(true)}>查看</button>{waitingFix && <button className="btn" disabled={busy} onClick={() => void action(async () => { await waitingFix.apply(); })}>{waitingFix.label}</button>}{details}
  </div>
 : failed ? <div className="notice-bar danger" data-testid="creation-status" data-generation-state={state?.state}>
   <span><strong>{label}</strong>{state?.error ? `：${state.error}` : ''}</span>{firstMessage && firstMessage.text !== state?.error && <span role={firstMessage.role as 'alert' | 'status'} {...(firstMessage.testId ? { 'data-testid': firstMessage.testId } : {})}>{firstMessage.text}</span>}
   {canRetry && <button className="btn-primary" disabled={busy} onClick={retry}>重试</button>}{waitingFix && <button className="btn" disabled={busy} onClick={() => void action(async () => { await waitingFix.apply(); })}>{waitingFix.label}</button>}{details}
  </div>
 : <div className="e3-status-bar e3-status-line" data-testid="creation-status" data-generation-state={state?.state ?? 'pending'}>
   {processingState ? <><strong>{label}</strong>{tasks.length > 0 && <ol className="e3-status-steps">{tasks.map(task => <li key={task.id} data-state={task.state}>{task.stage === 'map' ? '导图' : '整理'}{task.state === 'succeeded' ? <IconCheck size={12} /> : task.state === 'running' ? '…' : task.state === 'failed' ? ' ✗' : ''}</li>)}</ol>}{props.digest && activeDigestRequest(props.digest) && <button className="btn" disabled={busy} onClick={() => void action(props.onCancel)}>取消</button>}</>
    : <><span>{state ? <><IconCheck size={12} /> {label}</> : '本条收藏 · 等待明确请求'}</span>{tasks.length > 0 && <span className="e3-muted">步骤 {completed}/{tasks.length}</span>}</>}
   {firstMessage && <span role={firstMessage.role as 'alert' | 'status'} {...(firstMessage.testId ? { 'data-testid': firstMessage.testId } : {})}>{firstMessage.text}</span>}
   {waitingFix && <button className="btn" disabled={busy} onClick={() => void action(async () => { await waitingFix.apply(); })}>{waitingFix.label}</button>}
   {details}
  </div>;
 const sources = <div className="e3-pending-sources"><div className="e3-source-tabs" role="tablist" aria-label="来源资料类型"><div className="segmented">{(['body', 'images', 'ocr', 'asr'] as const).map(key => <button key={key} role="tab" aria-selected={sourceTab === key} onClick={() => setSourceTab(key)}>{({ body: '原文／简介', images: '原图', ocr: '图片文字', asr: content.kind === 'audio' ? '音频文字稿' : '视频文字稿' })[key]}</button>)}</div></div><div className="e3-source-body">
  {sourceTab === 'body' && <><p className="e3-muted">{sourceRecord ? '本工作区保留的来源版本，简介不代表完整转录。' : '来源范围尚在准备，以下为当前收藏取得的原文／简介。'}</p><div className="e3-original-copy">{sourceRecord?.bundle.sources.length ? sourceRecord.bundle.sources.map(source => <DraftReading key={source.sourceRevisionId} blocks={source.blocks} assetUrl={ref => api.assetUrl(sourceRecord.bundle.workspace.id, ref)} />) : content.body || '尚未取得来源正文。'}</div><button onClick={() => void props.openOriginal()}>查看原链接 <IconExternal size={12} /></button></>}
  {sourceTab === 'images' && <>{sourceRecord?.bundle.assets.length ? sourceRecord.bundle.assets.map((asset, index) => <figure key={`${asset.id}@${asset.version}`}><img src={api.assetUrl(sourceRecord.bundle.workspace.id, { assetId: asset.id, version: asset.version })} alt={`固定来源图片 ${index + 1}`} />{devInfo && <figcaption>固定图片 {index + 1} · {asset.sha256.slice(0, 12)}</figcaption>}</figure>) : <p>尚无已固定的本地图片。</p>}</>}
  {sourceTab === 'ocr' && (props.ocrApi && props.onOpenOcr ? <OcrResultsPanel pipelineComplete={state?.state === 'succeeded'} api={props.ocrApi} contentId={content.id} onOpen={props.onOpenOcr} waitingAsr={content.kind === 'video' || content.kind === 'audio'} /> : <p>当前运行未接入图片识别能力。</p>)}
  {sourceTab === 'asr' && (props.asrApi && props.onOpenAsr ? <AsrResultsPanel pipelineComplete={state?.state === 'succeeded'} api={props.asrApi} contentId={content.id} onOpen={props.onOpenAsr} /> : <p>当前运行未接入音视频转录能力。</p>)}
 </div></div>;
 return <>
  {record ? <EditorWorkspace key={`${content.id}:${editorEpoch}`} {...props} interactionBlocked={busy} initialRecord={record} pipelineComplete={state?.state === 'succeeded'} creationMode generatedDraft={!!state?.currentArtifactId} startInEditMode={startInEditMode} beforeEdit={protectEditingSession} onManualChange={() => { void protectManualIntent(); }} onCompositionActivity={compositionActivity} registerGenerationBarrier={registerGenerationBarrier} registerSaveBarrier={registerSaveBarrier} headerExtra={statusBar} moreMenu={<><button disabled={busy} onClick={() => setRenewPrompt(true)}>重新消化</button>{generation.undoAdoption && state?.canRestorePrevious && <button disabled={busy} onClick={() => void action(undoAdoption)}>恢复上一版</button>}<button disabled={busy} onClick={() => void openManual()}>手动整理</button>{devInfo && <button onClick={() => { (document.querySelector('.e3-processing-details') as HTMLDetailsElement | null)?.setAttribute('open', ''); }}>处理记录</button>}{props.moreMenu}</>} draftReferences={artifact?.artifact.blockSourceRefs} draftReferenceDocument={artifact?.artifact.draft} onSaved={() => { props.onSaved?.(); void refreshRef.current(); }} />
   : <section className="e3-creation-workspace" aria-label="笔记" data-content-id={content.id}><header className="e3-header"><button onClick={props.onBack}>← 返回收藏</button><div><p>笔记</p><h1>{content.title || '无标题收藏'}</h1></div><button className="btn" disabled={busy} data-testid="creation-manual" onClick={() => void openManual()}>手动整理</button></header>{statusBar}{(() => { const hasRequest = !!props.digest?.request; const stepOf = (names: string[]) => { if (!hasRequest) return 'pending'; const named = (props.digest?.stages ?? []).filter(stage => names.includes(stage.name)); const list = named.filter(stage => stage.required); if (!list.length) return named.length ? 'not-required' : 'pending'; if (list.some(stage => stage.state === 'failed' || stage.state === 'result-unknown')) return 'failed'; if (list.some(stage => stage.state.startsWith('waiting-'))) return 'waiting'; if (list.some(stage => stage.state === 'running' || stage.state === 'queued')) return 'running'; return list.every(stage => stage.state === 'succeeded') ? 'succeeded' : 'pending'; }; const requestWaiting = props.digest?.request?.state === 'waiting-files'; const steps: { label: string; state: string }[] = [
    { label: '下载', state: !hasRequest ? 'pending' : requestWaiting ? 'waiting' : 'succeeded' },
    { label: '识别', state: stepOf(['ocr', 'asr']) },
    { label: '整理', state: stepOf(['organize', 'markdown']) },
    { label: '导图', state: stepOf(['map']) },
   ]; const current = steps.find(step => step.state === 'running' || step.state === 'waiting') ?? steps.find(step => step.state === 'failed') ?? steps.find(step => step.state === 'pending') ?? steps[steps.length - 1];
   // E4.9: no request + source files not digest-ready is an honest blocked
   // state with reasons and a way forward — not a fake "消化中" wait.
   const blocked = !hasRequest && !digestReady(content);
   const blockReasons = blocked ? digestBlockReasons(content) : [];
   return <div className="e3-waiting-layout"><div className="e3-waiting-card"><ol className="e3-waiting-steps">{steps.map((step, index) => <li key={step.label} data-state={step.state} aria-current={step === current ? 'step' : undefined}><span className="e3-step-dot">{step.state === 'succeeded' || step.state === 'not-required' ? '✓' : index + 1}</span>{step.label}</li>)}</ol><h2>{blocked ? '暂时不能消化' : label}</h2><p>{blocked ? '本条收藏的来源资料还不完整，取得完整后才能消化。' : current.state === 'waiting' ? '需要先处理上面的提示，消化才会继续。' : current.state === 'failed' ? '处理没有完成，已有资料保持原样。' : hasRequest ? '本条收藏正在消化中，完成后导图与文稿会在这里出现。' : '本条收藏还没有消化请求。'}</p>{blocked && <ul className="e3-block-reasons">{blockReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}<div className="e3-waiting-actions">{blocked && props.waitingActions?.retryMedia && <button className="btn" disabled={busy} data-testid="creation-refetch" onClick={() => void action(async () => { await props.waitingActions!.retryMedia!(); setNotice('已重新排队，取得完整正文后可以继续消化。'); })}>重新获取正文</button>}{!hasRequest && !blocked && <button className="btn" disabled={busy} onClick={() => void action(props.onDigestRequest)}>开始消化</button>}{waitingFix && <button className="btn" disabled={busy} onClick={() => void action(async () => { await waitingFix.apply(); })}>{waitingFix.label}</button>}<button className="btn-ghost" data-testid="creation-sources" onClick={() => setWaitingSource(value => !value)}>{waitingSource ? '收起来源资料' : '先看来源资料'}</button></div></div>{waitingSource && sources}</div>; })()}</section>}
  {showCandidate && candidate && <CandidateDialog pair={candidate} sourceRecord={sourceRecord} generation={generation} contentId={content.id} busy={busy} error={error} onClose={() => { if (!busy) setShowCandidate(false); }} onAdopt={() => void action(adoptCandidate)} />}
  {renewPrompt && <ConfirmDialog title="重新消化" onClose={() => setRenewPrompt(false)}><p>这会明确授权本条收藏当前确定的来源范围。原请求、人工稿、校对与引用保留。新增媒体不会偷偷加入旧请求；可能产生新的模型调用费用。</p><button disabled={busy} data-testid="creation-renew-confirm" onClick={() => { setRenewPrompt(false); void action(props.onRenew); }}>重新消化</button></ConfirmDialog>}
  {unknownPrompt && <ConfirmDialog title="确认重试" onClose={() => setUnknownPrompt(false)}><p>上次请求可能已扣费但没收到结果。再试一次会重新计费。</p><div className="e3-dialog-actions"><button disabled={busy} onClick={() => setUnknownPrompt(false)}>先不处理</button><button className="btn-primary" disabled={busy} onClick={() => { setUnknownPrompt(false); void action(() => generation.retry(content.id, true)); }}>再试一次</button></div></ConfirmDialog>}
 </>;
}
function ConfirmDialog({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
 const dialog = useRef<HTMLDialogElement>(null);
 useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); }; }, []);
 return <dialog ref={dialog} className="e3-confirm-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}><h2>{title}</h2>{children}<button onClick={onClose}>返回当前稿</button></dialog>;
}
function CandidateDialog({ pair, sourceRecord, generation, contentId, busy, error, onClose, onAdopt }: { pair: GenerationArtifactView; sourceRecord: EditorWorkspaceRecord | null; generation: GenerationAPI; contentId: number; busy: boolean; error?: string; onClose(): void; onAdopt(): void }) {
 const devInfo = useDevInfo();
 const map = pair.artifact.map, [expanded, setExpanded] = useState(new Set(Object.keys(map.nodes))), [reference, setReference] = useState('');
 const sourceWarnings = [...new Set(pair.artifact.review.sourceWarnings.map(warning => warning.trim()).filter(Boolean))];
 const nodes = (id: string): React.ReactNode => { const node = map.nodes[id]; return <li key={id}><button aria-expanded={node.children.length ? expanded.has(id) : undefined} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}>{plainText(node.title)}</button>{node.notes && <p>{node.notes}</p>}{node.sourceRefs.length > 0 && <button onClick={() => setReference(JSON.stringify(node.sourceRefs, null, 2))}>确切引用 {node.sourceRefs.length}</button>}{expanded.has(id) && !!node.children.length && <ul>{node.children.map(nodes)}</ul>}</li>; };
 const assetUrl = (ref: AssetRef) => { const asset = sourceRecord?.bundle.assets.find(asset => asset.id === ref.assetId && asset.version === ref.version), relative = asset && pair.files.find(file => file.sha256 === asset.sha256 && file.relativePath.startsWith('assets/'))?.relativePath; return relative && generation.assetUrl ? generation.assetUrl(contentId, pair.id, relative) : ''; };
 return <ConfirmDialog title="AI 新版本" onClose={onClose}><p>导图和文稿来自同一次生成；确认前不会替换当前稿。</p>{devInfo && <details><summary>处理记录与版本</summary><p>请求 {pair.requestId} · 来源 {pair.artifact.sourceRevisionId} · 正文 {pair.artifact.draft.revision} / 导图 {pair.artifact.map.revision} · 两者使用同一整理结果 {pair.artifact.organizedSha256}。</p></details>}<details data-testid="creation-source-review"><summary>来源校对说明{sourceWarnings.length > 0 ? `（${sourceWarnings.length} 项）` : ''}</summary><p>{pair.artifact.review.reason}</p>{sourceWarnings.length > 0 && <ul>{sourceWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}</details>{error && <p role="alert" className="e1-warning">{error}</p>}<div className="e3-candidate-panes"><section><h3>新导图</h3><ul className="e3-candidate-tree">{nodes(map.rootId)}</ul></section><section><h3>新文稿</h3><DraftReading blocks={pair.artifact.draft.blocks} assetUrl={assetUrl} onReference={id => setReference(JSON.stringify(pair.artifact.blockSourceRefs[id] ?? [], null, 2))}/></section></div>{reference && <details open><summary>确切版本引用</summary><pre>{reference}</pre></details>}<p>当前稿会先保存为历史版本，可随时恢复上一版。</p><div className="e3-dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>暂不替换</button><button className="btn-primary" disabled={busy} data-testid="creation-candidate-adopt" onClick={onAdopt}>换成新版本</button></div></ConfirmDialog>;
}
