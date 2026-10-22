import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from 'prosemirror-view';
import { undo as pmUndo, redo as pmRedo } from 'prosemirror-history';
import { clone, isSafeLink, plainText, pointSlice, textBlocks, type AssetMetadata, type AssetRef, type DraftBlock, type DraftDocument, type MindMapNode, type ResolvedReference, type SourceReference, type TextRun } from '../editor-core/model.js';
import { canExecute, copyBranch, createEditorState, execute, headingTreePreview, type BranchClipboard, type EditorCommand, type EditorState, type HeadingTreePreview } from '../editor-core/commands.js';
import { changeListIndent, endInputHistory, findText, fromPM, insertImage, mountEditor, replaceEditorBlocks, selectedBlockRange, setSafeLink, setTextBlock, toggleInlineMark, wrapBlock, type Block } from '../editor-core/prosemirror.js';
import { SaveCoordinator } from '../editor-core/save-coordinator.js';
import { centerBounds, DRAG_THRESHOLD, dropAt, fitBounds, layoutTree, MAX_ZOOM, MIN_ZOOM, resizedViewport, screenToWorld, wheelZoomAt, zoomAt, type DropPreview, type Point, type Size, type TreeLayout, type Viewport } from '../editor-core/canvas.js';
import type { ContentRecord } from '../shared/contracts.js';
import { PLATFORM_NAMES } from '../shared/platforms.js';
import type { EditorAPI, EditorExportKind, EditorExportMediaPreview, EditorExportProgress, EditorHistory, EditorInitialization, EditorInitializationKind, EditorWorkspaceRecord } from '../shared/editor-contracts.js';
import { blockById, excerptTitle, externalTextPreview, highlightPieces, readSourceSelection, revealNode, sourceRangeReference, sourceSubtitleVersions, treeOrder, visibleTree, type DOMTextSelection } from './editor-workspace-helpers.js';
import { currentMedia, mediaLabel } from './content-state.js';
import type { OcrAPI } from '../shared/ocr-contracts.js';
import { OcrResultsPanel, type OcrOpenTarget } from './ocr-panel.js';
import type { OcrReferenceHandler } from './ocr-workspace.js';
import type { AsrAPI } from '../shared/asr-contracts.js';
import { AsrResultsPanel, type AsrOpenTarget } from './asr-panel.js';
import type { AsrReferenceHandler } from './asr-workspace.js';
import { dispatchSaveShortcut, sourceWorkspaceOwnsShortcut } from './save-shortcut.js';
import { DraftReading, exactDraftReferenceVersion } from './draft-reading.js';
import { IconExternal, IconSplit, IconMap, IconDocument, IconMore, IconExport, IconZoomIn, IconZoomOut, IconFitView, IconTarget, IconQuestion, IconCard } from './icons.js';
import { buildKnowledgeCard, viewpointLayout } from './knowledge-card.js';
import { KnowledgeCardArt } from './knowledge-card-view.js';
import type { KnowledgeCardPayload, KnowledgeCardTarget } from '../shared/knowledge-card.js';
import { listPresentationPlugin, nodePresentationWidth } from './editor-presentation.js';
import { ExportMediaSummary, ExportProgress } from './export-dialog-content.js';
import './editor-workspace.css';

/** A renderer-only handshake: freeze synchronously before acknowledging installation. */
export interface EditorGenerationBarrier {
  lock(): boolean;
  unlock(): void;
  reload(record: EditorWorkspaceRecord): Promise<boolean>;
}
export interface EditorWorkspaceProps {
  /** E3 only. Merely reading a generated document must not create manual intent. */
  creationMode?: boolean;
  /** Label a derived AI draft honestly; existing manual-only work is not AI output. */
  generatedDraft?: boolean;
  pipelineComplete?: boolean;
  startInEditMode?: boolean;
  interactionBlocked?: boolean;
  beforeEdit?(): Promise<boolean>;
  onManualChange?(): void;
  onCompositionActivity?(active: boolean): void;
  registerGenerationBarrier?(barrier: EditorGenerationBarrier): () => void;
  registerSaveBarrier?(barrier: () => Promise<boolean>): () => void;
  headerExtra?: React.ReactNode;
  /** Creation-mode extras merged into the header ⋯ menu (重新消化, 恢复上一版, 手动整理, 处理记录). */
  moreMenu?: React.ReactNode;
  draftReferences?: Record<string, SourceReference[]>;
  draftReferenceDocument?: DraftDocument;
  initialRecord?: EditorWorkspaceRecord;
  content: ContentRecord; api: EditorAPI; onBack(): void; onDigestRequest(): Promise<void>; onDigestProgress?(): void; onRemoveFromDigestLibrary?(): Promise<void>; onMarkDone?(): Promise<void>;
  digestStatus?: { label: string; active: boolean; inLibrary: boolean; legacy?: boolean };
  mediaUrl(id: number): string; openOriginal(): Promise<void>;
  registerLeaveGuard?(guard: () => Promise<boolean>): () => void; onSaved?(): void;
  ocrApi?: OcrAPI; onOpenOcr?(target: OcrOpenTarget): void; registerOcrReferenceHandler?(contentId: number, handler: OcrReferenceHandler): () => void;
  asrApi?: AsrAPI; onOpenAsr?(target: AsrOpenTarget): void; registerAsrReferenceHandler?(contentId: number, handler: AsrReferenceHandler): () => void;
}
interface CachedWorkspaceSession { state: EditorState; draftRevision: number; mapRevision: number; collapsed: string[]; split: number; display: 'split' | 'map' | 'document'; mapView: 'map' | 'outline'; rightTab: 'draft' | 'source' }
/** Window-session only. Never persisted or advertised as crash recovery. Dirty content is excluded. */
const workspaceSessions = new Map<string, CachedWorkspaceSession>();

