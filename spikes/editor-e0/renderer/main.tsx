import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EditorView } from 'prosemirror-view';
import { undo as pmUndo, redo as pmRedo } from 'prosemirror-history';
import { clone, markdown, plainText, transcriptTimeDescription, type DraftDocument, type MindMapNode, type SourceReference, type WorkspaceBundle, type SaveRequest, type SaveResult, type ResolvedReference } from '../model.js';
import { createEditorState, execute, canExecute, type EditorState, type EditorCommand } from '../commands.js';
import { mountEditor, fromPM, setSelection, selectedBlockRange, toggleInlineMark, type Block } from './prosemirror.js';
import { SaveCoordinator } from './save-coordinator.js';
import { DRAG_THRESHOLD, MIN_ZOOM, MAX_ZOOM, centerBounds, dropAt, fitBounds, layoutTree, resizedViewport, screenToWorld, wheelZoomAt, zoomAt, type DropPreview, type Point, type Size, type TreeLayout, type Viewport } from './canvas.js';
import './styles.css';

declare global { interface Window {
  e0: { list(): Promise<{ id: string; userTitle: string }[]>; load(id: string): Promise<WorkspaceBundle>; save(request: SaveRequest): Promise<SaveResult>; saveAtomic(requests: SaveRequest[]): Promise<SaveResult[]>; resolveReference(ref: SourceReference): Promise<ResolvedReference>; poll(): Promise<unknown>; setFault(fault: { failNext?: boolean; saveDelayMs?: number; loadDelayMs?: number }): Promise<unknown>; exportXmind(workspaceId: string): Promise<unknown>; assetUrl(id: string, version: string): string; requestClose(action?: 'saved'|'discard'|'cancel'): Promise<unknown>; onCloseRequest?(callback: () => void): () => void };
  e0Probe?: Record<string, (...args: any[]) => any>;
} }
const uid = () => `node-${crypto.randomUUID()}`;
interface CanvasGesture { pointerId: number; workspaceId: string; kind: 'pan' | 'node'; nodeId?: string; start: Point; last: Point; startViewport: Viewport; active: boolean }
function Runs({ runs }: { runs: MindMapNode['title'] }) { return <>{runs.map((run, index) => <span key={index} style={{ fontWeight: run.bold === undefined ? undefined : run.bold ? 700 : 400, fontStyle: run.italic === undefined ? undefined : run.italic ? 'italic' : 'normal', fontFamily: run.code === undefined ? undefined : run.code ? 'monospace' : 'inherit' }}>{run.text}</span>)}</>; }
function RichEditor({ blocks, title, inheritedBold, inheritedItalic, onChange, onCommit, onCancel, onBlur, onComposition, ready }: { blocks: Block[]; title?: boolean; inheritedBold?: boolean; inheritedItalic?: boolean; onChange(blocks: Block[], view: EditorView): void; onCommit?(): void; onCancel?(): void; onBlur?(): void; onComposition?(value: boolean): void; ready?(view: EditorView | null): void }) {
  const host = useRef<HTMLDivElement>(null); const handlers = useRef({ onChange, onCommit, onCancel, onBlur, onComposition });
  handlers.current = { onChange, onCommit, onCancel, onBlur, onComposition };
  useEffect(() => { const view = mountEditor(host.current!, blocks, { title, inheritedBold, inheritedItalic, onChange: (next, view) => handlers.current.onChange(next, view), onCommit: () => handlers.current.onCommit?.(), onCancel: () => handlers.current.onCancel?.(), onBlur: () => handlers.current.onBlur?.(), onComposition: value => handlers.current.onComposition?.(value) }); ready?.(view); if (title) view.focus(); return () => { ready?.(null); view.destroy(); }; }, []);
  return <div className={title ? 'title-editor' : 'body-editor'} ref={host} />;
}
function App() {
  const [, redraw] = useState(0); const update = useCallback(() => redraw(value => value + 1), []);
  const coordinator = useRef(new SaveCoordinator(window.e0, update)).current;
  const [workspaces, setWorkspaces] = useState<{ id: string; userTitle: string }[]>([]);
  const [state, setState] = useState<EditorState | null>(null); const stateRef = useRef<EditorState | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [bodyEpoch, setBodyEpoch] = useState(0);
  const [titleId, setTitleId] = useState<string | null>(null); const titleSessionId = useRef<string | null>(null); const titleDraft = useRef<Block[]>([]); const titleView = useRef<EditorView | null>(null);
  const bodyView = useRef<EditorView | null>(null); const bodyDraft = useRef<DraftDocument | null>(null); const bodyBase = useRef<DraftDocument | null>(null);
  const [reference, setReference] = useState<ResolvedReference | null>(null); const [pollCount, setPollCount] = useState(0); const [closePrompt, setClosePrompt] = useState(false); const [exportResult, setExportResult] = useState('');
  const tree = useRef<HTMLDivElement>(null); const switchEpoch = useRef(0); const focusEpoch = useRef(0);
  const closeDialog = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null); const measurements = useRef(new Map<string, Size>()); const [measureEpoch, setMeasureEpoch] = useState(0);
  const editorSessions = useRef(new Map<string, EditorState>());
  const viewportSessions = useRef(new Map<string, { viewport: Viewport; initialized: boolean; manual: boolean }>());
  const containerSize = useRef<Size>({ width: 1, height: 1 }); const [canvasSize, setCanvasSize] = useState<Size>({ width: 1, height: 1 });
  const layoutRef = useRef<TreeLayout | null>(null); const gesture = useRef<CanvasGesture | null>(null); const [drop, setDrop] = useState<DropPreview | null>(null); const dropRef = useRef<DropPreview | null>(null);
  const viewportPending = useRef<{ workspaceId: string; viewport: Viewport } | null>(null); const viewportFrame = useRef<number | null>(null);
  const gestureFrame = useRef<number | null>(null); const canvasMetrics = useRef({ viewportUpdates: 0, moveCommits: 0, rawPointerMoves: 0, rawWheelEvents: 0, layoutMs: 0, layoutCount: 0 });
  const currentLayout = useMemo(() => { if (!state) return null; const began = performance.now(); const result = layoutTree(state.map, measurements.current); canvasMetrics.current.layoutMs = performance.now() - began; canvasMetrics.current.layoutCount++; return result; }, [state?.map, measureEpoch]);
  layoutRef.current = currentLayout;
  function assign(next: EditorState) { editorSessions.current.set(next.draft.workspaceId, next); stateRef.current = next; setState(next); }
  function activeViewport(): Viewport { const current = stateRef.current!; return viewportPending.current?.workspaceId === current.draft.workspaceId ? viewportPending.current.viewport : current.view.viewport; }
  function flushViewport() {
    if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current); viewportFrame.current = null;
    const pending = viewportPending.current; viewportPending.current = null; const current = stateRef.current;
    if (!pending || !current || pending.workspaceId !== current.draft.workspaceId) return;
    // View updates intentionally keep map, draft, history and coordinator identity unchanged.
    assign({ ...current, view: { ...current.view, viewport: pending.viewport } }); canvasMetrics.current.viewportUpdates++;
  }
  function setViewport(viewport: Viewport, manual = true) {
    const current = stateRef.current; if (!current || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom < MIN_ZOOM || viewport.zoom > MAX_ZOOM) return;
    const previous = viewportSessions.current.get(current.draft.workspaceId);
    viewportSessions.current.set(current.draft.workspaceId, { viewport, initialized: true, manual: manual || previous?.manual || false });
    viewportPending.current = { workspaceId: current.draft.workspaceId, viewport };
    if (viewportFrame.current === null) viewportFrame.current = requestAnimationFrame(flushViewport);
  }
  function canvasPoint(client: Point): Point { const rect = tree.current!.getBoundingClientRect(); return { x: client.x - rect.left, y: client.y - rect.top }; }
  function resetDrop(next: DropPreview | null) { if (JSON.stringify(next) !== JSON.stringify(dropRef.current)) { dropRef.current = next; setDrop(next); } }
  function cancelGesture() {
    const old = gesture.current; gesture.current = null;
    if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current); gestureFrame.current = null;
    if (old && tree.current?.hasPointerCapture(old.pointerId)) tree.current.releasePointerCapture(old.pointerId);
    resetDrop(null); update();
  }
  function fitAll() { if (layoutRef.current) setViewport(fitBounds(layoutRef.current.bounds, containerSize.current)); }
  function centerSelected() { const current = stateRef.current; if (!current || !layoutRef.current) return; const id = current.view.selection?.kind === 'node' ? current.view.selection.nodeId : current.map.rootId; const rect = layoutRef.current.nodes[id]; if (rect) setViewport(centerBounds(activeViewport(), rect, containerSize.current)); }
  function zoomBy(factor: number) { setViewport(zoomAt(activeViewport(), activeViewport().zoom * factor, { x: containerSize.current.width / 2, y: containerSize.current.height / 2 })); }
  function previewDrag() {
    gestureFrame.current = null; const current = stateRef.current, active = gesture.current; if (!active?.active || active.kind !== 'node' || !current || !layoutRef.current) return;
    const local = canvasPoint(active.last), viewport = activeViewport(), size = containerSize.current;
    // Screen-space edge panning keeps distant targets reachable without changing the tree.
    const edge = 35, dx = local.x < edge ? 10 : local.x > size.width - edge ? -10 : 0, dy = local.y < edge ? 10 : local.y > size.height - edge ? -10 : 0;
    if (dx || dy) setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
    resetDrop(dropAt(current.map, layoutRef.current, active.nodeId!, screenToWorld(local, activeViewport())));
    if (dx || dy) gestureFrame.current = requestAnimationFrame(previewDrag);
  }
  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gesture.current || loading || closePrompt) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, .ProseMirror, [contenteditable="true"]')) return;
    const node = target.closest<HTMLElement>('[data-node-id]');
    if (node && (titleSessionId.current || stateRef.current?.view.inputSession?.composing)) return;
    event.preventDefault(); // Preserve active body/title editor and its selection while changing the view.
    const current = stateRef.current!;
    gesture.current = { pointerId: event.pointerId, workspaceId: current.draft.workspaceId, kind: node ? 'node' : 'pan', nodeId: node?.dataset.nodeId, start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY }, startViewport: { ...activeViewport() }, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return;
    canvasMetrics.current.rawPointerMoves++; active.last = { x: event.clientX, y: event.clientY };
    if (!active.active && Math.hypot(active.last.x - active.start.x, active.last.y - active.start.y) < DRAG_THRESHOLD) return;
    if (!active.active) { active.active = true; update(); }
    event.preventDefault();
    if (active.kind === 'pan') setViewport({ ...active.startViewport, x: active.startViewport.x + active.last.x - active.start.x, y: active.startViewport.y + active.last.y - active.start.y });
    else if (gestureFrame.current === null) gestureFrame.current = requestAnimationFrame(previewDrag);
  }
  function finishGesture(pointerId: number, clientX: number, clientY: number) {
    const active = gesture.current; if (!active || active.pointerId !== pointerId) return;
    const current = stateRef.current, sameWorkspace = current?.draft.workspaceId === active.workspaceId;
    const local = tree.current ? canvasPoint({ x: clientX, y: clientY }) : null;
    const insideCanvas = local && local.x >= 0 && local.y >= 0 && local.x <= containerSize.current.width && local.y <= containerSize.current.height;
    let candidate: DropPreview | null = null;
    if (sameWorkspace && insideCanvas && active.active && active.kind === 'node' && layoutRef.current) candidate = dropAt(current.map, layoutRef.current, active.nodeId!, screenToWorld(local, activeViewport()));
    cancelGesture();
    if (!sameWorkspace || !current) return;
    if (active.active && active.kind === 'node' && candidate?.allowed) {
      const cmd: EditorCommand = { type: 'move', nodeId: active.nodeId!, parentId: candidate.parentId, index: candidate.index };
      const permission = canExecute(current, cmd);
      if (permission.allowed && command(cmd, false)) canvasMetrics.current.moveCommits++; else if (!permission.allowed) setError(permission.reason || '此落点不可用');
    } else if (!active.active && active.kind === 'node') command({ type: 'select', selection: { kind: 'node', nodeId: active.nodeId! } });
  }
  function pointerUp(event: React.PointerEvent<HTMLDivElement>) { finishGesture(event.pointerId, event.clientX, event.clientY); }
  function focusCanvasLater() { const epoch = ++focusEpoch.current; requestAnimationFrame(() => { if (epoch === focusEpoch.current && !titleSessionId.current) tree.current?.focus(); }); }
  function inputSession(targetId: string, composing = false) { const current = stateRef.current; if (!current) return; const previous = current.view.inputSession; assign({ ...current, view: { ...current.view, inputSession: { id: previous?.targetId === targetId ? previous.id : `input-${crypto.randomUUID()}`, targetId, composing } } }); }
  function sync(next: EditorState) {
    const previous = stateRef.current;
    if (previous && JSON.stringify(previous.draft.blocks) !== JSON.stringify(next.draft.blocks)) {
      bodyDraft.current = clone(next.draft); bodyBase.current = clone(next.draft); setBodyEpoch(value => value + 1);
    }
    assign(next); coordinator.replace(bodyDraft.current || next.draft, next.map);
  }
  function command(cmd: EditorCommand, focus = true) {
    if (!['select', 'viewport'].includes(cmd.type)) flushBody();
    const previous = stateRef.current; if (!previous) return false;
    if (coordinator.active?.workspaceId === previous.draft.workspaceId) { previous.draft.revision = coordinator.active.bundle.workspace.draftRevision; previous.map.revision = coordinator.active.bundle.workspace.mapRevision; }
    const result = execute(previous, cmd); if (result.error) { setError(result.error); return false; }
    if (result.changed) sync(result.state); else assign(result.state);
    if (focus) focusCanvasLater(); return true;
  }
  function flushBody() {
    const current = stateRef.current; const draft = bodyDraft.current; if (!current || !draft || !bodyBase.current) return;
    current.draft.revision = coordinator.active!.bundle.workspace.draftRevision; current.map.revision = coordinator.active!.bundle.workspace.mapRevision;
    if (JSON.stringify(draft.blocks) !== JSON.stringify(bodyBase.current.blocks)) {
      const next = execute(current, { type: 'setDraft', document: { ...draft, revision: coordinator.active!.bundle.workspace.draftRevision } });
      if (next.error) setError(next.error); else { assign(next.state); bodyBase.current = clone(draft); }
    }
    if (stateRef.current?.view.inputSession?.targetId === draft.documentId) assign({ ...stateRef.current, view: { ...stateRef.current.view, inputSession: null } });
  }
  function commitTitle(cancel = false) {
    if (!titleSessionId.current) return;
    const id = titleSessionId.current; titleSessionId.current = null; const runs = titleDraft.current.flatMap((block, index) => [...(index ? [{ text: '\n' }] : []), ...block.runs]);
    if (stateRef.current) assign({ ...stateRef.current, view: { ...stateRef.current.view, inputSession: null } });
    setTitleId(null); if (!cancel) command({ type: 'rename', nodeId: id, title: runs });
    focusCanvasLater();
  }
  async function save() {
    if (titleId) commitTitle(); flushBody();
    const ok = await coordinator.save();
    // Only update revision metadata: never replace the editor tree after an async reply.
    const active = coordinator.active; const current = stateRef.current;
    if (active && current && active.workspaceId === current.draft.workspaceId) {
      current.draft.revision = active.bundle.workspace.draftRevision; current.map.revision = active.bundle.workspace.mapRevision;
      if (bodyDraft.current) bodyDraft.current.revision = current.draft.revision;
      assign({ ...current });
    }
    return ok;
  }
  async function switchWorkspace(id: string) {
    cancelGesture(); flushViewport(); if (titleId) commitTitle(); flushBody(); const epoch = ++switchEpoch.current;
    ++focusEpoch.current; // A queued focus from the old title cannot reclaim the new workspace.
    setLoading(true); setError(''); setReference(null); setTitleId(null);
    try { const session = await coordinator.activate(id); if (epoch !== switchEpoch.current || !session) return;
      bodyDraft.current = clone(session.bundle.draft); bodyBase.current = clone(session.bundle.draft);
      const cached = editorSessions.current.get(id), viewSession = viewportSessions.current.get(id);
      const next = cached ? { ...cached, draft: { ...cached.draft, revision: session.bundle.workspace.draftRevision }, map: { ...cached.map, revision: session.bundle.workspace.mapRevision }, view: { ...cached.view, inputSession: null } } : createEditorState(session.bundle);
      if (viewSession) next.view.viewport = { ...viewSession.viewport };
      else viewportSessions.current.set(id, { viewport: next.view.viewport, initialized: false, manual: false });
      assign(next);
    } catch (err) { if (epoch === switchEpoch.current) setError(String(err)); }
    finally { if (epoch === switchEpoch.current) setLoading(false); }
  }
  useEffect(() => { window.e0.list().then(list => { setWorkspaces(list); if (list[0]) void switchWorkspace(list[0].id); }).catch(err => setError(String(err))); }, []);
  useEffect(() => { const timer = setInterval(() => { window.e0.poll().then(() => setPollCount(value => value + 1)).catch(err => setError(String(err))); }, 1500); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const cancel = () => cancelGesture();
    // Capture normally retargets release to the canvas. Window fallback also handles
    // Chromium releases delivered to a sibling after leaving a transformed canvas.
    // React's normal handler clears the gesture first, so there is one commit at most.
    const release = (event: PointerEvent) => finishGesture(event.pointerId, event.clientX, event.clientY);
    const cancelled = (event: PointerEvent) => { if (gesture.current?.pointerId === event.pointerId) cancelGesture(); };
    const visibility = () => { if (document.visibilityState === 'hidden') cancelGesture(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancelGesture(); }
      // Never allow a native page zoom to scale the body/editor/toolbars together.
      if ((event.metaKey || event.ctrlKey) && ['+', '=', '-', '0'].includes(event.key)) {
        event.preventDefault();
        if ((event.target as HTMLElement).closest('[data-testid="canvas"], .viewport-controls')) {
          if (event.key === '0') { const viewport = activeViewport(); setViewport(zoomAt(viewport, 1, { x: containerSize.current.width / 2, y: containerSize.current.height / 2 })); }
          else zoomBy(event.key === '-' ? 1 / 1.2 : 1.2);
        }
      }
    };
    window.addEventListener('blur', cancel); window.addEventListener('keydown', key, true); window.addEventListener('pointerup', release); window.addEventListener('pointercancel', cancelled); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key, true); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', cancelled); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { if (closePrompt) cancelGesture(); }, [closePrompt]);
  const nodeSignature = state ? `${state.map.workspaceId}:${Object.keys(state.map.nodes).join(',')}` : '';
  function measureNodes() {
    if (!world.current) return;
    let changed = false;
    for (const element of world.current.querySelectorAll<HTMLElement>('[data-node-id]')) {
      const id = element.dataset.nodeId!, next = { width: element.offsetWidth, height: element.offsetHeight }, old = measurements.current.get(id);
      if (!old || old.width !== next.width || old.height !== next.height) { measurements.current.set(id, next); changed = true; }
    }
    if (changed) setMeasureEpoch(value => value + 1);
  }
  useLayoutEffect(() => { measureNodes(); }, [nodeSignature, titleId]);
  useEffect(() => {
    if (!world.current || !tree.current || !stateRef.current) return;
    const root = tree.current, observer = new ResizeObserver(entries => {
      if (entries.some(entry => entry.target === root)) {
        const next = { width: root.clientWidth, height: root.clientHeight }, old = containerSize.current;
        containerSize.current = next; setCanvasSize(next);
        const current = stateRef.current, saved = current && viewportSessions.current.get(current.draft.workspaceId);
        if (current && saved?.initialized && old.width > 1 && old.height > 1) setViewport(resizedViewport(activeViewport(), old, next), false);
      }
      measureNodes();
    });
    observer.observe(root); for (const element of world.current.querySelectorAll('[data-node-id]')) observer.observe(element);
    return () => observer.disconnect();
  }, [nodeSignature]);
  useEffect(() => {
    if (!tree.current) return;
    const root = tree.current;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.ProseMirror, button, input, textarea, select, a')) return;
      event.preventDefault(); canvasMetrics.current.rawWheelEvents++;
      if (![event.deltaX, event.deltaY, event.clientX, event.clientY].every(Number.isFinite)) return;
      const viewport = activeViewport(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) setViewport(wheelZoomAt(viewport, Math.max(-4000, Math.min(4000, event.deltaY * unit)), canvasPoint({ x: event.clientX, y: event.clientY })));
      else setViewport({ ...viewport, x: viewport.x - event.deltaX * unit, y: viewport.y - event.deltaY * unit });
    };
    root.addEventListener('wheel', wheel, { passive: false }); return () => root.removeEventListener('wheel', wheel);
  }, [!!state]);
  useEffect(() => {
    const current = stateRef.current, host = world.current; if (!current || !host) return;
    const workspaceId = current.draft.workspaceId, cached = viewportSessions.current.get(workspaceId);
    if (cached?.initialized) return;
    let cancelled = false, frame = 0;
    const images = [...host.querySelectorAll('img')];
    const imagesReady = Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true }); })));
    void Promise.all([document.fonts.ready, imagesReady]).then(() => {
      if (cancelled) return; measureNodes();
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
        if (cancelled || stateRef.current?.draft.workspaceId !== workspaceId || viewportSessions.current.get(workspaceId)?.initialized || !layoutRef.current || containerSize.current.width <= 1) return;
        setViewport(fitBounds(layoutRef.current.bounds, containerSize.current), false);
      }); });
    });
    return () => { cancelled = true; if (frame) cancelAnimationFrame(frame); };
  }, [nodeSignature, canvasSize.width, canvasSize.height]);
  useEffect(() => window.e0.onCloseRequest?.(() => setClosePrompt(true)), []);
  useEffect(() => {
    if (!closePrompt || !closeDialog.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = closeDialog.current; const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]; buttons[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close('cancel'); }
      if (event.key !== 'Tab') return;
      const first = buttons[0], last = buttons.at(-1); if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      event.stopPropagation();
    };
    document.addEventListener('keydown', handle, true);
    return () => { document.removeEventListener('keydown', handle, true); if (previous?.isConnected) previous.focus(); };
  }, [closePrompt]);
  async function close(action: 'saved'|'discard'|'cancel') {
    if (action === 'cancel') { setClosePrompt(false); await window.e0.requestClose('cancel'); return; }
    if (action === 'saved') { if (titleId) commitTitle(); flushBody(); if (!await coordinator.saveAll()) { setError('保存未完成，草稿仍保留。请重试或取消关闭。'); return; } }
    await window.e0.requestClose(action);
  }
  function startTitle(id: string) {
    const node = stateRef.current?.map.nodes[id]; if (!node) return;
    ++focusEpoch.current;
    titleDraft.current = [{ id: `title-${id}`, type: 'paragraph', runs: clone(node.title) }]; titleSessionId.current = id; inputSession(id); setTitleId(id);
  }
  async function addFromSelection() {
    const range = bodyView.current && selectedBlockRange(bodyView.current); if (!range) { setError('请在正文同一块内选择非空文字，再加入导图。'); return; }
    const sessionId = coordinator.active!.id;
    const block = bodyDraft.current!.blocks.find(block => block.id === range.blockId)!;
    const text = plainText(block.runs);
    if (!await save() || coordinator.isDirty() || coordinator.active?.id !== sessionId) { setError('先确认当前正文保存，才能冻结引用版本。'); return; }
    const current = stateRef.current!;
    command({ type: 'fromDraftSelection', parentId: current.view.selection?.kind === 'node' ? current.view.selection.nodeId : current.map.rootId, blockId: range.blockId, start: range.start, end: range.end, revision: current.draft.revision });
  }
  function canvasKey(event: React.KeyboardEvent) {
    if (event.target !== tree.current || event.nativeEvent.isComposing || event.keyCode === 229 || titleId) return;
    const current = stateRef.current; const selection = current?.view.selection; if (!current || selection?.kind !== 'node') return;
    let cmd: EditorCommand | null = null;
    if (event.key === 'Tab') cmd = { type: 'addChild', nodeId: selection.nodeId };
    else if (event.key === 'Enter') cmd = { type: selection.nodeId === current.map.rootId ? 'addChild' : 'addSibling', nodeId: selection.nodeId };
    else if (event.key === ' ') { event.preventDefault(); startTitle(selection.nodeId); return; }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') cmd = { type: 'toggleNodeBold', nodeId: selection.nodeId };
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') cmd = { type: event.shiftKey ? 'redo' : 'undo' };
    else if (event.key === 'Backspace' || event.key === 'Delete') cmd = { type: 'deleteSubtree', nodeId: selection.nodeId };
    if (cmd) { event.preventDefault(); event.stopPropagation(); const opensTitle = ['addChild', 'addSibling'].includes(cmd.type); if (command(cmd, !opensTitle) && opensTitle) { const sel = stateRef.current?.view.selection; if (sel?.kind === 'node') startTitle(sel.nodeId); } }
  }
  useEffect(() => {
    window.e0Probe = {
      snapshot: () => ({ workspaceId: coordinator.active?.workspaceId, state: clone(stateRef.current), session: coordinator.active ? { edit: coordinator.active.edit, savedEdit: coordinator.active.savedEdit, status: coordinator.active.status, error: coordinator.active.error, bundle: clone(coordinator.active.bundle) } : null, pollCount, titleId, titleUncommitted: titleId !== null, displaySaveStatus: titleId ? '标题编辑中 · 尚未提交' : coordinator.active?.status, editorText: bodyView.current?.state.doc.textContent, editorSelection: bodyView.current ? { from: bodyView.current.state.selection.from, to: bodyView.current.state.selection.to } : null }),
      canvasSnapshot: () => ({ viewport: stateRef.current?.view.viewport, pendingViewport: viewportPending.current?.viewport ?? null, measured: Object.fromEntries(measurements.current), layout: clone(layoutRef.current), container: tree.current ? { x: tree.current.getBoundingClientRect().x, y: tree.current.getBoundingClientRect().y, width: tree.current.clientWidth, height: tree.current.clientHeight } : null, gesture: clone(gesture.current), drop: clone(dropRef.current), metrics: { ...canvasMetrics.current }, zoomBounds: { min: MIN_ZOOM, max: MAX_ZOOM }, threshold: DRAG_THRESHOLD }),
      command: (cmd: EditorCommand) => command(cmd), startTitle, commitTitle, save, switchWorkspace, close,
      bodySelect: (id: string, start: number, end?: number) => setSelection(bodyView.current!, id, start, end),
      titleSelect: (start: number, end?: number) => { const view = titleView.current!; setSelection(view, fromPM(view.state.doc)[0].id, start, end); },
      insertBody: (text: string) => { const view = bodyView.current!; view.dispatch(view.state.tr.insertText(text)); },
      insertTitle: (text: string) => { const view = titleView.current!; view.dispatch(view.state.tr.insertText(text)); },
      boldBody: () => toggleInlineMark('strong')(bodyView.current!.state, bodyView.current!.dispatch),
      boldTitle: () => toggleInlineMark('strong', !!stateRef.current?.map.nodes[titleSessionId.current!]?.style?.bold)(titleView.current!.state, titleView.current!.dispatch),
      bodyUndo: () => pmUndo(bodyView.current!.state, bodyView.current!.dispatch), bodyRedo: () => pmRedo(bodyView.current!.state, bodyView.current!.dispatch),
      bodyBlocks: () => fromPM(bodyView.current!.state.doc), titleBlocks: () => titleView.current ? fromPM(titleView.current.state.doc) : null,
      addFromSelection, flushBody,
      composition: (target: 'body'|'title', phase: 'start'|'end') => { const element = (target === 'body' ? bodyView : titleView).current!.dom; element.dispatchEvent(new CompositionEvent(`composition${phase}`, { bubbles: true, data: '中文' })); },
      syntheticKey: (target: 'body'|'title', key: string, options: Record<string, unknown> = {}) => (target === 'body' ? bodyView : titleView).current!.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })),
      candidateToken: () => coordinator.candidateToken(), applyCandidate: (token: ReturnType<SaveCoordinator['candidateToken']>) => coordinator.applyCandidate(token, () => command({ type: 'addChild', nodeId: stateRef.current!.map.rootId, title: [{ text: '合成迟到候选' }] })),
      resolve: (ref: SourceReference) => window.e0.resolveReference(ref),
      markdown: () => markdown(bodyDraft.current!, coordinator.active!.bundle),
    };
    return () => { delete window.e0Probe; };
  });
  if (!state) return <main className="startup"><h1>编辑底座 E0</h1><p>{error || '正在加载隔离合成资料…'}</p></main>;
  const session = coordinator.active!; const selected = state.view.selection?.kind === 'node' ? state.view.selection.nodeId : state.map.rootId;
  const layout = currentLayout!, viewport = state.view.viewport;
  const width = layout.bounds.x + layout.bounds.width + 24, height = layout.bounds.y + layout.bounds.height + 24;
  const activeGesture = gesture.current;
  return <main onFocusCapture={event => { if ((event.target as HTMLElement).closest('.ProseMirror')) ++focusEpoch.current; }}>
    <header><div><span className="eyebrow">READ LATER / ISOLATED SPIKE</span><h1>整理底座 · E0</h1></div><label>合成工作区 <select aria-label="合成工作区" value={session.workspaceId} onChange={event => void switchWorkspace(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.userTitle}</option>)}</select></label><span data-testid="save-status" className={`status ${titleId ? 'dirty' : session.status}`}>{titleId ? '标题编辑中 · 尚未提交' : ({ saved: '已确认保存', dirty: '待保存', saving: '正在保存', failed: '保存失败 · 草稿保留', conflict: '版本冲突 · 草稿保留' })[session.status]}</span><button data-testid="save" onClick={() => void save()}>保存到隔离 SQLite</button></header>
    <div className="isolation">仅合成资料 · HTTP(S) 已由隔离主进程阻断 · 不访问正式收藏、平台或登录态 <span>状态轮询 {pollCount} 次 / 1.5 秒</span></div>
    {(error || session.error) && <div className="error" role="alert">{error || session.error}<button onClick={() => setError('')}>收起</button></div>}
    <div className="toolbar"><button onClick={() => command({ type: 'addChild', nodeId: selected })}>加子级 Tab</button><button onClick={() => command({ type: 'addSibling', nodeId: selected })}>加同级 Enter</button><button onClick={() => startTitle(selected)}>编辑标题 Space</button><button onClick={() => command({ type: 'toggleNodeBold', nodeId: selected })}>整节点粗体</button><button disabled={!state.history.past.length} onClick={() => command({ type: 'undo' })}>撤销</button><button disabled={!state.history.future.length} onClick={() => command({ type: 'redo' })}>重做</button><button onClick={async () => { await window.e0.setFault({ failNext: true }); setError('已安排下一次写入失败；内容不会清空。'); }}>制造一次写入失败</button><button onClick={async () => { if (await save()) setExportResult(JSON.stringify(await window.e0.exportXmind(session.workspaceId))); }}>导出同一模型 XMind</button></div>
    {exportResult && <p className="export-result">{exportResult}</p>}
    <section className={`workspace ${loading ? 'loading' : ''}`} aria-busy={loading}>
      <section className="map-pane"><div className="section-label">逻辑树 / HTML 文字 + SVG 连线 <small>空白拖动或双指滚动平移；⌘/Ctrl + 滚轮缩放；节点拖到上／下缘排序、中间换父；Space 编辑标题</small></div>
      <div className="viewport-controls" role="group" aria-label="画布视野" onMouseDown={event => event.preventDefault()}>
        <button data-testid="zoom-out" aria-label="缩小画布" disabled={viewport.zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.2)}>−</button>
        <output data-testid="zoom-percentage" aria-live="polite" aria-label="画布缩放比例">{Number((viewport.zoom * 100).toFixed(1))}%</output>
        <button data-testid="zoom-in" aria-label="放大画布" disabled={viewport.zoom >= MAX_ZOOM} onClick={() => zoomBy(1.2)}>+</button>
        <button data-testid="zoom-reset" aria-label="画布恢复 100%" onClick={() => setViewport(zoomAt(activeViewport(), 1, { x: containerSize.current.width / 2, y: containerSize.current.height / 2 }))}>100%</button>
        <button data-testid="fit-all" onClick={fitAll}>适合全部</button><button data-testid="center-selected" onClick={centerSelected}>定位选中</button>
        <span data-testid="zoom-boundary" role="status">{viewport.zoom <= MIN_ZOOM ? '已达最小 1%' : viewport.zoom >= MAX_ZOOM ? '已达最大 250%' : '1%–250%'}</span>
      </div>
      <div ref={tree} data-testid="canvas" data-gesture={activeGesture?.active ? activeGesture.kind : 'idle'} data-viewport-x={viewport.x} data-viewport-y={viewport.y} data-viewport-zoom={viewport.zoom} className={`tree-scroll tree ${activeGesture?.active ? `gesture-${activeGesture.kind}` : ''}`} role="tree" aria-label="合成思维导图" tabIndex={0} onKeyDown={canvasKey} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}>
      <div ref={world} data-testid="viewport-world" className="viewport-world" style={{ width, height, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        <svg data-testid="tree-edges" width={width} height={height} aria-hidden="true">{Object.values(state.map.nodes).flatMap(node => node.children.map(child => { const a = layout.nodes[node.id], b = layout.nodes[child]; return <path data-edge-child={child} key={child} d={`M ${a.x + a.width} ${a.y + a.height / 2} C ${a.x + a.width + 27} ${a.y + a.height / 2}, ${b.x - 27} ${b.y + b.height / 2}, ${b.x} ${b.y + b.height / 2}`} />; }))}</svg>
        {Object.values(state.map.nodes).map(node => { const position = layout.nodes[node.id]; const dropTarget = drop?.targetId === node.id ? drop : null; return <div data-node-id={node.id} data-drop-kind={dropTarget?.kind} data-drop-allowed={dropTarget ? String(dropTarget.allowed) : undefined} key={node.id} className={`node ${node.id === selected ? 'selected' : ''} ${node.id === state.map.rootId ? 'root' : ''} ${activeGesture?.active && activeGesture.nodeId === node.id ? 'drag-source' : ''} ${dropTarget ? `drop-${dropTarget.kind} ${dropTarget.allowed ? 'drop-valid' : 'drop-invalid'}` : ''}`} role="treeitem" aria-selected={node.id === selected} style={{ left: position.x, top: position.y, fontWeight: node.style?.bold === undefined ? undefined : node.style.bold ? 700 : 400, fontStyle: node.style?.italic === undefined ? undefined : node.style.italic ? 'italic' : 'normal', background: node.style?.fill, color: node.style?.textColor }} onDoubleClick={() => { if (!gesture.current?.active) startTitle(node.id); }}>
          {titleId === node.id ? <RichEditor key={titleId} title inheritedBold={node.style?.bold} inheritedItalic={node.style?.italic} blocks={titleDraft.current} onChange={blocks => { titleDraft.current = blocks; update(); }} onComposition={value => inputSession(node.id, value)} onCommit={() => commitTitle()} onCancel={() => commitTitle(true)} onBlur={() => commitTitle()} ready={view => { titleView.current = view; }} /> : <div className="node-title"><Runs runs={node.title} /></div>}
          {node.image && <img alt="本地自建几何图片" src={window.e0.assetUrl(node.image.assetId, node.image.version)} />}
          {node.sourceRefs.length > 0 && <button className="ref-button" onClick={async event => { event.stopPropagation(); try { setReference(await window.e0.resolveReference(node.sourceRefs[0])); } catch (err) { setError(String(err)); } }}>来源 {node.sourceRefs.length}</button>}
        </div>; })}
      </div></div><div className="drop-status" data-testid="drop-status" role="status">{activeGesture?.active && activeGesture.kind === 'node' ? drop ? `${drop.allowed ? '有效落点' : '不可放置'}：${({ before: '插在前面', after: '插在后面', child: '作为子级' })[drop.kind]} · ${plainText(state.map.nodes[drop.targetId]?.title || [])}${drop.reason ? ` · ${drop.reason}` : ''}` : '未指向节点：松手将取消；可在画布边缘自动平移寻找目标' : '拖动阈值 6px · 空白单击不移动 · Escape 取消拖拽'}</div><div className="node-notes"><b>选中节点</b> {selected} <span>{state.map.nodes[selected]?.notes || '无备注'}</span></div></section>
      <aside className="document-pane"><div className="section-label">我的整理稿 <small>结构化文档是唯一主数据；来源只读</small></div><div className="body-toolbar"><button onMouseDown={event => event.preventDefault()} onClick={() => bodyView.current && toggleInlineMark('strong')(bodyView.current.state, bodyView.current.dispatch)}>选区粗体 ⌘B</button><button data-testid="from-selection" onMouseDown={event => event.preventDefault()} onClick={() => void addFromSelection()}>选区加入导图</button><button onClick={() => setError(markdown(bodyDraft.current!, coordinator.active!.bundle))}>查看 Markdown 序列化</button></div>
        <RichEditor key={`${session.id}-${bodyEpoch}`} blocks={bodyDraft.current!.blocks} onChange={blocks => { if (coordinator.active?.id !== session.id) return; const draft = { ...bodyDraft.current!, blocks: blocks as DraftDocument['blocks'] }; bodyDraft.current = draft; inputSession(draft.documentId, stateRef.current?.view.inputSession?.composing || false); coordinator.replace(draft, stateRef.current!.map); }} onComposition={value => { if (coordinator.active?.id === session.id) inputSession(bodyDraft.current!.documentId, value); }} onBlur={() => { if (coordinator.active?.id === session.id) flushBody(); }} ready={view => { if (coordinator.active?.id === session.id) bodyView.current = view; }} />
        <div className="source-panel"><h2>来源样本 · 只读</h2>{session.bundle.sources.slice(0, 1).map(source => <div key={source.sourceRevisionId}><small>{source.sourceId} / {source.sourceRevisionId} · {source.coverage.description}</small>{source.blocks.map(block => <p key={block.id}><Runs runs={block.runs} /></p>)}</div>)}<div className="source-images">{session.bundle.assets.map(asset => <figure key={`${asset.id}-${asset.version}`}><img src={window.e0.assetUrl(asset.id, asset.version)} alt={`本地合成资源 ${asset.id}`} /><figcaption>{asset.id} / {asset.version}</figcaption></figure>)}</div></div>
        {reference && <div className="reference-panel" role="region" aria-label="引用时版本"><h2>引用时版本 · {reference.version}</h2><p>{reference.text}</p><blockquote>{reference.selectedText}</blockquote>{reference.transcript && <pre data-testid="transcript-time-description">{transcriptTimeDescription(reference.transcript)}</pre>}<small>{reference.kind} / {reference.targetId} · 仅展示确切版本，不猜测新段落</small></div>}
      </aside>
    </section>
    {closePrompt && <div className="modal"><div ref={closeDialog} role="dialog" aria-modal="true" aria-label="关闭隔离验证程序"><h2>关闭前处理当前稿</h2><p>保存并等待当前稿确认落盘，或明确丢弃内存中的未保存编辑。</p>{(error || session.error) && <p role="alert">{error || session.error}</p>}<button onClick={() => void close('saved')}>保存并关闭</button><button onClick={() => void close('discard')}>丢弃未保存并关闭</button><button onClick={() => void close('cancel')}>取消</button></div></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