const date = (time: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time);
function message(error: unknown, fallback = '操作未完成，当前稿仍然保留。请重试。'): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/root|根节点/i.test(text)) return '根节点不能被删除、移动或插入同级。';
  if (/descendant|cycle|自身|后代/i.test(text)) return '不能把节点移入自身或后代。';
  if (/preview.*变化|预览版本|没有 H1|一次只能|请缩小|选区|剪贴板|最多粘贴/.test(text)) return text;
  if (/conflict|冲突/i.test(text)) return '磁盘上已有更新版本。当前稿保留，请查看已保存版本后决定恢复。';
  if (/missing|not found|损坏|缺失|resource|asset/i.test(text)) return '所需本地资料缺失或无法读取，请检查资源后重试。';
  return fallback;
}
function Runs({ runs }: { runs: TextRun[] }) { return <>{runs.map((run, index) => <span key={index} style={{ fontWeight: run.bold === undefined ? undefined : run.bold ? 700 : 400, fontStyle: run.italic === undefined ? undefined : run.italic ? 'italic' : 'normal', fontFamily: run.code ? 'monospace' : undefined, textDecoration: run.href ? 'underline' : undefined }}>{run.text}</span>)}</>; }
interface RichProps {
  readOnly?: boolean;
  blocks: DraftBlock[]; title?: boolean; inheritedBold?: boolean; inheritedItalic?: boolean;
  onChange(blocks: DraftBlock[], view: EditorView): void; onCommit?(): void; onCancel?(): void;
  onBlur?(): void; onComposition?(value: boolean): void; assetUrl?(ref: AssetRef): string; onUndo?(): void; onRedo?(): void; onPasteWarning?(value: string): void; ready?(view: EditorView | null): void;
}
/** A live ProseMirror instance belongs to this workspace, never to the global collection poll. */
function RichEditor(props: RichProps) {
  const host = useRef<HTMLDivElement>(null), callbacks = useRef(props); callbacks.current = props;
  const instance = useRef<EditorView | null>(null);
  useEffect(() => {
    const view = mountEditor(host.current!, props.blocks as Block[], { title: props.title, inheritedBold: props.inheritedBold, inheritedItalic: props.inheritedItalic, assetUrl: ref => callbacks.current.assetUrl?.(ref) || '', onUndo: props.onUndo ? () => callbacks.current.onUndo?.() : undefined, onRedo: props.onRedo ? () => callbacks.current.onRedo?.() : undefined, onPasteWarning: value => callbacks.current.onPasteWarning?.(value), onChange: (blocks, current) => callbacks.current.onChange(blocks as DraftBlock[], current), onCommit: () => callbacks.current.onCommit?.(), onCancel: () => callbacks.current.onCancel?.(), onBlur: () => callbacks.current.onBlur?.(), onComposition: value => callbacks.current.onComposition?.(value) });
    if (!props.title) view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, listPresentationPlugin()] }));
    instance.current = view; view.setProps({ editable: () => !callbacks.current.readOnly });
    callbacks.current.ready?.(view); if (props.title) view.focus();
    return () => { instance.current = null; callbacks.current.ready?.(null); view.destroy(); };
  }, []);
  useEffect(() => { instance.current?.setProps({ editable: () => !callbacks.current.readOnly }); }, [props.readOnly]);
  return <div className={props.title ? 'e1-title-editor' : 'e1-body-editor'} ref={host} />;
}
function Modal({ title, children, onCancel, className = '' }: { title: string; children: React.ReactNode; onCancel(): void; className?: string }) {
  const host = useRef<HTMLDivElement>(null), cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, element = host.current!;
    const controls = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(e => e.getClientRects().length);
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current(); }
      if (event.key === 'Tab') { const items = controls(), first = items[0], last = items.at(-1); if (!first) return;
        if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="e1-modal-backdrop"><div className={`e1-modal ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={host}><h2>{title}</h2>{children}</div></div>;
}

export function EditorWorkspace(props: EditorWorkspaceProps) {
  const [record, setRecord] = useState<EditorWorkspaceRecord | null>(null), [initialization, setInitialization] = useState<EditorInitialization | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function open(kind?: EditorInitializationKind) { setBusy(true); setError(''); try { const result = await props.api.open(props.content.id, kind); if (result.initialized) { setRecord(result); setInitialization(null); } else setInitialization(result); } catch (error) { setError(message(error, '无法打开整理工作区。已保存资料不会受影响，请重试。')); } finally { setBusy(false); } }
  useEffect(() => { if (props.initialRecord) setRecord(props.initialRecord); else void open(); }, [props.content.id, props.initialRecord]);
  if (record) return <WorkspaceReady key={record.bundle.workspace.id} {...props} record={record} />;
  return <section className="e1-workspace e1-opening" aria-label="手动整理"><header className="e1-header"><button onClick={props.onBack}>← 返回阅读</button><h1>手动整理</h1></header><div className="e1-initialization"><p className="e1-eyebrow">把收藏，变成自己的。</p><h2>{initialization ? '从哪里开始写？' : '正在打开工作区…'}</h2><p>来源资料保持只读。选择后创建你的整理稿。</p>{error && <p className="e1-error" role="alert">{error}<button disabled={busy} onClick={() => void open()}>重试</button></p>}{initialization && <div className="e1-initialization-choices"><button disabled={busy || !initialization.available.source} onClick={() => void open('source')}><b>复制来源正文</b><span>{initialization.available.source ? '取得的正文或简介，不代表音视频转录' : '尚未取得来源正文'}</span></button><button disabled={busy || !initialization.available.subtitle} onClick={() => void open('subtitle')}><b>复制已取得字幕</b><span>{initialization.available.subtitle ? '已保存的旧字幕，仅定位文字' : '尚未取得字幕'}</span></button><button disabled={busy} onClick={() => void open('blank')}><b>空白整理稿</b><span>直接写自己的理解，根节点使用收藏标题</span></button></div>}</div></section>;
}

interface CanvasGesture { pointerId: number; workspaceId: string; kind: 'pan' | 'node'; nodeId?: string; start: Point; last: Point; startViewport: Viewport; active: boolean }
function WorkspaceReady(props: EditorWorkspaceProps & { record: EditorWorkspaceRecord }) {
  const { api, content } = props; const callbacks = useRef(props); callbacks.current = props;
  const [, redraw] = useState(0), update = useCallback(() => redraw(value => value + 1), []);
  const coordinator = useRef<SaveCoordinator | null>(null);
  if (!coordinator.current) coordinator.current = new SaveCoordinator({ load: async id => (await api.load(id)).bundle, saveAtomic: requests => api.save(requests) }, update);
  const saves = coordinator.current;
  const [state, setState] = useState<EditorState | null>(null), stateRef = useRef<EditorState | null>(null);
  const [record, setRecord] = useState(props.record), recordRef = useRef(props.record);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [readOnly, setReadOnly] = useState(!!props.creationMode && !props.startInEditMode), readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;
  const [draftReading, setDraftReading] = useState(!!props.creationMode && !props.startInEditMode), viewDraftReading = useRef(draftReading); viewDraftReading.current = draftReading;
  const editLease = useRef<Promise<boolean> | null>(null), installationLocked = useRef(false), workspaceHost = useRef<HTMLElement>(null), installationFocus = useRef<HTMLElement | null>(null);
  async function beginEditing(): Promise<boolean> {
    if (installationLocked.current) return false;
    if (!readOnlyRef.current) return true;
    if (editLease.current) return editLease.current;
    const operation = (async () => {
      try { if (callbacks.current.beforeEdit && !await callbacks.current.beforeEdit()) return false;
        if (!mounted.current) return false; readOnlyRef.current = false; setReadOnly(false); return true;
      } catch (error) { setError(message(error, '编辑保护尚未保存，请重试进入编辑。')); return false; }
      finally { editLease.current = null; }
    })(); editLease.current = operation; return operation;
  }
  function requireEditing(): boolean { if (installationLocked.current) return false; if (!readOnlyRef.current) return true; setNotice('当前为阅读模式。请先点击「编辑」后再修改。'); return false; }
  async function toggleDraftReading() {
    if (!canSwitchEditorView()) return;
    if (!draftReading) { flushBody(); setDraftReading(true); }
    else if (await beginEditing()) setDraftReading(false);
  }
  const [userTitle, setUserTitle] = useState(props.record.bundle.workspace.userTitle), userTitleRef = useRef(userTitle), savedUserTitle = useRef(userTitle), titleSaving = useRef<Promise<boolean> | null>(null);
  const [mapView, setMapView] = useState<'map' | 'outline'>('map'), [rightTab, setRightTab] = useState<'draft' | 'source'>('draft'), [sourceTab, setSourceTab] = useState<'body' | 'subtitle' | 'images' | 'ocr' | 'asr' | 'media'>('body');
  const [subtitleVersion, setSubtitleVersion] = useState<string | null>(null);
  const [display, setDisplay] = useState<'split' | 'map' | 'document'>('split'), [split, setSplit] = useState(60), splitHost = useRef<HTMLDivElement>(null), splitPointer = useRef<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()), collapsedRef = useRef(collapsed); collapsedRef.current = collapsed;
  const [nodePanel, setNodePanel] = useState(false), [titleId, setTitleId] = useState<string | null>(null), titleSession = useRef<string | null>(null), titleDraft = useRef<DraftBlock[]>([]), titleView = useRef<EditorView | null>(null);
  const bodyView = useRef<EditorView | null>(null), bodyDraft = useRef<DraftDocument | null>(null), bodyBase = useRef<DraftDocument | null>(null), applyingBody = useRef(false);
  const composing = useRef(new Set<string>()), [compositionCount, setCompositionCount] = useState(0);
  const [reference, setReference] = useState<{ ref: SourceReference; resolved: ResolvedReference } | null>(null), referenceHost = useRef<HTMLElement>(null), sourceHost = useRef<HTMLDivElement>(null), selectedSource = useRef<DOMTextSelection | null>(null);
  const [images, setImages] = useState<AssetMetadata[]>(props.record.bundle.assets), [imagePicker, setImagePicker] = useState<'node' | 'body' | null>(null), [imageErrors, setImageErrors] = useState<Set<string>>(new Set()), [sourceImage, setSourceImage] = useState<string | null>(null);
  const [mediaIndex, setMediaIndex] = useState(0), [playerError, setPlayerError] = useState('');
  const [find, setFind] = useState(''), [findNotice, setFindNotice] = useState(''), [link, setLink] = useState<string | null>(null);
  const [exportKind, setExportKind] = useState<EditorExportKind | null>(null), [history, setHistory] = useState<EditorHistory | null>(null), [headingPreview, setHeadingPreview] = useState<HeadingTreePreview | null>(null), [headingMode, setHeadingMode] = useState<'append' | 'replace'>('append'), [conflictVersion, setConflictVersion] = useState<EditorWorkspaceRecord | null>(null);
  const [includeExportMedia, setIncludeExportMedia] = useState(false), [exportMediaPreview, setExportMediaPreview] = useState<EditorExportMediaPreview | null>(null), [exportPreviewError, setExportPreviewError] = useState('');
  const [exportProgress, setExportProgress] = useState<EditorExportProgress | null>(null), [exportCancelling, setExportCancelling] = useState(false), exportOperation = useRef<string | null>(null), exportStarting = useRef(false);
  const [exportLocation, setExportLocation] = useState<string | null>(null), [xmindConfirm, setXmindConfirm] = useState(false);
  const [pastePreview, setPastePreview] = useState<{ lines: string[]; parentId: string } | null>(null), branchClipboard = useRef<{ type: 'copy'; branch: BranchClipboard } | { type: 'cut'; nodeId: string } | null>(null), clipboardNonce = useRef('');
  const [moveTo, setMoveTo] = useState<string | null>(null), [relink, setRelink] = useState(false);
  const [findOpen, setFindOpen] = useState(false), [hasSelection, setHasSelection] = useState(false);
  const [card, setCard] = useState<KnowledgeCardPayload | null>(null), [cardBusy, setCardBusy] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false), leavePending = useRef<Promise<boolean> | null>(null), leaveResolve = useRef<((value: boolean) => void) | null>(null);
  const outline = useRef<HTMLDivElement>(null), mapViewRef = useRef(mapView); mapViewRef.current = mapView;
  const tree = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null), measurements = useRef(new Map<string, Size>()), [measureEpoch, setMeasureEpoch] = useState(0);
  const sizeRef = useRef<Size>({ width: 1, height: 1 }), [canvasSize, setCanvasSize] = useState<Size>({ width: 1, height: 1 }), initializedView = useRef(false), manualView = useRef(false);
  const layoutRef = useRef<TreeLayout | null>(null), gesture = useRef<CanvasGesture | null>(null), gestureFrame = useRef<number | null>(null), [drop, setDrop] = useState<DropPreview | null>(null), dropRef = useRef<DropPreview | null>(null);
  const pendingViewport = useRef<Viewport | null>(null), viewportFrame = useRef<number | null>(null), focusEpoch = useRef(0);
  const viewSettings = useRef({ collapsed, split, display, mapView, rightTab }); viewSettings.current = { collapsed, split, display, mapView, rightTab };
  const discardOnLeave = useRef(false);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null), maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null), mounted = useRef(true);
  const actions = useRef({ save: async () => false, autoSave: async () => {}, leave: async () => false, finishGesture: (_id: number, _x: number, _y: number) => {}, cancelGesture: () => {}, addOcr: async (_reference: SourceReference, _excerpt: string) => false, addAsr: async (_reference: SourceReference, _excerpt: string) => false });
  const projection = useMemo(() => state ? visibleTree(state.map, collapsed) : null, [state?.map, collapsed]);
  const layout = useMemo(() => projection ? layoutTree(projection, measurements.current) : null, [projection, measureEpoch]); layoutRef.current = layout;
  function assign(next: EditorState) { stateRef.current = next; setState(next); }
  function selectedId() { const current = stateRef.current!; return current.view.selection?.kind === 'node' && current.map.nodes[current.view.selection.nodeId] ? current.view.selection.nodeId : current.map.rootId; }
  function revisions() {
    const current = stateRef.current, session = saves.active; if (!current || !session) return;
    current.draft.revision = session.bundle.workspace.draftRevision; current.map.revision = session.bundle.workspace.mapRevision;
    if (bodyDraft.current) bodyDraft.current.revision = current.draft.revision; if (bodyBase.current) bodyBase.current.revision = current.draft.revision;
  }
  function liveMap() { const current = stateRef.current!, id = titleSession.current; if (!id || !current.map.nodes[id]) return current.map;
    const runs = titleDraft.current.flatMap((block, index) => [...(index ? [{ text: '\n' }] : []), ...block.runs]);
    return { ...current.map, nodes: { ...current.map.nodes, [id]: { ...current.map.nodes[id], title: clone(runs) } } };
  }
  function replacePending() { if (!stateRef.current || !bodyDraft.current || !saves.active) return; revisions(); saves.replace(bodyDraft.current, liveMap()); }
  function scheduleSave() {
    if (!mounted.current) return;
    if (autoTimer.current) clearTimeout(autoTimer.current); autoTimer.current = setTimeout(() => void actions.current.autoSave(), 750);
    if (!maxTimer.current) maxTimer.current = setTimeout(() => void actions.current.autoSave(), 3000);
  }
  function clearAuto() { if (autoTimer.current) clearTimeout(autoTimer.current); if (maxTimer.current) clearTimeout(maxTimer.current); autoTimer.current = maxTimer.current = null; }
  function composition(target: string, value: boolean) {
    if (installationLocked.current) return;
    if (value) composing.current.add(target); else composing.current.delete(target);
    callbacks.current.onCompositionActivity?.(composing.current.size > 0);
    setCompositionCount(composing.current.size); if (!value) scheduleSave();
  }
  function manualChange() { callbacks.current.onManualChange?.(); }
  function canSwitchEditorView(): boolean {
    if (installationLocked.current) return false;
    if (!composing.current.size) return true;
    setNotice('请先完成当前中文输入，再切换视图。不会替你确认候选词。'); return false;
  }
  function preserveCompositionFocus(event: React.MouseEvent) { if (composing.current.size) event.preventDefault(); }
  function switchDisplay(next: 'split' | 'map' | 'document') { if (canSwitchEditorView()) setDisplay(next); }
  function switchRightTab(next: 'draft' | 'source') { if (canSwitchEditorView()) setRightTab(next); }
  function switchMapView(next: 'map' | 'outline') { if (!canSwitchEditorView()) return; cancelGesture(); if (titleSession.current) commitTitle(); setMapView(next); }

  function flushBody() {
    const current = stateRef.current, draft = bodyDraft.current; if (!current || !draft || !bodyBase.current || composing.current.has('body')) return;
    revisions();
    if (JSON.stringify(draft.blocks) !== JSON.stringify(bodyBase.current.blocks)) {
      const next = execute(current, { type: 'setDraft', document: { ...clone(draft), revision: current.draft.revision } });
      if (next.error) { setError(message(next.error)); return; } assign(next.state); bodyBase.current = clone(draft); if (bodyView.current) endInputHistory(bodyView.current);
    }
  }
  function sync(next: EditorState) {
    const previous = bodyDraft.current; assign(next);
    if (previous && JSON.stringify(previous.blocks) !== JSON.stringify(next.draft.blocks)) {
      bodyDraft.current = clone(next.draft); bodyBase.current = clone(next.draft);
      if (bodyView.current) { applyingBody.current = true; try { replaceEditorBlocks(bodyView.current, next.draft.blocks as Block[], { preserveSelection: true }); } finally { applyingBody.current = false; } }
    }
    replacePending(); scheduleSave();
  }
  function focusCanvasLater() { const epoch = ++focusEpoch.current; requestAnimationFrame(() => { if (epoch === focusEpoch.current && !titleSession.current && !composing.current.size) (mapViewRef.current === 'outline' ? outline.current : tree.current)?.focus(); }); }
  function command(cmd: EditorCommand, focus = true) {
    if (!['select', 'viewport'].includes(cmd.type) && !requireEditing()) return false;
    if (!stateRef.current || composing.current.size) { if (composing.current.size) setNotice('请先完成中文候选，再进行结构操作。'); return false; }
    if (!['select', 'viewport', 'rename'].includes(cmd.type) && titleSession.current) commitTitle();
    if (!['select', 'viewport', 'setDraft'].includes(cmd.type)) flushBody(); revisions();
    const result = execute(stateRef.current!, cmd); if (result.error) { setError(message(result.error)); return false; }
    if (result.changed) { manualChange(); sync(result.state); } else assign(result.state);
    const nextSelected = result.state.view.selection; if (nextSelected?.kind === 'node') setCollapsed(value => revealNode(result.state.map, value, nextSelected.nodeId));
    if (focus) focusCanvasLater(); return true;
  }
  function startTitle(id: string) {
    if (!requireEditing()) return;
    if (composing.current.size || !stateRef.current?.map.nodes[id]) return;
    if (titleSession.current) commitTitle(); flushBody(); ++focusEpoch.current;
    command({ type: 'select', selection: { kind: 'node', nodeId: id } }, false);
    titleDraft.current = [{ id: `title-${id}`, type: 'paragraph', runs: clone(stateRef.current!.map.nodes[id].title) }]; titleSession.current = id; setTitleId(id);
  }
  function commitTitle(cancel = false) {
    const id = titleSession.current; if (!id || composing.current.has('node')) return;
    const runs = titleDraft.current.flatMap((block, index) => [...(index ? [{ text: '\n' }] : []), ...block.runs]); titleSession.current = null; setTitleId(null);
    if (!cancel) command({ type: 'rename', nodeId: id, title: runs }, false); else if (saves.isDirty()) scheduleSave();
  }
  async function saveTitle(): Promise<boolean> {
    if (titleSaving.current) return titleSaving.current; if (userTitleRef.current === savedUserTitle.current) return true;
    const value = userTitleRef.current, workspaceId = saves.active!.workspaceId;
    const operation = (async () => { try { await api.title(workspaceId, value); savedUserTitle.current = value; if (saves.active) saves.active.bundle.workspace.userTitle = value; return true; } catch (error) { setError(message(error, '我的标题保存失败，当前输入仍然保留。')); return false; } finally { titleSaving.current = null; if (mounted.current) update(); } })(); titleSaving.current = operation; update(); return operation;
  }
  async function save(): Promise<boolean> {
    if (!mounted.current || installationLocked.current) return false;
    if (!stateRef.current || !saves.active) return false;
    if (composing.current.size) { setNotice('中文输入尚未结束。完成候选后会继续保存，不会替你确认候选词。'); return false; }
    clearAuto(); flushBody();
    if (!await saveTitle()) return false;
    const ok = await saves.save(); revisions(); if (mounted.current) update();
    if (ok && !saves.isDirty() && userTitleRef.current === savedUserTitle.current) { callbacks.current.onSaved?.(); return true; }
    if (ok && mounted.current) scheduleSave(); return false;
  }
  async function autoSave() { clearAuto(); if (composing.current.size) { scheduleSave(); return; } if (saves.active?.status === 'conflict' || saves.active?.status === 'failed') return; await save(); }
  async function saveCurrentBarrier(): Promise<boolean> { for (let attempt = 0; attempt < 4; attempt++) { if (composing.current.size) return false; if (await save() && !saves.isDirty() && userTitleRef.current === savedUserTitle.current) return true; if (saves.active?.status === 'failed' || saves.active?.status === 'conflict') return false; } return false; }
  async function leave(): Promise<boolean> {
    if (leavePending.current) return leavePending.current;
    cancelGesture();
    const operation = (async () => { if (!composing.current.size) { if (titleSession.current) commitTitle(); flushViewport(); if (await saveCurrentBarrier()) { cacheSession(); return true; } } setLeavePrompt(true); return new Promise<boolean>(resolve => { leaveResolve.current = resolve; }); })();
    leavePending.current = operation; const value = await operation; leavePending.current = null; return value;
  }
  function resolveLeave(value: boolean) { setLeavePrompt(false); leaveResolve.current?.(value); leaveResolve.current = null; }
  function cacheSession() {
    const current = stateRef.current, session = saves.active;
    if (!current || !session || discardOnLeave.current || composing.current.size || titleSession.current || saves.isDirty(session) || userTitleRef.current !== savedUserTitle.current || session.saving) return;
    const settings = viewSettings.current, saved = clone(current); saved.view.inputSession = null; if (pendingViewport.current) saved.view.viewport = { ...pendingViewport.current };
    workspaceSessions.delete(session.workspaceId); workspaceSessions.set(session.workspaceId, { state: saved, draftRevision: session.bundle.workspace.draftRevision, mapRevision: session.bundle.workspace.mapRevision, collapsed: [...settings.collapsed], split: settings.split, display: settings.display, mapView: settings.mapView, rightTab: settings.rightTab });
    // Bound memory without writing undo history or viewport state into user documents.
    while (workspaceSessions.size > 32) workspaceSessions.delete(workspaceSessions.keys().next().value!);
  }
  actions.current = { save, autoSave, leave, finishGesture, cancelGesture, addOcr: addOcrReference, addAsr: addAsrReference };
  useEffect(() => { mounted.current = true; let cancelled = false;
    void saves.activate(record.bundle.workspace.id).then(session => { if (!session || cancelled) return; bodyDraft.current = clone(session.bundle.draft); bodyBase.current = clone(session.bundle.draft);
      const cached = workspaceSessions.get(session.workspaceId);
      if (cached && cached.draftRevision === session.bundle.workspace.draftRevision && cached.mapRevision === session.bundle.workspace.mapRevision && cached.state.draft.documentId === session.bundle.draft.documentId && cached.state.map.documentId === session.bundle.map.documentId) {
        assign(clone(cached.state)); setCollapsed(new Set(cached.collapsed)); setSplit(cached.split); setDisplay(cached.display); setMapView(cached.mapView); setRightTab(cached.rightTab); initializedView.current = true;
      } else { workspaceSessions.delete(session.workspaceId); assign(createEditorState(session.bundle)); }
 }).catch(error => setError(message(error, '无法读取已保存的整理稿，请返回后重试。')));
    return () => { cacheSession(); mounted.current = false; cancelled = true; clearAuto(); leaveResolve.current?.(false); };
  }, []);
  const mediaSignature = content.media.map(item => `${item.id}:${item.state}:${item.current !== false}:${item.bytes}`).join('|');
  const lastSourceSignature = useRef(JSON.stringify([content.body, content.subtitle, mediaSignature]));
  useEffect(() => {
    const signature = JSON.stringify([content.body, content.subtitle, mediaSignature]);
    if (signature === lastSourceSignature.current) return; lastSourceSignature.current = signature;
    const session = saves.active; if (!session) return; const sessionId = session.id;
    // Refresh immutable source records only. The live editors, revisions and history are untouched.
    void api.load(session.workspaceId).then(fresh => {
      if (!fresh.initialized || !mounted.current || saves.active?.id !== sessionId) return;
      const target = saves.active; target.bundle.sources = fresh.bundle.sources; target.bundle.transcripts = fresh.bundle.transcripts; target.bundle.assets = fresh.bundle.assets;
      recordRef.current = fresh; setRecord(fresh); setImages(fresh.bundle.assets);
    }).catch(() => { if (mounted.current) setNotice('来源更新暂时无法读取，当前工作稿和引用版本继续保留。'); });
  }, [content.body, content.subtitle, mediaSignature]);
  useEffect(() => api.onExportProgress?.(progress => { if (mounted.current && exportOperation.current === progress.operationId) setExportProgress(progress); }), [api]);
  useEffect(() => props.registerLeaveGuard?.(() => actions.current.leave()), [props.registerLeaveGuard]);
  useEffect(() => props.registerSaveBarrier?.(() => saveCurrentBarrier()), [props.registerSaveBarrier]);
  useEffect(() => props.registerGenerationBarrier?.({
    lock() {
      if (installationLocked.current) return true;
      const session = saves.active, current = stateRef.current;
      const pendingBody = bodyDraft.current && bodyBase.current && JSON.stringify(bodyDraft.current.blocks) !== JSON.stringify(bodyBase.current.blocks);
      const pendingTitle = titleSession.current && current && JSON.stringify(liveMap().nodes[titleSession.current].title) !== JSON.stringify(current.map.nodes[titleSession.current].title);
      if (composing.current.size || saves.isDirty() || session?.saving || titleSaving.current || userTitleRef.current !== savedUserTitle.current || pendingBody || pendingTitle) return false;
      installationLocked.current = true; clearAuto(); ++focusEpoch.current; cancelGesture();
      // Set DOM protection in this task, before any await or React render can yield.
      const active = document.activeElement; installationFocus.current = active instanceof HTMLElement && workspaceHost.current?.contains(active) ? active : null;
      if (workspaceHost.current) workspaceHost.current.inert = true;
      bodyView.current?.setProps({ editable: () => false }); titleView.current?.setProps({ editable: () => false });
      return true;
    },
    unlock() {
      installationLocked.current = false;
      if (workspaceHost.current) workspaceHost.current.inert = !!callbacks.current.interactionBlocked;
      bodyView.current?.setProps({ editable: () => !readOnlyRef.current && !viewDraftReading.current });
      titleView.current?.setProps({ editable: () => !readOnlyRef.current });
      const focus = installationFocus.current; installationFocus.current = null;
      if (focus?.isConnected && (document.activeElement === document.body || document.activeElement === focus)) focus.focus({ preventScroll: true });
    },
    async reload(fresh) {
      if (!installationLocked.current || !mounted.current || fresh.bundle.workspace.id !== callbacks.current.record.bundle.workspace.id) return false;
      const workspaceId = fresh.bundle.workspace.id, oldView = stateRef.current?.view;
      // Use the independently validated, exact pair just loaded by the owner.
      // A second asynchronous load could switch only the save session to a newer pair.
      saves.sessions.set(workspaceId, { id: `session-${crypto.randomUUID()}`, workspaceId, bundle: clone(fresh.bundle), edit: 0, savedEdit: 0, status: 'saved', error: '' });
      const session = await saves.activate(workspaceId);
      if (!session || !mounted.current || !installationLocked.current) return false;
      workspaceSessions.delete(workspaceId); recordRef.current = fresh; setRecord(fresh); setImages(fresh.bundle.assets);
      const next = createEditorState(session.bundle);
      if (oldView) next.view.viewport = { ...oldView.viewport };
      bodyDraft.current = clone(session.bundle.draft); bodyBase.current = clone(session.bundle.draft);
      titleSession.current = null; setTitleId(null); setCollapsed(new Set()); setNodePanel(false);
      setHeadingPreview(null); setPastePreview(null); setMoveTo(null); setLink(null); setImagePicker(null); setHistory(null); setConflictVersion(null);
      userTitleRef.current = savedUserTitle.current = fresh.bundle.workspace.userTitle; setUserTitle(fresh.bundle.workspace.userTitle);
      if (bodyView.current) { applyingBody.current = true; try { replaceEditorBlocks(bodyView.current, next.draft.blocks as Block[], { preserveSelection: true }); } finally { applyingBody.current = false; } }
      assign(next); return true;
    }
  }), [props.registerGenerationBarrier]);
  useEffect(() => props.registerOcrReferenceHandler?.(content.id, (reference, excerpt) => actions.current.addOcr(reference, excerpt)), [props.registerOcrReferenceHandler, content.id]);
  useEffect(() => props.registerAsrReferenceHandler?.(content.id, (reference, excerpt) => actions.current.addAsr(reference, excerpt)), [props.registerAsrReferenceHandler, content.id]);
  useEffect(() => { const key = (event: KeyboardEvent) => { dispatchSaveShortcut(event, { blocked: sourceWorkspaceOwnsShortcut(event, document), composing: composing.current.size > 0, save: () => { void actions.current.save(); } }); }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.shiftKey && !event.altKey) { event.preventDefault(); setFindOpen(true); requestAnimationFrame(() => workspaceHost.current?.querySelector<HTMLInputElement>('.e1-find input')?.focus()); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);

  function activeViewport(): Viewport { return pendingViewport.current || stateRef.current!.view.viewport; }
  function flushViewport() { if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current); viewportFrame.current = null; const pending = pendingViewport.current; pendingViewport.current = null; if (pending && stateRef.current) assign({ ...stateRef.current, view: { ...stateRef.current.view, viewport: pending } }); }
  function setViewport(viewport: Viewport, manual = true) { if (!stateRef.current || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom < MIN_ZOOM || viewport.zoom > MAX_ZOOM) return; initializedView.current = true; manualView.current ||= manual; pendingViewport.current = viewport; if (viewportFrame.current === null) viewportFrame.current = requestAnimationFrame(flushViewport); }
  function canvasPoint(point: Point): Point { const rect = tree.current!.getBoundingClientRect(); return { x: point.x - rect.left, y: point.y - rect.top }; }
  function resetDrop(next: DropPreview | null) { if (JSON.stringify(next) !== JSON.stringify(dropRef.current)) { dropRef.current = next; setDrop(next); } }
  function cancelGesture() { const previous = gesture.current; gesture.current = null; if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current); gestureFrame.current = null; if (previous && tree.current?.hasPointerCapture(previous.pointerId)) tree.current.releasePointerCapture(previous.pointerId); resetDrop(null); if (mounted.current) update(); }
  function fitAll() { if (layoutRef.current && sizeRef.current.width > 1 && sizeRef.current.height > 1) setViewport(fitBounds(layoutRef.current.bounds, sizeRef.current)); }
  function centerSelected() { const current = stateRef.current; if (!current) return; const id = selectedId(); const next = revealNode(current.map, collapsedRef.current, id); if ([...next].join() !== [...collapsedRef.current].join()) { setCollapsed(next); requestAnimationFrame(() => requestAnimationFrame(() => { const rect = layoutRef.current?.nodes[id]; if (rect) setViewport(centerBounds(activeViewport(), rect, sizeRef.current)); })); } else { const rect = layoutRef.current?.nodes[id]; if (rect) setViewport(centerBounds(activeViewport(), rect, sizeRef.current)); } }
  function readSelected() { const rect = layoutRef.current?.nodes[selectedId()]; if (rect) setViewport(fitBounds(rect, sizeRef.current)); }
  function zoomBy(factor: number) { setViewport(zoomAt(activeViewport(), activeViewport().zoom * factor, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 })); }
  function previewDrag() { gestureFrame.current = null; const active = gesture.current, current = stateRef.current; if (!active?.active || active.kind !== 'node' || !current || !layoutRef.current || !tree.current) return;
    const local = canvasPoint(active.last), viewport = activeViewport(), size = sizeRef.current, edge = 35;
    const dx = local.x < edge ? 10 : local.x > size.width - edge ? -10 : 0, dy = local.y < edge ? 10 : local.y > size.height - edge ? -10 : 0;
    if (dx || dy) setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
    resetDrop(dropAt(current.map, layoutRef.current, active.nodeId!, screenToWorld(local, activeViewport()))); if (dx || dy) gestureFrame.current = requestAnimationFrame(previewDrag);
  }
  function pointerDown(event: React.PointerEvent<HTMLDivElement>) { if (event.button !== 0 || gesture.current || leavePrompt) return; const target = event.target as HTMLElement;
    if (target.closest('button,input,textarea,select,a,.ProseMirror,[contenteditable="true"]')) return; const node = target.closest<HTMLElement>('[data-node-id]');
    if (node && readOnlyRef.current) { selectNode(node.dataset.nodeId!); return; }
    if (node && (titleSession.current || composing.current.size)) return; if (!stateRef.current) return;
    event.preventDefault(); gesture.current = { pointerId: event.pointerId, workspaceId: stateRef.current.map.workspaceId, kind: node ? 'node' : 'pan', nodeId: node?.dataset.nodeId, start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY }, startViewport: { ...activeViewport() }, active: false }; event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) { const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return; active.last = { x: event.clientX, y: event.clientY };
    if (!active.active && Math.hypot(active.last.x - active.start.x, active.last.y - active.start.y) < DRAG_THRESHOLD) return; if (!active.active) { active.active = true; update(); }
    event.preventDefault(); if (active.kind === 'pan') setViewport({ ...active.startViewport, x: active.startViewport.x + active.last.x - active.start.x, y: active.startViewport.y + active.last.y - active.start.y }); else if (gestureFrame.current === null) gestureFrame.current = requestAnimationFrame(previewDrag);
  }
  function finishGesture(pointerId: number, clientX: number, clientY: number) { const active = gesture.current, current = stateRef.current; if (!active || active.pointerId !== pointerId) return;
    const local = tree.current ? canvasPoint({ x: clientX, y: clientY }) : null, same = current?.map.workspaceId === active.workspaceId;
    const inside = local && local.x >= 0 && local.y >= 0 && local.x <= sizeRef.current.width && local.y <= sizeRef.current.height;
    const candidate = same && inside && active.active && active.kind === 'node' && layoutRef.current ? dropAt(current!.map, layoutRef.current, active.nodeId!, screenToWorld(local!, activeViewport())) : null;
    cancelGesture(); if (!same || !current) return;
    if (active.active && active.kind === 'node' && candidate?.allowed) command({ type: 'move', nodeId: active.nodeId!, parentId: candidate.parentId, index: candidate.index }, false);
    else if (!active.active && active.kind === 'node') command({ type: 'select', selection: { kind: 'node', nodeId: active.nodeId! } });
  }
  const nodeSignature = projection ? Object.keys(projection.nodes).join('|') : '';
  function measureNodes() { if (!world.current) return; let changed = false; for (const element of world.current.querySelectorAll<HTMLElement>('[data-node-id]')) { const id = element.dataset.nodeId!, size = { width: element.offsetWidth, height: element.offsetHeight }, old = measurements.current.get(id); if (size.width > 0 && size.height > 0 && (!old || Math.abs(old.width - size.width) > .1 || Math.abs(old.height - size.height) > .1)) { measurements.current.set(id, size); changed = true; } } if (changed) setMeasureEpoch(value => value + 1); }
  useLayoutEffect(() => { measureNodes(); }, [nodeSignature, titleId, state?.map]);
  useEffect(() => {
    const root = tree.current; if (!root || !world.current) return;
    const resize = new ResizeObserver(entries => { if (entries.some(entry => entry.target === root)) { const previous = sizeRef.current, next = { width: root.clientWidth, height: root.clientHeight }; sizeRef.current = next; setCanvasSize(next); if (initializedView.current && previous.width > 1 && previous.height > 1 && next.width > 1 && next.height > 1) setViewport(resizedViewport(activeViewport(), previous, next), false); } measureNodes(); });
    resize.observe(root); for (const node of world.current.querySelectorAll('[data-node-id]')) resize.observe(node); return () => resize.disconnect();
  }, [nodeSignature, mapView, display]);
  useEffect(() => { const root = tree.current; if (!root) return; const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.ProseMirror,button,input,textarea,select,a')) return; event.preventDefault(); if (![event.deltaX, event.deltaY, event.clientX, event.clientY].every(Number.isFinite)) return;
      const viewport = activeViewport(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) setViewport(wheelZoomAt(viewport, Math.max(-4000, Math.min(4000, event.deltaY * unit)), canvasPoint({ x: event.clientX, y: event.clientY })));
      else setViewport({ ...viewport, x: viewport.x - event.deltaX * unit, y: viewport.y - event.deltaY * unit });
    }; root.addEventListener('wheel', wheel, { passive: false }); return () => root.removeEventListener('wheel', wheel); }, [!!state, mapView]);
  useEffect(() => { const host = world.current; if (!host || !state || initializedView.current || mapView !== 'map') return; let cancelled = false, frame = 0; const workspaceId = state.map.workspaceId;
    const ready = [...host.querySelectorAll('img')].map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true }); }));
    void Promise.all([document.fonts.ready, ...ready]).then(() => { if (cancelled) return; measureNodes(); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (cancelled || stateRef.current?.map.workspaceId !== workspaceId || initializedView.current || !layoutRef.current || sizeRef.current.width <= 1 || sizeRef.current.height <= 1) return; setViewport(fitBounds(layoutRef.current.bounds, sizeRef.current), false); }); }); });
    return () => { cancelled = true; if (frame) cancelAnimationFrame(frame); };
  }, [nodeSignature, canvasSize.width, canvasSize.height, mapView]);
  useEffect(() => {
    const release = (event: PointerEvent) => actions.current.finishGesture(event.pointerId, event.clientX, event.clientY), cancel = () => { splitPointer.current = null; actions.current.cancelGesture(); };
    const key = (event: KeyboardEvent) => { if (event.isComposing || event.keyCode === 229 || (event.target as HTMLElement)?.closest('.e11-ocr-workspace,input,textarea,[contenteditable="true"]')) return; if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); } if ((event.metaKey || event.ctrlKey) && ['+', '=', '-', '0'].includes(event.key) && (event.target as HTMLElement).closest('.e1-canvas,.e1-viewport-controls') && stateRef.current) { event.preventDefault(); if (event.key === '0') setViewport(zoomAt(activeViewport(), 1, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 })); else zoomBy(event.key === '-' ? 1 / 1.2 : 1.2); } };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', key, true); const visibility = () => { if (document.visibilityState === 'hidden') cancel(); }; document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key, true); document.removeEventListener('visibilitychange', visibility); if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current); if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current); };
  }, []);
  function toggleCollapsed(id: string) { setCollapsed(value => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function selectNode(id: string, center = false) { command({ type: 'select', selection: { kind: 'node', nodeId: id } }); if (center) requestAnimationFrame(centerSelected); }
  function structure(type: 'addChild' | 'addSibling' | 'addSiblingBefore' | 'insertParent') { if (command({ type, nodeId: selectedId() }, false)) startTitle(selectedId()); }
  function reorder(direction: -1 | 1) { const current = stateRef.current!, node = current.map.nodes[selectedId()]; if (!node.parentId) return; const parent = current.map.nodes[node.parentId], at = parent.children.indexOf(node.id), index = at + direction; if (index >= 0 && index < parent.children.length) command({ type: 'move', nodeId: node.id, parentId: parent.id, index }); }
  function copy(cut = false) { const current = stateRef.current!; if (cut && selectedId() === current.map.rootId) { setError('根节点不能剪切。'); return; } clipboardNonce.current = crypto.randomUUID(); branchClipboard.current = cut ? { type: 'cut', nodeId: selectedId() } : { type: 'copy', branch: copyBranch(current.map, selectedId()) }; setNotice(cut ? '已剪切分支。选择目标父级后粘贴；粘贴前保留原位置。' : '已复制分支。选择目标父级后粘贴，副本将有新身份。'); }
  function pasteBranchHere() { const value = branchClipboard.current, current = stateRef.current!; if (!value) { setNotice('先复制或剪切一个分支；外部文字请使用系统粘贴。'); return; }
    if (value.type === 'copy') command({ type: 'pasteBranch', parentId: selectedId(), branch: value.branch });
    else { const parent = current.map.nodes[selectedId()], index = parent.children.filter(id => id !== value.nodeId).length; if (command({ type: 'move', nodeId: value.nodeId, parentId: parent.id, index })) branchClipboard.current = null; }
  }
  function canvasKey(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest('button,input,textarea,select,.ProseMirror') || event.nativeEvent.isComposing || event.keyCode === 229 || titleSession.current || composing.current.size || !stateRef.current) return;
    const current = stateRef.current, id = selectedId(), node = current.map.nodes[id], mod = event.metaKey || event.ctrlKey; let handled = true;
    if (event.key === 'Tab') structure('addChild');
    else if (event.key === 'Enter' && mod) structure('insertParent');
    else if (event.key === 'Enter') structure(event.shiftKey ? 'addSiblingBefore' : id === current.map.rootId ? 'addChild' : 'addSibling');
    else if (event.key === ' ') startTitle(id);
    else if (mod && event.key.toLowerCase() === 'b') command({ type: 'toggleNodeBold', nodeId: id });
    else if (mod && event.key.toLowerCase() === 'd') { const parent = node.parentId ? current.map.nodes[node.parentId] : node; command({ type: 'copySubtree', nodeId: id, parentId: parent.id, index: node.parentId ? parent.children.indexOf(id) + 1 : parent.children.length }); }
    else if (mod && event.key.toLowerCase() === 'z') command({ type: event.shiftKey ? 'redo' : 'undo' });
    else if (event.key === 'Backspace' || event.key === 'Delete') command({ type: mod ? 'promoteChildren' : 'deleteSubtree', nodeId: id });
    else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) reorder(event.key === 'ArrowUp' ? -1 : 1);
    else if (event.key === 'ArrowRight') { if (collapsedRef.current.has(id)) toggleCollapsed(id); else if (node.children[0]) selectNode(node.children[0], true); }
    else if (event.key === 'ArrowLeft') { if (node.children.length && !collapsedRef.current.has(id)) toggleCollapsed(id); else if (node.parentId) selectNode(node.parentId, true); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const order = treeOrder(current.map, collapsedRef.current), at = order.findIndex(item => item.id === id), next = order[at + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) selectNode(next.id, true); }
    else if (event.key === 'Escape') { cancelGesture(); setNodePanel(false); }
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }
  function canvasCopy(event: React.ClipboardEvent, cut = false) { if ((event.target as HTMLElement).closest('.ProseMirror,input,textarea')) return; copy(cut); event.preventDefault(); event.clipboardData.setData('application/x-rlw-editor-branch', clipboardNonce.current); event.clipboardData.setData('text/plain', plainText(stateRef.current!.map.nodes[selectedId()].title)); }
  function canvasPaste(event: React.ClipboardEvent) { if ((event.target as HTMLElement).closest('.ProseMirror,input,textarea')) return; event.preventDefault(); const text = event.clipboardData.getData('text/plain'), internal = branchClipboard.current;
    const internalText = internal?.type === 'copy' ? plainText(internal.branch.nodes[internal.branch.rootId].title) : internal?.type === 'cut' ? plainText(stateRef.current!.map.nodes[internal.nodeId]?.title || []) : null;
    if (internal && event.clipboardData.getData('application/x-rlw-editor-branch') === clipboardNonce.current && text === internalText) { pasteBranchHere(); return; } const preview = externalTextPreview(text); if (preview.error) setError(preview.error); else setPastePreview({ lines: preview.lines, parentId: selectedId() });
  }

  const bodyLocalRedo = useRef(false), historyInput = useRef(false);
  function historyAction(kind: 'undo' | 'redo') {
    if (!requireEditing()) return;
    const nodeEditor = titleView.current;
    if (titleSession.current && nodeEditor) { (kind === 'undo' ? pmUndo : pmRedo)(nodeEditor.state, nodeEditor.dispatch); return; }
    const pendingBody = bodyDraft.current && bodyBase.current && JSON.stringify(bodyDraft.current.blocks) !== JSON.stringify(bodyBase.current.blocks);
    if ((pendingBody || kind === 'redo' && bodyLocalRedo.current) && bodyView.current) {
      historyInput.current = true; const applied = (kind === 'undo' ? pmUndo : pmRedo)(bodyView.current.state, bodyView.current.dispatch); historyInput.current = false; if (applied) { bodyLocalRedo.current = kind === 'undo'; return; }
    }
    bodyLocalRedo.current = false; command({ type: kind }, false);
  }
  function bodyCommand(action: (view: EditorView) => boolean) { if (!requireEditing() || draftReading || !bodyView.current || composing.current.size) return; const applied = action(bodyView.current); if (!applied) setNotice('请先把光标或选区放在可编辑的正文中。'); else bodyView.current.focus(); }
  async function addSelection() {
    if (!requireEditing()) return;
    if (!stateRef.current || composing.current.size) { setNotice('完成中文输入后再引用选区。'); return; }
    const parentId = selectedId(), selected = stateRef.current.map.nodes[parentId]; let ref: SourceReference, excerpt = '';
    if (rightTab === 'draft') {
      const range = bodyView.current && selectedBlockRange(bodyView.current); if (!range) { setError('请在整理稿同一个文本块内选择非空文字；跨块选区不能加入。'); return; }
      const document = bodyDraft.current!, signature = JSON.stringify(document.blocks), block = blockById(document.blocks, range.blockId); if (!block) { setError('选区无法定位，请重新选择。'); return; }
      excerpt = range.excerpt;
      if (!await saveCurrentBarrier() || JSON.stringify(bodyDraft.current!.blocks) !== signature) { setError('引用需要保存选区的确切版本。请完成保存并重新确认选区。'); return; }
      ref = { kind: 'userDraft', documentId: document.documentId, revision: saves.active!.bundle.workspace.draftRevision, blockId: block.id, range: { start: range.start, end: range.end, unit: 'unicode-code-point', excerpt, before: pointSlice(plainText(block.runs), Math.max(0, range.start - 12), range.start), after: pointSlice(plainText(block.runs), range.end, range.end + 12) } };
    } else {
      let selection = selectedSource.current;
      try { selection = sourceHost.current && readSourceSelection(sourceHost.current, window.getSelection()) || selection; } catch (error) { setError(message(error)); return; }
      if (!selection || selection.end <= selection.start) { setError('请在原文或字幕的同一个文本块中选择文字，再加入导图。'); return; }
      const bundle = saves.active!.bundle; excerpt = selection.excerpt;
      if (selection.kind === 'body') { const source = bundle.sources.find(source => source.sourceRevisionId === selection.identity), block = source && blockById(source.blocks, selection.blockId); if (!source || !block) { setError('来源版本无法定位，请重新选择。'); return; } ref = sourceRangeReference({ kind: 'capturedSource', sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, blockId: block.id }, plainText(block.runs), selection.start, selection.end); }
      else { const segment = bundle.transcripts.find(segment => `${segment.transcriptId}@${segment.revision}` === selection.identity && segment.segmentId === selection.blockId); if (!segment) { setError('字幕版本无法定位，请重新选择。'); return; } ref = { kind: 'transcript', transcriptId: segment.transcriptId, revision: segment.revision, segmentId: segment.segmentId, range: { start: selection.start, end: selection.end, unit: 'unicode-code-point', excerpt, before: pointSlice(plainText(segment.runs), Math.max(0, selection.start - 12), selection.start), after: pointSlice(plainText(segment.runs), selection.end, selection.end + 12) } }; }
    }
    if (relink) { if (command({ type: 'setReferences', nodeId: parentId, sourceRefs: [ref] }, false)) { setRelink(false); setNotice('已明确重新关联选区。'); } }
    else command({ type: 'fromReference', parentId: selected.id, title: excerptTitle(excerpt), reference: ref }, false);
  }
  function rememberSourceSelection() { if (!sourceHost.current) return; try { selectedSource.current = readSourceSelection(sourceHost.current, window.getSelection()); setHasSelection(!!selectedSource.current); } catch { selectedSource.current = null; setHasSelection(false); } }
  async function addOcrReference(ref: SourceReference, excerpt: string): Promise<boolean> {
    if (!requireEditing()) return false;
    if (!stateRef.current || !saves.active || ref.kind !== 'ocr' || composing.current.size) return false;
    const sessionId = saves.active.id, parentId = selectedId();
    if (!await saveCurrentBarrier() || saves.active?.id !== sessionId || !stateRef.current.map.nodes[parentId]) { setError('请先保存当前工作稿，再加入图片文字引用。'); return false; }
    try { await api.resolve(saves.active.workspaceId, ref); } catch (error) { setError(message(error, '图片文字的确切版本暂不可读，未创建引用节点。')); return false; }
    if (saves.active?.id !== sessionId || composing.current.size) return false;
    return command({ type: 'fromReference', parentId, title: excerptTitle(excerpt), reference: ref }, false);
  }
  function openOcrResult(target: OcrOpenTarget) { if (canSwitchEditorView()) callbacks.current.onOpenOcr?.(target); }
  async function addAsrReference(ref: SourceReference, excerpt: string): Promise<boolean> {
    if (!requireEditing()) return false;
    if (!stateRef.current || !saves.active || ref.kind !== 'transcript' || composing.current.size) return false;
    const sessionId = saves.active.id, parentId = selectedId();
    if (!await saveCurrentBarrier() || saves.active?.id !== sessionId || !stateRef.current.map.nodes[parentId]) { setError('请先保存当前工作稿，再加入转录引用。'); return false; }
    try { await api.resolve(saves.active.workspaceId, ref); const refreshed = await api.load(saves.active.workspaceId); if (saves.active?.id !== sessionId) return false; saves.active.bundle.transcripts = refreshed.bundle.transcripts; }
    catch (error) { setError(message(error, '转录确切版本暂不可读，未创建引用节点。')); return false; }
    if (saves.active?.id !== sessionId || composing.current.size) return false;
    return command({ type: 'fromReference', parentId, title: excerptTitle(excerpt), reference: ref }, false);
  }
  async function openReference(ref: SourceReference) {
    if (composing.current.size) { setNotice('请先完成当前输入，来源定位不会替你确认候选。'); return; }
    try { const resolved = await api.resolve(saves.active!.workspaceId, ref); if (!canSwitchEditorView()) return; if (ref.kind === 'ocr' && resolved.ocr && callbacks.current.onOpenOcr) { openOcrResult({ contentId: content.id, resultId: ref.resultId, correctionRevision: ref.correctionRevision, blockId: ref.blockId, range: ref.range }); return; } if (ref.kind === 'transcript' && ['plain-text-response', 'manual-correction'].includes(resolved.transcript?.inputSource.kind ?? '') && callbacks.current.onOpenAsr) { callbacks.current.onOpenAsr({ contentId: content.id, resultId: ref.transcriptId, revision: ref.revision, range: ref.range }); return; } setReference({ ref, resolved }); setRightTab('source'); if (display === 'map') setDisplay('split'); setNotice('正在查看引用时版本。'); }
    catch (error) { if(ref.kind==='transcript'){setRightTab('source');if(display==='map')setDisplay('split');setError(`固定转录引用暂不可读：${ref.transcriptId} · revision ${ref.revision} · 段 ${ref.segmentId}。当前节点与原引用保留；请查看来源资料的不可用版本说明，不会改用其他版本。`);}else setError(message(error, '引用时版本暂时无法读取。当前节点和原引用均保留。')); }
  }
  useEffect(() => { if (reference) requestAnimationFrame(() => referenceHost.current?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'instant' })); }, [reference]);
  useEffect(() => {
    if (!sourceImage || rightTab !== 'source' || sourceTab !== 'images') return;
    requestAnimationFrame(() => sourceHost.current?.querySelector<HTMLElement>(`[data-source-asset="${CSS.escape(sourceImage)}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  }, [sourceImage, rightTab, sourceTab, images]);
  async function openImages(target: 'node' | 'body') { if (composing.current.size) return; try { setImages(await api.images(saves.active!.workspaceId)); setImagePicker(target); } catch (error) { setError(message(error)); } }
  function applyImage(ref: AssetRef) { if (imagePicker === 'node') command({ type: 'setImage', nodeId: selectedId(), image: ref }, false); else bodyCommand(view => insertImage(ref)(view.state, view.dispatch)); setImagePicker(null); }
  async function selectCurrentImage(mediaId: number) { setBusy(true); try { const asset = await api.selectImage(saves.active!.workspaceId, mediaId); setImages(previous => [...previous.filter(value => value.id !== asset.id || value.version !== asset.version), asset]); applyImage({ assetId: asset.id, version: asset.version }); } catch (error) { setError(message(error, '这张本地图片无法解码或固定版本，未加入编辑内容。')); } finally { setBusy(false); } }
  async function previewHeadings() { if (!await saveCurrentBarrier()) { setError('请先保存当前整理稿，再按其标题预览。'); return; } try { setHeadingPreview(headingTreePreview(stateRef.current!.draft, stateRef.current!.map)); setHeadingMode('append'); } catch (error) { setError(message(error, '整理稿没有可用的 H1–H3 标题。请先设置标题层级。')); } }
  async function showHistory() { try { setHistory(await api.history(saves.active!.workspaceId)); } catch (error) { setError(message(error, '已保存版本读取失败，请稍后重试。')); } }
  async function restoreVersion(kind: 'draft' | 'map', revision: number) {
    if (!await beginEditing()) return;
    if (!await saveCurrentBarrier()) { setError('当前修改尚未保存，不能恢复历史。请重试保存或取消。'); return; }
    const session = saves.active!, expected = kind === 'draft' ? session.bundle.workspace.draftRevision : session.bundle.workspace.mapRevision; setBusy(true);
    manualChange();
    try { const result = await api.restore(session.workspaceId, kind, revision, expected, session.id, `restore-${crypto.randomUUID()}`); if (result.status !== 'saved') throw new Error(result.status === 'conflict' ? 'conflict' : 'restore failed');
      const fresh = await api.load(session.workspaceId); saves.sessions.delete(session.workspaceId); const reopened = await saves.activate(session.workspaceId); if (!reopened) throw new Error('load failed');
      recordRef.current = fresh; setRecord(fresh); bodyDraft.current = clone(reopened.bundle.draft); bodyBase.current = clone(reopened.bundle.draft); assign(createEditorState(reopened.bundle)); if (bodyView.current) replaceEditorBlocks(bodyView.current, reopened.bundle.draft.blocks as Block[], { preserveSelection: true }); setTitleId(null); titleSession.current = null; setHistory(null); setNotice('已恢复为新的当前版本；恢复前的已保存版本仍然保留。'); callbacks.current.onSaved?.();
    } catch (error) { setError(message(error, '恢复未完成，当前版本仍然保留。')); } finally { setBusy(false); }
  }
  async function inspectConflict() {
    try { setConflictVersion(await api.load(saves.active!.workspaceId)); } catch (error) { setError(message(error, '磁盘版本暂时无法读取，当前稿继续保留。')); }
  }
  async function resolveConflict(choice: 'keep' | 'disk') {
    if (!conflictVersion || composing.current.size) return; setBusy(true);
    try {
      const current = stateRef.current!, session = saves.active!, latest = conflictVersion;
      if (choice === 'keep') {
        // Explicit user decision, not an automatic overwrite. CAS still rejects a newer disk commit.
        session.bundle.workspace.draftRevision = latest.bundle.workspace.draftRevision;
        session.bundle.workspace.mapRevision = latest.bundle.workspace.mapRevision;
        session.bundle.draft.revision = latest.bundle.workspace.draftRevision; session.bundle.map.revision = latest.bundle.workspace.mapRevision;
        revisions(); replacePending();
        if (!await saveCurrentBarrier()) { setError('又有新的磁盘版本或写入未完成。当前稿保留，请重新查看版本后决定。'); setConflictVersion(await api.load(session.workspaceId)); return; }
        setConflictVersion(null); setError(''); setNotice('已按你的选择把当前稿保存为新版本，原磁盘版本仍保留在历史中。');
      } else {
        const viewport = { ...activeViewport() }; titleSession.current = null; setTitleId(null);
        saves.sessions.delete(session.workspaceId); const loaded = await saves.activate(session.workspaceId); if (!loaded) throw new Error('load failed');
        const fresh = await api.load(session.workspaceId), next = createEditorState(loaded.bundle); next.view.viewport = viewport;
        assign(next); bodyDraft.current = clone(loaded.bundle.draft); bodyBase.current = clone(loaded.bundle.draft);
        if (bodyView.current) replaceEditorBlocks(bodyView.current, loaded.bundle.draft.blocks, { preserveSelection: true });
        userTitleRef.current = savedUserTitle.current = loaded.bundle.workspace.userTitle; setUserTitle(userTitleRef.current); recordRef.current = fresh; setRecord(fresh); setImages(loaded.bundle.assets); bodyLocalRedo.current = false;
        workspaceSessions.delete(session.workspaceId); setConflictVersion(null); setError(''); setNotice('已明确放弃未保存内容并载入磁盘版本。已提交的历史版本仍然保留。');
      }
    } catch (error) { setError(message(error, '版本处理未完成，当前资料继续保留。')); } finally { setBusy(false); }
  }
  async function revealExport() {
    if (!exportLocation || !api.revealExport) return;
    try { await api.revealExport(exportLocation); } catch { setError('无法在访达中显示。导出已成功，请按上方实际位置查找。'); }
  }
  async function openMarkdownExport(withMedia = false) {
    if (busy || exportStarting.current) return; exportStarting.current = true;
    try {
      if (!await saveCurrentBarrier()) { setError('保存未完成，当前编辑仍然保留。请先重试保存，再导出。'); return; }
      setExportKind('draft'); setIncludeExportMedia(withMedia); setExportMediaPreview(null); setExportPreviewError(''); setExportProgress(null); setExportLocation(null);
      try { const preview = api.previewExportMedia ? await api.previewExportMedia(saves.active!.workspaceId) : { items: [], totalBytes: 0, missingCount: 0 }; if (mounted.current) setExportMediaPreview(preview); }
      catch { if (mounted.current) setExportPreviewError('无法检查本地音视频，当前稿保持原样。关闭后重试，或继续不含音视频的导出。'); }
    } finally { exportStarting.current = false; }
  }
  async function cancelMarkdownExport() {
    const operationId = exportOperation.current;
    if (!operationId || !api.cancelExport || exportCancelling) return;
    setExportCancelling(true);
    try { await api.cancelExport(operationId); } catch { if (mounted.current) { setExportCancelling(false); setError('取消请求未能送达，请稍后重试。不会覆盖现有目标。'); } }
  }
  async function exportXmind() {
    if (busy || exportStarting.current) return; exportStarting.current = true;
    try {
      if (!api.exportXmind || !await saveCurrentBarrier()) { setExportPreviewError('保存未完成，没有导出旧导图。当前编辑仍然保留，请重试保存。'); return; }
      const session = saves.active!; setBusy(true); setExportLocation(null); setExportPreviewError('');
      const result = await api.exportXmind(session.workspaceId, { draftRevision: session.bundle.workspace.draftRevision, mapRevision: session.bundle.workspace.mapRevision });
      setXmindConfirm(false);
      if (result.status === 'exported') {
        setExportLocation(result.path || null);
        setNotice(`已导出可编辑 .xmind · 导图版本 ${result.mapRevision ?? session.bundle.workspace.mapRevision}${result.warnings?.length ? `。${result.warnings.join('；')}` : ''}`);
      } else setNotice('已取消导图导出，当前稿与原有文件未改变。');
    } catch (error) { setExportPreviewError(message(error, '导图导出失败，当前导图和已有文件保持原样。')); } finally { exportStarting.current = false; setBusy(false); }
  }
  async function exportMarkdown() {
    if (!exportKind || busy || exportStarting.current) return;
    if (includeExportMedia && (!exportMediaPreview || exportMediaPreview.missingCount > 0)) { setError('音视频资料不完整，请恢复缺失文件，或取消包含音视频。'); return; }
    exportStarting.current = true;
    if (!await saveCurrentBarrier()) { exportStarting.current = false; setExportPreviewError('保存未完成，本次没有导出旧稿。当前编辑仍然保留，请重试保存。'); return; }
    const kind = exportKind, session = saves.active!, operationId = crypto.randomUUID(); exportOperation.current = operationId;
    setBusy(true); setExportProgress(null); setExportCancelling(false); setExportLocation(null); setExportPreviewError('');
    try {
      const result = await api.export(session.workspaceId, kind, { draftRevision: session.bundle.workspace.draftRevision, mapRevision: session.bundle.workspace.mapRevision }, { includeLocalMedia: includeExportMedia, operationId });
      if (result.status === 'cancelled') { setNotice('已取消导出，当前稿与原有文件未改变。'); }
      else {
        setExportLocation(result.path || null);
        setNotice(includeExportMedia ? 'Markdown 与所选本地音视频已导出为目录包；图片和媒体均使用相对路径。' : 'Markdown 已导出；必要图片随目录包保存，音视频未包含。');
      }
      setExportKind(null);
    } catch (error) { setExportPreviewError(message(error, '导出未完成，当前稿与原目标保持不变。请检查资源或磁盘后重试。')); }
    finally { exportStarting.current = false; exportOperation.current = null; setBusy(false); setExportProgress(null); setExportCancelling(false); }
  }
  function dividerMove(event: React.PointerEvent<HTMLDivElement>) { if (splitPointer.current !== event.pointerId || !splitHost.current) return; const rect = splitHost.current.getBoundingClientRect(); setSplit(Math.max(30, Math.min(75, (event.clientX - rect.left) / rect.width * 100))); }
  function referenceBlock(block: DraftBlock, identity: string, kind: 'body' | 'subtitle'): React.ReactNode {
    const props = { 'data-source-block': block.id, 'data-source-kind': kind, 'data-source-identity': identity };
    const children = block.children?.map(child => <React.Fragment key={child.id}>{referenceBlock(child, identity, kind)}</React.Fragment>);
    if (block.type === 'heading') { const Tag = `h${Math.min(3, block.level || 1)}` as 'h1' | 'h2' | 'h3'; return <Tag {...props}><Runs runs={block.runs} /></Tag>; }
    if (block.type === 'bulletList') return <ul>{children}</ul>; if (block.type === 'orderedList') return <ol start={block.start}>{children}</ol>; if (block.type === 'listItem') return <li>{children}</li>; if (block.type === 'blockquote') return <blockquote>{children}</blockquote>;
    if (block.type === 'image') return <>{block.assetRefs?.map(ref => <img key={`${ref.assetId}@${ref.version}`} src={api.assetUrl(saves.active!.workspaceId, ref)} alt="来源本地图片" />)}</>;
    return <p {...props}><Runs runs={block.runs} /></p>;
  }
  if (!state || !saves.active || !bodyDraft.current || !layout || !projection) return <section className="e1-workspace e1-opening"><header className="e1-header"><button onClick={props.onBack}>← 返回阅读</button><h1>手动整理</h1></header><div className="e1-initialization"><p>{error || '正在读取已保存的工作区…'}</p></div></section>;
  const session = saves.active, selected = selectedId(), selectedNode = state.map.nodes[selected], viewport = state.view.viewport, activeGesture = gesture.current;
  const width = layout.bounds.x + layout.bounds.width + 24, height = layout.bounds.y + layout.bounds.height + 24;
  const userTitleDirty = userTitle !== savedUserTitle.current, saveStatus = userTitleDirty && session.status === 'saved' ? 'dirty' : session.status;
  const nodeEntries = treeOrder(state.map, collapsed), media = currentMedia(content), av = media.filter(item => item.kind === 'video' || item.kind === 'audio'), playing = av[mediaIndex] || av[0];
  const source = session.bundle.sources.find(source => source.sourceRevisionId === record.sourceRevisionId) || session.bundle.sources.at(-1);
  const subtitleVersions = sourceSubtitleVersions(session.bundle.transcripts, session.workspaceId, content.subtitle);
  const selectedSubtitle = subtitleVersion === null ? subtitleVersions.current : subtitleVersions.versions.find(version => version.key === subtitleVersion);
  const sourceRefs = reference ? highlightPieces(reference.resolved.text, reference.ref.range) : null;
  const onToolDown = (event: React.MouseEvent) => { if (!(event.target as HTMLElement).closest('input,select,textarea')) event.preventDefault(); };
  function openCard(nodeId: string) {
    try { setCard(buildKnowledgeCard(liveMap(), nodeId, content, Date.now())); }
    catch { setNotice('该节点暂时不能生成知识卡片。'); }
  }
  async function cardPng(target: KnowledgeCardTarget) {
    if (!card || !api.knowledgeCardPng) return;
    setCardBusy(true);
    try {
      const result = await api.knowledgeCardPng(card, target);
      if (result.status === 'exported') { setNotice(`已导出知识卡片：${result.path}`); setCard(null); }
      else if (result.status === 'copied') { setNotice('已复制知识卡片图片。'); setCard(null); }
      else setNotice('已取消导出，卡片内容未改变。');
    } catch (error) { setError(message(error, '知识卡片导出未完成，卡片内容未改变。')); }
    finally { setCardBusy(false); }
  }
  return <section ref={workspaceHost} className={`e1-workspace e1-theme-${state.map.theme.id.includes('dark') ? 'dark' : 'light'}`} inert={props.interactionBlocked || installationLocked.current || undefined} onBeforeInputCapture={event => { if (installationLocked.current) { event.preventDefault(); event.stopPropagation(); } }} onCompositionStartCapture={event => { if (installationLocked.current) { event.preventDefault(); event.stopPropagation(); } }} data-workspace-id={session.workspaceId} aria-label={props.creationMode ? '笔记' : '手动整理'} onFocusCapture={event => { if ((event.target as HTMLElement).closest('.ProseMirror')) ++focusEpoch.current; }}>
    <header className="e1-header"><button className="e1-back btn-ghost" onClick={props.onBack}>← 返回</button><label className="e1-my-title"><span>我的标题</span><input aria-label="我的标题" readOnly={readOnly} value={userTitle} maxLength={1000} onCompositionStart={() => composition('workspace-title', true)} onCompositionEnd={() => composition('workspace-title', false)} onChange={event => { if (installationLocked.current || userTitleRef.current === event.target.value) return; manualChange(); userTitleRef.current = event.target.value; setUserTitle(event.target.value); scheduleSave(); }} onBlur={() => { if (!composing.current.size) void saveTitle(); }} /></label>{(() => { const hasSavedContent = saveStatus === 'saved' && !!state && !!bodyDraft.current && (bodyDraft.current.blocks.some(block => (block.runs ?? []).some(run => (run.text ?? '').trim())) || Object.keys(state.map.nodes).length > 1); return props.digestStatus && !props.digestStatus.inLibrary && !props.digestStatus.active && props.onMarkDone && hasSavedContent ? <button className="btn" data-testid="editor-mark-done" disabled={busy} onClick={async () => { setBusy(true); try { await props.onMarkDone!(); setNotice('已放进消化库，标记为已消化。'); } catch (error) { setError(message(error, '放进消化库未完成，笔记保持原样。')); } finally { setBusy(false); } }}>完成，放进消化库</button> : null; })()}
    <span className={`e1-save-status ${saveStatus}`} data-testid="editor-save-status" role="status">{compositionCount ? '中文输入中 · 待保存' : ({ saved: '已保存', dirty: '待保存', saving: '保存中', failed: '保存失败', conflict: '版本冲突 · 当前稿保留' })[saveStatus]}{saveStatus !== 'saved' && !compositionCount && <button className="e1-save-retry" data-testid="editor-save" onMouseDown={onToolDown} onClick={() => void save()}>{saveStatus === 'failed' || saveStatus === 'conflict' ? '重试保存' : '保存'}</button>}</span><div className="e1-top-actions">{props.creationMode && readOnly && <button className="btn-primary" data-testid="creation-enable-edit" onClick={() => void beginEditing()}>编辑</button>}<div className="segmented e1-layout-switch" role="group" aria-label="工作区布局"><button data-testid="editor-display-split" aria-pressed={display === 'split'} title="双栏" aria-label="双栏" onMouseDown={preserveCompositionFocus} onClick={() => switchDisplay('split')}><IconSplit size={15} /></button><button data-testid="editor-display-map" aria-pressed={display === 'map'} title="导图" aria-label="导图" onMouseDown={preserveCompositionFocus} onClick={() => switchDisplay('map')}><IconMap size={15} /></button><button data-testid="editor-display-document" aria-pressed={display === 'document'} title="文稿" aria-label="文稿" onMouseDown={preserveCompositionFocus} onClick={() => switchDisplay('document')}><IconDocument size={15} /></button></div><details className="e1-menu-host"><summary className="btn e1-export-toggle" aria-label="导出"><IconExport size={14} />导出</summary><div className="e1-menu e1-menu-right"><button data-testid="editor-export" disabled={busy} onClick={() => void openMarkdownExport()}>Markdown（.md 与图片）</button>{api.exportXmind && <button data-testid="editor-export-xmind" disabled={busy} onClick={() => { setExportPreviewError(''); setXmindConfirm(true); }}>XMind（.xmind）</button>}<button disabled={busy} onClick={() => void openMarkdownExport(true)}>媒体包</button></div></details><details className="e1-menu-host"><summary className="icon-button" aria-label="更多操作"><IconMore size={18} /></summary><div className="e1-menu e1-menu-right"><button disabled={readOnly} onClick={() => historyAction('undo')}>撤销 ⌘Z</button><button disabled={readOnly} onClick={() => historyAction('redo')}>重做 ⇧⌘Z</button><button onClick={() => void showHistory()}>已保存版本</button><button aria-pressed={nodePanel} onClick={() => { if (canSwitchEditorView()) setNodePanel(!nodePanel); }}>{readOnly ? '节点资料' : '节点设置'}</button>{!props.creationMode && <button data-testid="editor-digest-request" disabled={busy} onClick={async () => { if (props.digestStatus?.active && callbacks.current.onDigestProgress) { callbacks.current.onDigestProgress(); return; } setBusy(true); try { await callbacks.current.onDigestRequest(); } catch (error) { setError(message(error, '消化请求未能保存，请稍后重试。手动整理稿不受影响。')); } finally { setBusy(false); } }}>{props.digestStatus?.active ? props.digestStatus.label : '消化'}</button>}{props.moreMenu}{props.digestStatus?.inLibrary && props.onRemoveFromDigestLibrary && <button disabled={busy} onClick={async () => { setBusy(true); try { await callbacks.current.onRemoveFromDigestLibrary?.(); } catch (error) { setError(message(error, '移出消化库未完成，资料保持原样。')); } finally { setBusy(false); } }}>从消化库移出</button>}<button onClick={() => void callbacks.current.openOriginal()}>查看原链接</button><button disabled={readOnly} onClick={() => command({ type: 'setTheme', theme: state.map.theme.id.includes('dark') ? { id: 'light', name: '浅色' } : { id: 'dark', name: '深色' } }, false)}>导图深浅主题</button></div></details></div></header>
    {props.headerExtra}
    <div className="e1-context"><span>{PLATFORM_NAMES[content.platform]} · 来源标题：{content.title || '无标题收藏'}</span></div>
    {(error || session.status === 'failed' || session.status === 'conflict') && <div className="e1-error" role="alert"><span>{error || (session.status === 'conflict' ? '磁盘上已有较新版本，当前编辑保留。请查看已保存版本后决定恢复。' : '保存失败，当前稿仍在此窗口。请重试或取消离开。')}</span><button onClick={() => { setError(''); void save(); }}>重试保存</button><button onClick={() => void showHistory()}>查看版本</button>{session.status === 'conflict' && <button onClick={() => void inspectConflict()}>解决版本冲突</button>}<button aria-label="收起提示" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="e1-notice" role="status">{notice}<button aria-label="收起状态说明" onClick={() => setNotice('')}>×</button></div>}
    {exportLocation && <div className="e1-notice e1-export-result" role="status"><span className="e1-export-location">实际导出位置：{exportLocation}</span>{api.revealExport && <button data-testid="editor-export-reveal" onClick={() => void revealExport()}>在访达中显示</button>}</div>}
    <div className={`e1-panes e1-display-${display}`} ref={splitHost} style={{ '--e1-map-share': `${split}%` } as React.CSSProperties}>
      <section className="e1-map-pane" aria-label="导图与大纲"><div className="e1-pane-heading"><div className="segmented" role="tablist" aria-label="树视图"><button role="tab" aria-selected={mapView === 'map'} onMouseDown={preserveCompositionFocus} onClick={() => switchMapView('map')}>导图</button><button role="tab" aria-selected={mapView === 'outline'} onMouseDown={preserveCompositionFocus} onClick={() => switchMapView('outline')}>大纲</button></div><span>{Object.keys(state.map.nodes).length} 个节点</span>{!readOnly && <div className="e1-tree-toolbar e1-structure-group" role="group" aria-label="导图结构操作"><button onMouseDown={onToolDown} onClick={() => structure('addChild')}>＋子级</button><button onMouseDown={onToolDown} onClick={() => structure('addSibling')}>＋同级</button><details><summary className="e1-menu-toggle" aria-label="更多结构操作"><IconMore size={16} /></summary><div className="e1-menu"><button onClick={() => structure('addSiblingBefore')} disabled={selected === state.map.rootId}>＋前同级 ⇧↵</button><button onClick={() => structure('insertParent')} disabled={selected === state.map.rootId}>插入父级 ⌘↵</button><button onClick={() => startTitle(selected)}>编辑标题 Space</button><button onClick={() => reorder(-1)}>同级上移 ⌥↑</button><button onClick={() => reorder(1)}>同级下移 ⌥↓</button><button onClick={() => setMoveTo(selectedNode.parentId || state.map.rootId)} disabled={selected === state.map.rootId}>移动到分支…</button><button onClick={() => copy()}>复制分支 ⌘C</button><button onClick={() => copy(true)} disabled={selected === state.map.rootId}>剪切分支 ⌘X</button><button onClick={pasteBranchHere}>粘贴为子级 ⌘V</button><button onClick={() => command({ type: 'copySubtree', nodeId: selected, parentId: selectedNode.parentId || state.map.rootId })}>复制子树 ⌘D</button><button data-testid="editor-read-selected" onClick={readSelected}>阅读选中</button>{api.knowledgeCardPng && <button onClick={() => openCard(selected)}>生成知识卡片</button>}<button disabled={selected === state.map.rootId} onClick={() => command({ type: 'promoteChildren', nodeId: selected })}>仅删节点，提升子级</button><button disabled={selected === state.map.rootId} onClick={() => command({ type: 'deleteSubtree', nodeId: selected })}>删除整个分支</button><button onClick={() => { setCollapsed(new Set()); }}>展开全部</button><button disabled={!selectedNode.children.length} onClick={() => toggleCollapsed(selected)}>{collapsed.has(selected) ? '展开分支' : '折叠分支'}</button><button onClick={() => void previewHeadings()}>按稿件标题建树…</button><button aria-pressed={nodePanel} onClick={() => { if (canSwitchEditorView()) setNodePanel(!nodePanel); }}>节点设置</button></div></details></div>}</div>
      {mapView === 'map' && <div className="e1-viewport-controls" role="group" aria-label="画布视野" onMouseDown={onToolDown}><button aria-label="缩小画布" data-testid="editor-zoom-out" disabled={viewport.zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.2)}><IconZoomOut size={15} /></button><button aria-label="画布缩放比例，点击恢复 100%" data-testid="editor-zoom-reset" className="e1-zoom-readout" onClick={() => setViewport(zoomAt(activeViewport(), 1, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 }))}>{Math.round(viewport.zoom * 100)}%</button><button aria-label="放大画布" disabled={viewport.zoom >= MAX_ZOOM} onClick={() => zoomBy(1.2)}><IconZoomIn size={15} /></button><button aria-label="适合全部" data-testid="editor-fit" onClick={fitAll}><IconFitView size={15} /></button><button aria-label="定位选中" data-testid="editor-center-selected" onClick={centerSelected}><IconTarget size={15} /></button></div>}
      <div className={`e1-canvas ${activeGesture?.active ? `gesture-${activeGesture.kind}` : ''}`} hidden={mapView !== 'map'} ref={tree} data-testid="editor-canvas" data-gesture={activeGesture?.active ? activeGesture.kind : 'idle'} data-viewport-zoom={viewport.zoom} data-viewport-x={viewport.x} data-viewport-y={viewport.y} role="tree" aria-label="我的导图" tabIndex={0} onKeyDown={canvasKey} onCopy={event => canvasCopy(event)} onCut={event => canvasCopy(event, true)} onPaste={canvasPaste} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => finishGesture(event.pointerId, event.clientX, event.clientY)} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}>
        <div ref={world} className="e1-viewport-world" data-testid="editor-world" style={{ width, height, transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})` }}><svg width={width} height={height} aria-hidden="true">{Object.values(projection.nodes).flatMap(node => node.children.map(child => { const a = layout.nodes[node.id], b = layout.nodes[child]; return <path key={child} data-edge-child={child} d={`M ${a.x + a.width} ${a.y + a.height / 2} C ${a.x + a.width + 27} ${a.y + a.height / 2},${b.x - 27} ${b.y + b.height / 2},${b.x} ${b.y + b.height / 2}`} />; }))}</svg>
          {Object.values(projection.nodes).map(node => { const position = layout.nodes[node.id], target = drop?.targetId === node.id ? drop : null; return <div key={node.id} data-node-id={node.id} className={`e1-node ${node.id === state.map.rootId ? 'root' : ''} ${node.id === selected ? 'selected' : ''} ${activeGesture?.active && activeGesture.nodeId === node.id ? 'drag-source' : ''} ${target ? `drop-${target.kind} ${target.allowed ? 'drop-valid' : 'drop-invalid'}` : ''}`} role="treeitem" aria-selected={node.id === selected} aria-expanded={state.map.nodes[node.id].children.length ? !collapsed.has(node.id) : undefined} style={{ left: position.x, top: position.y, width: nodePresentationWidth(node.title), fontWeight: node.style?.bold === undefined ? undefined : node.style.bold ? 700 : 400, fontStyle: node.style?.italic ? 'italic' : undefined, background: node.style?.fill, color: node.style?.textColor }} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button') && !gesture.current?.active) startTitle(node.id); }}>
            {titleId === node.id && mapView === 'map' ? <RichEditor key={`title-${node.id}`} title blocks={titleDraft.current} inheritedBold={node.style?.bold} inheritedItalic={node.style?.italic} onChange={blocks => { if (installationLocked.current || JSON.stringify(blocks) === JSON.stringify(titleDraft.current)) return; manualChange(); titleDraft.current = blocks; replacePending(); scheduleSave(); }} onComposition={value => composition('node', value)} onCommit={() => { commitTitle(); focusCanvasLater(); }} onCancel={() => { commitTitle(true); focusCanvasLater(); }} onBlur={() => commitTitle()} ready={view => { titleView.current = view; }} /> : <div className="e1-node-title"><Runs runs={node.title} /></div>}
            {node.image && <button className="e1-node-image" onMouseDown={onToolDown} onClick={() => { if (composing.current.size) { setNotice('请先完成当前输入，再查看图片出处。'); return; } setReference(null); setRightTab('source'); setSourceTab('images'); setSourceImage(`${node.image!.assetId}@${node.image!.version}`); if (display === 'map') setDisplay('split'); }} aria-label="查看节点图片出处"><img src={`${api.assetUrl(session.workspaceId, node.image)}?thumbnail=1`} alt="已保存的节点图片" onError={() => setImageErrors(previous => new Set(previous).add(`${node.image!.assetId}@${node.image!.version}`))} /></button>}
            {node.image && imageErrors.has(`${node.image.assetId}@${node.image.version}`) && <span className="e1-missing-image">本地图片缺失或损坏</span>}
            <div className="e1-node-badges">{node.sourceRefs.length > 0 && <button onMouseDown={onToolDown} onClick={() => void openReference(node.sourceRefs[0])}>来源 {node.sourceRefs.length}</button>}{state.map.nodes[node.id].children.length > 0 && <button onMouseDown={onToolDown} aria-label={collapsed.has(node.id) ? '展开此分支' : '折叠此分支'} onClick={() => toggleCollapsed(node.id)}>{collapsed.has(node.id) ? `＋${state.map.nodes[node.id].children.length}` : '−'}</button>}{node.notes && <button onClick={() => { selectNode(node.id); setNodePanel(true); }}>备注</button>}</div>
            {api.knowledgeCardPng && <button className="e1-node-card" aria-label="生成知识卡片" title="生成知识卡片" onMouseDown={onToolDown} onClick={event => { event.stopPropagation(); openCard(node.id); }}><IconCard size={14} /></button>}
          </div>; })}
        </div>
      </div>
      {mapView === 'outline' && <div className="e1-outline" ref={outline} role="tree" aria-label="我的大纲" tabIndex={0} onKeyDown={canvasKey} onCopy={event => canvasCopy(event)} onCut={event => canvasCopy(event, true)} onPaste={canvasPaste}>{nodeEntries.map(entry => { const node = state.map.nodes[entry.id]; return <div key={node.id} data-outline-node-id={node.id} className={`e1-outline-row ${node.id === selected ? 'selected' : ''}`} role="treeitem" aria-selected={node.id === selected} style={{ paddingLeft: 12 + entry.depth * 20 }}><button className="e1-outline-collapse" disabled={!node.children.length} aria-label={collapsed.has(node.id) ? '展开分支' : '折叠分支'} onClick={() => toggleCollapsed(node.id)}>{node.children.length ? collapsed.has(node.id) ? '▸' : '▾' : '·'}</button><button className="e1-outline-title" onClick={() => selectNode(node.id)} onDoubleClick={() => startTitle(node.id)}><Runs runs={node.title} /></button>{titleId === node.id && <RichEditor key={`outline-title-${node.id}`} title blocks={titleDraft.current} inheritedBold={node.style?.bold} onChange={blocks => { if (installationLocked.current || JSON.stringify(blocks) === JSON.stringify(titleDraft.current)) return; manualChange(); titleDraft.current = blocks; replacePending(); scheduleSave(); }} onComposition={value => composition('node', value)} onCommit={() => { commitTitle(); focusCanvasLater(); }} onCancel={() => commitTitle(true)} onBlur={() => commitTitle()} ready={view => { titleView.current = view; }} />}{node.sourceRefs.length > 0 && <button className="e1-outline-ref" onMouseDown={onToolDown} onClick={() => void openReference(node.sourceRefs[0])}>出处</button>}</div>; })}</div>}
      <div className="e1-map-hint" role="status">{activeGesture?.active && activeGesture.kind === 'node' ? drop ? `${drop.allowed ? '' : '不可放置：'}${({ before: '插在前面', after: '插在后面', child: '成为子级' })[drop.kind]}${drop.reason ? ` · ${drop.reason}` : ''}` : '移到节点上选择前／后／子级；边缘可自动平移，Escape 取消' : '空白拖动／滚轮平移 · ⌘滚轮缩放'}{!readOnly && <details className="e1-help"><summary className="icon-button" aria-label="快捷键说明"><IconQuestion size={15} /></summary><div className="e1-help-pop"><p>Space 编辑标题 · Tab 加子级 · ↵ 加同级 · ⌘滚轮缩放 · ⌘Z 撤销 · ⇧⌘Z 重做 · ⌘F 文内查找 · ⌘S 保存 · Esc 取消拖动</p></div></details>}</div>
      {nodePanel && <NodePanel readOnly={readOnly} node={selectedNode} onClose={() => { if (composing.current.has('notes')) { setNotice('请先完成备注中的中文输入。'); return; } setNodePanel(false); }} onComposition={value => composition('notes', value)} onNotes={notes => command({ type: 'setNotes', nodeId: selected, notes }, false)} onStyle={style => command({ type: 'setNodeStyle', nodeId: selected, style }, false)} onTitleEdit={() => startTitle(selected)} onPartialBold={() => { if (titleView.current) toggleInlineMark('strong', selectedNode.style?.bold)(titleView.current.state, titleView.current.dispatch); else setNotice('先编辑节点标题并选择文字，再设置局部粗体。'); }} onBold={() => command({ type: 'toggleNodeBold', nodeId: selected }, false)} onImage={() => void openImages('node')} onRemoveImage={() => command({ type: 'setImage', nodeId: selected }, false)} onReference={ref => void openReference(ref)} onRelink={() => { setRelink(true); setNotice('在右侧选择新的单块文字，再点击「重新关联选区」。'); }} onRemoveReference={index => command({ type: 'setReferences', nodeId: selected, sourceRefs: selectedNode.sourceRefs.filter((_, at) => at !== index) }, false)} onCard={api.knowledgeCardPng ? () => openCard(selected) : undefined} />}
      </section>
      <div className="e1-divider" role="separator" aria-label="调整导图与资料宽度" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={75} aria-valuenow={Math.round(split)} tabIndex={0} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSplit(value => Math.max(30, Math.min(75, value + (event.key === 'ArrowRight' ? 2 : -2)))); } }} onPointerDown={event => { splitPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={dividerMove} onPointerUp={event => { splitPointer.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { splitPointer.current = null; }} onLostPointerCapture={() => { splitPointer.current = null; }} />
      <aside className="e1-document-pane" aria-label="文稿与来源"><div className="e1-pane-heading"><div className="segmented" role="tablist" aria-label="文稿资料"><button role="tab" aria-selected={rightTab === 'draft'} onMouseDown={onToolDown} onClick={() => switchRightTab('draft')}>我的整理稿</button><button role="tab" aria-selected={rightTab === 'source'} onMouseDown={onToolDown} onClick={() => switchRightTab('source')}>来源资料</button></div>{props.creationMode && !readOnly && <div className="segmented e1-read-switch" role="group" aria-label="阅读或编辑文稿"><button data-testid="creation-draft-mode" aria-pressed={!draftReading} onMouseDown={preserveCompositionFocus} onClick={() => { if (draftReading) void toggleDraftReading(); }}>编辑</button><button aria-pressed={draftReading} onMouseDown={preserveCompositionFocus} onClick={() => { if (!draftReading) void toggleDraftReading(); }}>阅读</button></div>}{(relink || hasSelection) && <button className="e1-floating-selection" disabled={readOnly} data-testid="editor-from-selection" onMouseDown={onToolDown} onClick={() => void addSelection()}>{relink ? '重新关联选区' : '选区加入导图'}</button>}</div>
        <div className="e1-draft-pane" hidden={rightTab !== 'draft'}>{props.creationMode && <div className="e1-creation-read-switch"><span>{props.generatedDraft ? 'AI 整理稿，可编辑校对' : '人工整理稿'} · {draftReading ? '阅读' : '编辑 · 自动保存'}</span>{props.creationMode && readOnly && <button className="btn-ghost" data-testid="creation-draft-mode" onMouseDown={preserveCompositionFocus} onClick={() => { if (!draftReading) void toggleDraftReading(); }} hidden={draftReading}>阅读预览</button>}</div>}<div hidden={draftReading} className="e1-body-toolbar" role="toolbar" aria-label="正文格式" onMouseDown={onToolDown}><select aria-label="正文块格式" value="" onChange={event => { const type = event.target.value; bodyCommand(view => setTextBlock(type === 'paragraph' ? 'paragraph' : 'heading', type === 'paragraph' ? 1 : Number(type) as 1 | 2 | 3)(view.state, view.dispatch)); }}><option value="" disabled>段落／标题…</option><option value="paragraph">正文</option><option value="1">一级标题</option><option value="2">二级标题</option><option value="3">三级标题</option></select><button aria-label="正文粗体" onClick={() => bodyCommand(view => toggleInlineMark('strong')(view.state, view.dispatch))}><b>B</b></button><button aria-label="正文斜体" onClick={() => bodyCommand(view => toggleInlineMark('em')(view.state, view.dispatch))}><i>I</i></button><button onClick={() => bodyCommand(view => wrapBlock('bulletList')(view.state, view.dispatch))}>• 列表</button><details className="e1-menu-host"><summary className="icon-button" aria-label="更多格式"><IconMore size={15} /></summary><div className="e1-menu"><button aria-label="行内代码" onClick={() => bodyCommand(view => toggleInlineMark('code')(view.state, view.dispatch))}>行内代码</button><button onClick={() => bodyCommand(view => wrapBlock('orderedList')(view.state, view.dispatch))}>编号列表</button><button onClick={() => bodyCommand(view => wrapBlock('blockquote')(view.state, view.dispatch))}>引用块</button><button onClick={() => bodyCommand(view => changeListIndent('indent')(view.state, view.dispatch))}>列表缩进</button><button onClick={() => bodyCommand(view => changeListIndent('outdent')(view.state, view.dispatch))}>减少缩进</button><button onClick={() => setLink('')}>链接</button><button onClick={() => void openImages('body')}>已有图片</button></div></details></div>{findOpen && <div className="e1-find"><label>文内查找 <input aria-label="文内查找" value={find} onChange={event => setFind(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && bodyView.current) { event.preventDefault(); setFindNotice(findText(bodyView.current, find, !event.shiftKey) ? '' : '未找到匹配文字'); } else if (event.key === 'Escape') { setFindOpen(false); setFindNotice(''); } }} /></label><button onMouseDown={onToolDown} onClick={() => bodyView.current && setFindNotice(findText(bodyView.current, find) ? '' : '未找到匹配文字')}>下一处</button><button aria-label="关闭查找" onClick={() => { setFindOpen(false); setFindNotice(''); }}>×</button><span role="status">{findNotice}</span></div>}
          <div className="e1-body-scroll">{draftReading && <DraftReading blocks={bodyDraft.current.blocks} assetUrl={ref => api.assetUrl(session.workspaceId, ref)} onReference={props.draftReferences ? blockId => { if(!exactDraftReferenceVersion(bodyDraft.current!,props.draftReferenceDocument)){setNotice('当前正文不属于这份自动生成引用的确切版本。历史引用保留，不会套用到恢复后或人工修改的稿件。');return;}const refs = props.draftReferences?.[blockId], original = props.draftReferenceDocument && blockById(props.draftReferenceDocument.blocks, blockId), current = blockById(bodyDraft.current!.blocks, blockId); if (original && JSON.stringify(original) !== JSON.stringify(current)) { setNotice('本段已有人工修改，未关联引用。'); return; } if (refs?.length) void openReference(refs[0]); else setNotice('本段为结构或人工内容，没有生成来源引用。'); } : undefined}/>}<div hidden={draftReading}><RichEditor readOnly={readOnly || draftReading} blocks={bodyDraft.current.blocks} assetUrl={ref => api.assetUrl(session.workspaceId, ref)} onUndo={() => historyAction('undo')} onRedo={() => historyAction('redo')} onPasteWarning={value => setNotice(value)} onChange={blocks => { if (applyingBody.current || installationLocked.current || JSON.stringify(blocks) === JSON.stringify(bodyDraft.current?.blocks)) return; manualChange(); bodyDraft.current = { ...bodyDraft.current!, blocks }; if (!historyInput.current) bodyLocalRedo.current = false; replacePending(); scheduleSave(); }} onComposition={value => composition('body', value)} onBlur={() => { if (!composing.current.has('body')) flushBody(); }} ready={view => { bodyView.current = view; }} /></div></div><details className="e1-document-footnote"><summary>说明</summary>来源只读；自动保存你的整理稿与导图。</details>
        </div>
        <div className="e1-source-pane" hidden={rightTab !== 'source'}><div className="e1-source-tabs" role="group" aria-label="来源资料类型"><div className="segmented">{([['body', '原文／简介'], ['subtitle', '已有字幕'], ['images', '图片'], ['ocr', '图片文字'], ['asr', content.kind === 'audio' ? '音频文字稿' : '视频文字稿'], ['media', '音视频']] as const).map(([key, label]) => <button aria-pressed={sourceTab === key} key={key} onMouseDown={onToolDown} onClick={() => { if (!canSwitchEditorView()) return; setSourceTab(key); setReference(null); selectedSource.current = null; }}>{label}</button>)}</div></div>
          {!!record.unavailableSources?.length && <section className="e1-source-update" aria-label="不可用的固定来源版本" data-testid="editor-unavailable-sources"><strong>部分转录来源暂不可用。人工正文、导图与旧引用保持；不会自动换成其他版本。</strong><ul>{record.unavailableSources.map(item => <li key={`${item.transcriptId}@${item.revision}:${item.segmentId}`} style={{ overflowWrap: 'anywhere' }}><span>转录 {item.transcriptId} · revision {item.revision} · 段 {item.segmentId}</span><br /><span>媒体 {item.mediaId ?? '未知'} · 分P {item.partId ?? '未知'} · {item.reason}</span>{item.referencedByNodeIds.length > 0 && <small>当前导图的固定引用节点：{item.referencedByNodeIds.join('、')}。恢复该确切版本前，包含这些引用的导图导出不会改用其他稿。</small>}</li>)}</ul></section>}
          {record.sourceUpdated && <div className="e1-source-update">来源已有新版本。你的稿件和已有节点引用保持原版本；可重新选择明确关联。</div>}
          {reference && sourceRefs && <section className="e1-reference" aria-label="引用时版本" ref={referenceHost}><div><h3>引用时版本</h3><button onMouseDown={onToolDown} onClick={() => setReference(null)}>回到当前资料</button></div><p className="e1-reference-version">{reference.ref.kind === 'userDraft' ? `我的整理稿 · 已保存版本 ${reference.ref.revision}` : reference.ref.kind === 'transcript' ? `转录／字幕 · 已保存版本 ${reference.ref.revision} · 仅定位文字，无可信逐句时间` : reference.ref.kind === 'ocr' ? `固定图片文字 · ${reference.ref.correctionRevision ? `校对版本 ${reference.ref.correctionRevision}` : '原始版本 1'}` : '固定的来源正文版本'}</p><p className="e1-highlighted-source">{sourceRefs.before}<mark>{sourceRefs.selected}</mark>{sourceRefs.after}</p>{reference.resolved.assets.filter((asset, index, all) => all.findIndex(value => value.assetId === asset.assetId && value.version === asset.version) === index).map(asset => <figure className="e1-reference-image" key={`${asset.assetId}@${asset.version}`}><img src={api.assetUrl(session.workspaceId, asset)} alt="引用时的本地图片" onError={() => setError('引用图片缺失或损坏，未回退到网络图片。')} /></figure>)}<small>仅展示确切引用时版本；正文前插、拆合或删除不会悄悄换出处。</small></section>}
          <div className="e1-source-scroll" ref={sourceHost} onMouseUp={rememberSourceSelection} onKeyUp={rememberSourceSelection} hidden={!!reference}>
            {sourceTab === 'body' && <article className="e1-source-copy"><h2>来源正文 / 简介</h2><p className="e1-source-status">{source ? source.coverage.description || (source.coverage.complete ? '已取得来源正文' : '已取得部分来源正文') : '尚未取得可用正文，仍可写自己的笔记。'}{content.kind === 'video' && ' · 视频简介不代表转录全文'}</p>{source?.blocks.map(block => <React.Fragment key={block.id}>{referenceBlock(block, source.sourceRevisionId, 'body')}</React.Fragment>)}<button className="e1-original-link" onClick={() => void callbacks.current.openOriginal()}>查看原链接 <IconExternal size={12} /></button></article>}
            {sourceTab === 'subtitle' && <article className="e1-source-copy" data-subtitle-version={selectedSubtitle?.key || ''}><h2>已取得的字幕</h2><p className="e1-source-status">已保存的字幕版本，仅定位文字。</p><label>字幕版本 <select aria-label="来源字幕版本" value={selectedSubtitle?.key || ''} onChange={event => { setSubtitleVersion(event.target.value === subtitleVersions.current?.key ? null : event.target.value); setReference(null); selectedSource.current = null; window.getSelection()?.removeAllRanges(); }}>{!subtitleVersions.current && <option value="" disabled>当前采集字幕尚无可确认的已保存版本</option>}{subtitleVersions.versions.map(version => <option key={version.key} value={version.key}>{version.key === subtitleVersions.current?.key ? '当前采集字幕' : '历史保留字幕'} · {version.transcriptId.slice(-12)} · 修订 {version.revision}</option>)}</select></label>{selectedSubtitle ? <><p className="e1-source-status">{selectedSubtitle.key === subtitleVersions.current?.key ? '当前采集字幕' : '历史保留字幕（仅查看此固定版本）'} · 修订 {selectedSubtitle.revision}</p>{selectedSubtitle.segments.map(segment => <p key={`${segment.transcriptId}@${segment.revision}:${segment.segmentId}`} data-source-block={segment.segmentId} data-source-kind="subtitle" data-source-identity={`${segment.transcriptId}@${segment.revision}`}><Runs runs={segment.runs} /></p>)}</> : <p>尚未取得可确认的当前字幕。{subtitleVersions.versions.length ? '可从版本选择器查看已保留字幕；它们不会合并冒充当前正文。' : '尚无可引用的字幕。'}</p>}</article>}
            {sourceTab === 'images' && <div className="e1-source-images"><p>已固定的本地图片。</p>{props.ocrApi && props.onOpenOcr && <OcrResultsPanel pipelineComplete={props.pipelineComplete} waitingAsr={content.kind === 'video' || content.kind === 'audio'} api={props.ocrApi} contentId={content.id} onOpen={openOcrResult} onProgress={props.onDigestProgress} compact />}{images.length ? images.map((asset, index) => <figure key={`${asset.id}@${asset.version}`} data-source-asset={`${asset.id}@${asset.version}`} className={sourceImage === `${asset.id}@${asset.version}` ? 'highlighted' : ''}><img src={api.assetUrl(session.workspaceId, { assetId: asset.id, version: asset.version })} alt={`本地来源图片 ${index + 1}`} onError={() => setImageErrors(previous => new Set(previous).add(`${asset.id}@${asset.version}`))} /><figcaption>图片 {index + 1} · {asset.mime}{imageErrors.has(`${asset.id}@${asset.version}`) && ' · 本地文件缺失或损坏'}</figcaption></figure>) : <p>尚未取得本地图片，不能用网络图代替。</p>}</div>}
            {sourceTab === 'ocr' && (props.ocrApi && props.onOpenOcr ? <OcrResultsPanel pipelineComplete={props.pipelineComplete} waitingAsr={content.kind === 'video' || content.kind === 'audio'} api={props.ocrApi} contentId={content.id} onOpen={openOcrResult} onProgress={props.onDigestProgress} /> : <p>当前运行尚未启用图片文字。请使用消化入口查看能力状态。</p>)}
            {sourceTab === 'asr' && (props.asrApi && props.onOpenAsr ? <AsrResultsPanel pipelineComplete={props.pipelineComplete} api={props.asrApi} contentId={content.id} onOpen={target => { if (canSwitchEditorView()) callbacks.current.onOpenAsr?.(target); }} /> : <p>本运行尚未启用真实转录。旧字幕仅作为已取得来源保留。</p>)}
            {sourceTab === 'media' && <section className="e1-source-media"><h2>来源本地音视频</h2>{av.length > 1 && <label>播放资源 <select aria-label="工作区选择视频分P或音频" value={mediaIndex} onChange={event => { setMediaIndex(Number(event.target.value)); setPlayerError(''); }}>{av.map((item, index) => <option value={index} key={item.id}>{mediaLabel(item, index)}</option>)}</select></label>}{playing ? playing.state === 'succeeded' ? <><p>{mediaLabel(playing, av.indexOf(playing))} · 已保存本地文件</p>{playing.kind === 'video' ? <video key={playing.id} controls preload="metadata" src={props.mediaUrl(playing.id)} onError={() => setPlayerError('本地视频无法读取或解码，请返回阅读器检查资源。')} /> : <audio key={playing.id} controls preload="metadata" src={props.mediaUrl(playing.id)} onError={() => setPlayerError('本地音频无法读取或解码，请返回阅读器检查资源。')} />}</> : <p>此资源尚未成功保存，不能离线播放。</p> : <p>这条收藏没有已保存的音视频。</p>}{playerError && <p className="e1-error" role="alert">{playerError}</p>}<p className="e1-source-status">可正常播放和手动拖动进度。旧字幕只定位文字，不提供无依据的句子播放。</p></section>}
          </div>
        </div>
      </aside>
    </div>
    {link !== null && <Modal title="设置安全链接" onCancel={() => setLink(null)}><p>为当前选区设置 http、https 或 mailto 链接。清空可移除链接。</p><input className="e1-wide-input" aria-label="链接地址" value={link} onChange={event => setLink(event.target.value)} placeholder="https://…" /><div className="e1-modal-actions"><button disabled={!!link && !isSafeLink(link)} onClick={() => { bodyCommand(view => setSafeLink(link || null)(view.state, view.dispatch)); setLink(null); }}>应用链接</button><button onClick={() => setLink(null)}>取消</button></div></Modal>}
    {imagePicker && <ImagePicker api={api} workspaceId={session.workspaceId} images={images} content={content} mediaUrl={props.mediaUrl} busy={busy} onSelect={applyImage} onSelectMedia={id => void selectCurrentImage(id)} onCancel={() => setImagePicker(null)} />}
    {exportKind && <Modal title="导出 Markdown" onCancel={() => { if (!busy) { setExportKind(null); setNotice('已取消导出，当前稿与原有文件未改变。'); } }}>
      <label>导出内容 <select aria-label="导出内容" disabled={busy} value={exportKind} onChange={event => setExportKind(event.target.value as EditorExportKind)}><option value="draft">整理稿（正文 .md）</option><option value="map">导图大纲</option><option value="both">整理稿加导图大纲</option></select></label>
      <p>先保存当前版本，再通过系统对话框选择目标。含图片或音视频时将得到 .md 与附件目录包；图片使用相对路径 assets/。同名自动安全另存，不覆盖已有目标。</p>
      <ExportMediaSummary preview={exportMediaPreview} include={includeExportMedia} onChange={setIncludeExportMedia} disabled={busy} />
      {exportPreviewError && <p className="e1-error" role="alert">{exportPreviewError}</p>}
      {busy ? <ExportProgress progress={exportProgress} cancelling={exportCancelling} onCancel={() => void cancelMarkdownExport()} /> : <div className="e1-modal-actions"><button className="e1-primary" data-testid="editor-export-confirm" disabled={!!compositionCount || includeExportMedia && (!exportMediaPreview || exportMediaPreview.missingCount > 0)} onClick={() => void exportMarkdown()}>保存并选择导出位置</button><button onClick={() => { setExportKind(null); setNotice('已取消导出，当前稿与原有文件未改变。'); }}>取消</button></div>}
    </Modal>}
    {xmindConfirm && <Modal title="导出可编辑 XMind" onCancel={() => { if (!busy) { setXmindConfirm(false); setNotice('已取消导图导出，当前稿与原有文件未改变。'); } }}>
      <p>导出当前保存的单画布普通节点树，保留层级、顺序、中文／emoji／换行、节点主图、普通备注与可读来源。</p><p>局部混合文字样式和代码按完整文字降级；来源身份与媒体时间以备注说明，音视频不复制。画布位置、折叠和编辑历史不随文件带走。</p><p>系统对话框选择新位置，同名安全另存。导出成功后显示实际位置。</p>{exportPreviewError && <p className="e1-error" role="alert">{exportPreviewError}</p>}<div className="e1-modal-actions"><button className="e1-primary" data-testid="editor-export-xmind-confirm" disabled={busy || !!compositionCount} onClick={() => void exportXmind()}>{busy ? '正在准备…' : '保存并选择导出位置'}</button><button disabled={busy} onClick={() => { setXmindConfirm(false); setNotice('已取消导图导出，当前稿与原有文件未改变。'); }}>取消</button></div>
    </Modal>}
    {history && <Modal title="已保存版本" onCancel={() => !busy && setHistory(null)} className="e1-history-dialog"><p>恢复会先保存当前稿，并创建新的当前版本。恢复前版本和引用所需版本继续保留。这里不包含未落盘的最后输入。</p>{(['draft', 'map'] as const).map(kind => <section key={kind}><h3>{kind === 'draft' ? '我的整理稿' : '主导图'}</h3><div className="e1-history-list">{history[kind].map(entry => <div key={entry.revision}><span>版本 {entry.revision} · {date(entry.savedAt)}</span><button disabled={busy || entry.revision === (kind === 'draft' ? session.bundle.workspace.draftRevision : session.bundle.workspace.mapRevision)} onClick={() => void restoreVersion(kind, entry.revision)}>恢复此版本</button></div>)}</div></section>)}<button disabled={busy} onClick={() => setHistory(null)}>关闭</button></Modal>}
    {headingPreview && <Modal title="按整理稿标题建立导图" onCancel={() => setHeadingPreview(null)}><p>仅使用已保存版本 {headingPreview.revision} 的 H1–H3。缺级归到最近较浅标题，开头没有父标题时挂在根节点。</p><div className="e1-heading-preview">{headingPreview.headings.map(heading => <p key={heading.nodeId} style={{ paddingLeft: (heading.level - 1) * 18 }}>H{heading.level} · <Runs runs={heading.title} /></p>)}</div><label>应用方式 <select value={headingMode} onChange={event => setHeadingMode(event.target.value as 'append' | 'replace')}><option value="append">作为新的分支追加，保留人工节点</option><option value="replace">替换根下全部分支，可整次撤销</option></select></label>{headingMode === 'replace' && <p className="e1-warning">此操作会替换现有人工分支。只有点击下方应用才会生效。</p>}<div className="e1-modal-actions"><button onClick={() => { if (command({ type: 'applyHeadingTree', preview: headingPreview, mode: headingMode })) { setHeadingPreview(null); setCollapsed(new Set()); } }}>应用本次标题树</button><button onClick={() => setHeadingPreview(null)}>取消</button></div></Modal>}
    {card && <Modal title="生成知识卡片" onCancel={() => { if (!cardBusy) setCard(null); }} className="kc-dialog">
      <p>卡片内容来自所选节点；这里的修改只影响这张卡片，不会改变笔记。导出为 1080×1440 PNG 图片。</p>
      <div className="kc-preview-row">
        <div className="kc-preview"><KnowledgeCardArt card={card} scale={300 / 1080} /></div>
        <div className="kc-fields">
          <label>观点<textarea rows={3} value={card.viewpoint} onChange={event => setCard({ ...card, viewpoint: event.target.value })} /></label>
          {viewpointLayout(card.viewpoint).truncated && <p className="kc-truncated">观点超出六行，卡片上已截断并以省略号结尾。</p>}
          {card.parent ? <label>上级<input value={card.parent} onChange={event => setCard({ ...card, parent: event.target.value })} /></label> : null}
          {card.points.map((point, index) => <label key={index}>要点 {index + 1}<input value={point} onChange={event => setCard({ ...card, points: card.points.map((value, at) => at === index ? event.target.value : value) })} /></label>)}
          {card.pointsTotal > card.points.length && <p>其余 {card.pointsTotal - card.points.length} 条要点在卡片上合并为「等 {card.pointsTotal} 条」。</p>}
        </div>
      </div>
      <div className="e1-modal-actions"><button className="e1-primary" disabled={cardBusy} onClick={() => void cardPng('save')}>{cardBusy ? '正在渲染…' : '导出 PNG'}</button><button disabled={cardBusy} onClick={() => void cardPng('copy')}>复制图片</button><button disabled={cardBusy} onClick={() => setCard(null)}>关闭</button></div>
    </Modal>}
    {pastePreview && <Modal title="将外部文字加入导图" onCancel={() => setPastePreview(null)}><p>把 {pastePreview.lines.length} 个非空行依次加入当前分支，每行一个子节点。不会把文字解析成内部节点或覆盖现有树。</p><div className="e1-paste-preview">{pastePreview.lines.map((line, index) => <p key={index}>{line}</p>)}</div><div className="e1-modal-actions"><button onClick={() => { if (command({ type: 'pasteTitles', parentId: pastePreview.parentId, lines: pastePreview.lines })) setPastePreview(null); }}>加入这些子节点</button><button onClick={() => setPastePreview(null)}>取消</button></div></Modal>}
    {moveTo !== null && <Modal title="移动到分支" onCancel={() => setMoveTo(null)}><label>目标父级 <select aria-label="移动目标父级" value={moveTo} onChange={event => setMoveTo(event.target.value)}>{treeOrder(state.map).map(entry => <option key={entry.id} value={entry.id}>{'　'.repeat(entry.depth)}{plainText(state.map.nodes[entry.id].title)}</option>)}</select></label><p>加入目标父级的末尾；自身、后代和根位置由同一命令规则保护。</p><div className="e1-modal-actions"><button onClick={() => { const parent = stateRef.current!.map.nodes[moveTo]; if (command({ type: 'move', nodeId: selectedId(), parentId: parent.id, index: parent.children.filter(id => id !== selectedId()).length })) setMoveTo(null); }}>移动</button><button onClick={() => setMoveTo(null)}>取消</button></div></Modal>}
    {conflictVersion && <Modal title="明确处理版本冲突" onCancel={() => !busy && setConflictVersion(null)}><p>磁盘上已保存整理稿版本 {conflictVersion.bundle.workspace.draftRevision}、导图版本 {conflictVersion.bundle.workspace.mapRevision}。当前窗口的修改仍然保留，不会自动覆盖。</p><details><summary>查看磁盘整理稿的开头</summary><p className="e1-conflict-excerpt">{pointSlice(textBlocks(conflictVersion.bundle.draft.blocks).map(block => plainText(block.runs)).join('\n'), 0, 1200)}</p><p>导图 {Object.keys(conflictVersion.bundle.map.nodes).length} 个节点，根标题：{plainText(conflictVersion.bundle.map.nodes[conflictVersion.bundle.map.rootId].title)}</p></details><p>选择保留当前稿时，将以所示磁盘版本为基线创建新版本；若磁盘再次变化仍会拒绝。历史版本不会删除。</p><div className="e1-modal-actions"><button disabled={busy} onClick={() => void resolveConflict('keep')}>以当前稿创建新版本</button><button disabled={busy} onClick={() => void resolveConflict('disk')}>放弃未保存，载入磁盘版本</button><button disabled={busy} onClick={() => setConflictVersion(null)}>取消</button></div></Modal>}
    {leavePrompt && <Modal title="离开前保存当前稿" onCancel={() => resolveLeave(false)}><p>{compositionCount ? '中文输入尚未结束。请取消离开，正常完成候选后再试；不会以模拟回车替你选词。' : '保存尚未完成。当前内容仍保留在窗口中，你可以重试、取消离开，或明确放弃未保存内容。'}</p>{(session.status === 'failed' || session.status === 'conflict') && <p className="e1-warning">{session.status === 'conflict' ? '已有较新磁盘版本，不能无条件覆盖。可取消离开后查看版本。' : '写入失败，请确认磁盘可用后重试。'}</p>}<div className="e1-modal-actions"><button disabled={busy || !!compositionCount} onClick={async () => { setBusy(true); const ok = await saveCurrentBarrier(); setBusy(false); if (ok) { cacheSession(); resolveLeave(true); } }}>重试保存并离开</button><button onClick={() => resolveLeave(false)}>取消离开</button><button disabled={busy} onClick={() => { discardOnLeave.current = true; workspaceSessions.delete(session.workspaceId); clearAuto(); resolveLeave(true); }}>放弃未保存内容并离开</button></div></Modal>}
  </section>;
}

function NodePanel({ readOnly = false, node, onClose, onComposition, onNotes, onStyle, onBold, onTitleEdit, onPartialBold, onImage, onRemoveImage, onReference, onRelink, onRemoveReference, onCard }: { readOnly?: boolean; node: MindMapNode; onClose(): void; onComposition(value: boolean): void; onNotes(value: string): void; onStyle(value?: MindMapNode['style']): void; onBold(): void; onTitleEdit(): void; onPartialBold(): void; onImage(): void; onRemoveImage(): void; onReference(ref: SourceReference): void; onRelink(): void; onRemoveReference(index: number): void; onCard?(): void }) {
  const [notes, setNotes] = useState(node.notes); const composing = useRef(false); useEffect(() => setNotes(node.notes), [node.id, node.notes]);
  return <aside className="e1-node-panel" aria-label="节点设置"><div><h3>节点设置</h3><button aria-label="关闭节点设置" onMouseDown={event => { if (composing.current) event.preventDefault(); }} onClick={onClose}>×</button></div><p className="e1-node-panel-title"><Runs runs={node.title} /></p>{onCard && <button className="e1-node-card-open" onClick={onCard}>生成知识卡片</button>}<label>备注<textarea readOnly={readOnly} aria-label="节点备注" value={notes} onCompositionStart={() => { composing.current = true; onComposition(true); }} onCompositionEnd={event => { composing.current = false; onComposition(false); onNotes(event.currentTarget.value); }} onChange={event => { setNotes(event.target.value); if (!composing.current) onNotes(event.target.value); }} /></label><fieldset disabled={readOnly} style={{border:0,padding:0,margin:0}}><div className="e1-node-style"><button onClick={onTitleEdit}>编辑标题／换行</button><button onMouseDown={event => event.preventDefault()} onClick={onPartialBold}>标题选区粗体 ⌘B</button><button onClick={onBold}>整节点粗体</button>{['#FFF4B0', '#FFD6BF', '#DCEBD9', '#D9E6F2'].map(color => <button key={color} aria-label={`节点强调色 ${color}`} style={{ background: color }} onClick={() => onStyle({ ...node.style, fill: color, textColor: '#171717' })}>●</button>)}<button onClick={() => onStyle()}>重置样式</button></div><div className="e1-node-image-actions"><button onClick={onImage}>选择已有图片</button><button disabled={!node.image} onClick={onRemoveImage}>移除图片</button></div></fieldset><h4>来源引用</h4>{node.sourceRefs.length ? node.sourceRefs.map((ref, index) => <div className="e1-node-reference" key={index}><button onMouseDown={event => event.preventDefault()} onClick={() => onReference(ref)}>{ref.kind === 'capturedSource' ? '来源原文' : ref.kind === 'userDraft' ? '我的稿件' : ref.kind === 'ocr' ? `图片文字${ref.correctionRevision ? ` · 校对版本 ${ref.correctionRevision}` : ' · 原始识别'}` : `转录／字幕 · 版本 ${ref.revision}`}{ref.range?.excerpt ? `：${pointSlice(ref.range.excerpt, 0, 30)}` : ''}</button><button disabled={readOnly} aria-label={`移除第 ${index + 1} 个引用`} onClick={() => onRemoveReference(index)}>移除</button></div>) : <p>暂无来源。选一段原文、字幕或整理稿，主动加入导图。</p>}<button disabled={readOnly} onClick={onRelink}>明确重新关联选区</button></aside>;
}
function ImagePicker({ api, workspaceId, images, content, mediaUrl, busy, onSelect, onSelectMedia, onCancel }: { api: EditorAPI; workspaceId: string; images: AssetMetadata[]; content: ContentRecord; mediaUrl(id: number): string; busy: boolean; onSelect(ref: AssetRef): void; onSelectMedia(id: number): void; onCancel(): void }) {
  const [decoded, setDecoded] = useState<Set<string>>(new Set()), [broken, setBroken] = useState<Set<string>>(new Set()), [dimensions, setDimensions] = useState<Record<string, string>>({});
  const loaded = (key: string, image: HTMLImageElement) => { if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return; setDecoded(previous => new Set(previous).add(key)); setDimensions(previous => ({ ...previous, [key]: `${image.naturalWidth} × ${image.naturalHeight}` })); };
  const failed = (key: string) => setBroken(previous => new Set(previous).add(key));
  return <Modal title="选择已保存的本地图片" onCancel={() => !busy && onCancel()} className="e1-image-dialog"><p>只有实际解码成功的本地图片可以加入。节点保持图片比例，共享固定版本；移除节点不会删除原图。</p><div className="e1-image-picker">{images.map((asset, index) => { const key = `${asset.id}@${asset.version}`; return <button key={key} disabled={busy || !decoded.has(key) || broken.has(key)} onClick={() => onSelect({ assetId: asset.id, version: asset.version })}><img alt={`已固定图片 ${index + 1}`} src={api.assetUrl(workspaceId, { assetId: asset.id, version: asset.version })} onLoad={event => loaded(key, event.currentTarget)} onError={() => failed(key)} /><span>图片 {index + 1} · {asset.mime}<small>{broken.has(key) ? '本地图片缺失或损坏' : dimensions[key] || '正在解码…'}</small></span></button>; })}{currentMedia(content).filter(item => item.kind === 'image' && item.state === 'succeeded').map((media, index) => { const key = `media-${media.id}`; return <button key={key} disabled={busy || !decoded.has(key) || broken.has(key)} onClick={() => onSelectMedia(media.id)}><img alt={`当前来源图片 ${index + 1}`} src={mediaUrl(media.id)} onLoad={event => loaded(key, event.currentTarget)} onError={() => failed(key)} /><span>当前来源图片 {index + 1}<small>{broken.has(key) ? '本地图片缺失或损坏' : dimensions[key] || '正在解码…'}</small></span></button>; })}</div>{!images.length && !currentMedia(content).some(item => item.kind === 'image' && item.state === 'succeeded') && <p>没有已保存的本地图片。可以继续纯文字整理。</p>}<button disabled={busy} onClick={onCancel}>取消</button></Modal>;
}
