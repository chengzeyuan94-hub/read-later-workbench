import React, { useEffect, useRef, useState } from 'react';
import { pointLength, pointSlice, type SourceReference } from '../editor-core/model.js';
import type { AsrAPI, AsrContentState, AsrDocument } from '../shared/asr-contracts.js';
import { readSourceSelection } from './editor-workspace-helpers.js';
import { AsrCorrectionSession, asrRangeReference } from './asr-workspace-helpers.js';
import type { AsrOpenTarget } from './asr-panel.js';
import { dispatchSaveShortcut, isActiveSourceModal } from './save-shortcut.js';
import './asr-workspace.css';

export type AsrReferenceHandler = (reference: SourceReference, excerpt: string) => Promise<boolean>;
export function AsrWorkspace(props: { api: AsrAPI; target: AsrOpenTarget; title: string; onClose(): void; registerLeaveGuard?(guard: () => Promise<boolean>): () => void; onAddReference?: AsrReferenceHandler; mediaUrl?(mediaId: number, resultId: string): string; mediaKind?: 'video' | 'audio' }) {
  const callbacks = useRef(props); callbacks.current = props;
  const host = useRef<HTMLDialogElement>(null), textHost = useRef<HTMLDivElement>(null), player = useRef<HTMLMediaElement | null>(null), leavePromptHost = useRef<HTMLElement>(null);
  const [record, setRecord] = useState<AsrDocument | null>(null), recordRef = useRef(record); recordRef.current = record;
  const [target, setTarget] = useState(props.target), [collection, setCollection] = useState<AsrContentState | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [leavePrompt, setLeavePrompt] = useState(false), leaveResolve = useRef<((allow: boolean) => void) | null>(null), leavePending = useRef<Promise<boolean> | null>(null);
  const [conflict, setConflict] = useState<AsrDocument | null>(null), [, redraw] = useState(0), session = useRef<AsrCorrectionSession | null>(null), composing = useRef(false), compositionBefore = useRef('');
  const mounted = useRef(true), epoch = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null), origin = useRef<HTMLElement | null>(null);
  const selection = useRef<{ start: number; end: number; excerpt: string } | null>(null), actions = useRef({ close: async () => {}, leave: async () => false, autoSave: async () => {}, save: async () => false });
  const refresh = () => { if (mounted.current) redraw(value => value + 1); };
  function clearTimer() { if (timer.current) clearTimeout(timer.current); timer.current = null; }
  function schedule() { clearTimer(); timer.current = setTimeout(() => void actions.current.autoSave(), 750); }
  function install(value: AsrDocument) { recordRef.current = value; setRecord(value); }
  async function load(next: AsrOpenTarget) {
    const attempt = ++epoch.current; setBusy(true); setError('');
    try {
      const value = await props.api.read(next.contentId, next.resultId, next.revision ?? 1);
      if (!mounted.current || attempt !== epoch.current) return;
      if (value.result.contentId !== next.contentId || value.result.resultId !== next.resultId || next.revision && next.revision !== (value.correction?.revision ?? 1)) throw new Error('转录版本身份不符。');
      install(value); setTarget(next); setEditing(false); session.current = null; selection.current = null; setConflict(null); clearTimer();
    } catch (error) { if (mounted.current && attempt === epoch.current) setError(error instanceof Error ? error.message : '转录暂不可读。'); }
    finally { if (mounted.current && attempt === epoch.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; origin.current = document.activeElement as HTMLElement; host.current?.showModal(); void load(props.target); return () => { mounted.current = false; ++epoch.current; clearTimer(); leaveResolve.current?.(false); host.current?.close(); if (origin.current?.isConnected) origin.current.focus(); }; }, []);
  useEffect(() => { let active = true; const read = () => { void props.api.list(props.target.contentId).then(value => { if (active) setCollection(value); }).catch(() => {}); }; read(); const interval = setInterval(read, 1500); return () => { active = false; clearInterval(interval); }; }, [props.api, props.target.contentId]);
  async function save(): Promise<boolean> {
    if (composing.current) { setNotice('中文输入尚未结束，请先完成候选。'); return false; }
    clearTimer(); const current = session.current;
    if (!current) return true;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!await current.barrier()) { setError(current.error); return false; }
        if (current.revision && recordRef.current?.result.resultId === current.resultId) {
          const latest = await props.api.read(target.contentId, current.resultId, current.revision);
          if (recordRef.current?.result.resultId !== current.resultId || !mounted.current) return false;
          install(latest);
        }
        if (!current.dirty && !current.saving && !composing.current) { setError(''); return true; }
      }
      setNotice('保存期间仍有新输入，请完成输入后再次保存。'); return false;
    } catch { setError('校对保存或读取确认未完成，当前输入保留。'); return false; }
  }
  async function leave(): Promise<boolean> {
    if (leavePending.current) return leavePending.current;
    const operation = (async () => { try { if (await save()) return true; } catch { setError('校对保存未完成，当前输入保留。'); } setLeavePrompt(true); return new Promise<boolean>(resolve => { leaveResolve.current = resolve; }); })();
    leavePending.current = operation; const allow = await operation; leavePending.current = null; return allow;
  }
  async function close() { if (await leave()) callbacks.current.onClose(); }
  async function autoSave() { if (composing.current) { schedule(); return; } if (session.current && !['failed', 'conflict'].includes(session.current.status)) try { await save(); } catch { setError('校对保存未完成；当前输入保留。'); } }
  actions.current = { close, leave, autoSave, save };
  useEffect(() => { const key = (event: KeyboardEvent) => { if (!isActiveSourceModal(host.current, [...document.querySelectorAll('dialog:modal')])) return; dispatchSaveShortcut(event, { composing: composing.current, save: () => { void actions.current.save(); } }); }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, []);
  useEffect(() => { if (!leavePrompt) return; const frame = requestAnimationFrame(() => { const prompt = leavePromptHost.current; prompt?.scrollIntoView({ block: 'end', behavior: 'instant' }); prompt?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); }); return () => cancelAnimationFrame(frame); }, [leavePrompt]);
  useEffect(() => props.registerLeaveGuard?.(async () => { const allow = await actions.current.leave(); if (allow) host.current?.close(); return allow; }), [props.registerLeaveGuard]);
  function resolveLeave(allow: boolean) { setLeavePrompt(false); leaveResolve.current?.(allow); leaveResolve.current = null; if (!allow) requestAnimationFrame(() => { const dialog = host.current; if (dialog?.open) (dialog.querySelector<HTMLTextAreaElement>('[aria-label="转录校对正文"]') ?? dialog.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true }); }); }
  async function switchTarget(next: AsrOpenTarget) { if (composing.current) { setNotice('请先完成中文候选，再切换版本。'); return; } if (await save()) await load(next); }
  async function beginCorrection() {
    const value = recordRef.current; if (!value || composing.current) return; setBusy(true);
    try { const latest = value.correctionHead ? await props.api.read(target.contentId, target.resultId, value.correctionHead) : { ...value, correction: null }; if (!mounted.current || recordRef.current?.result.resultId !== value.result.resultId) return; session.current = new AsrCorrectionSession(target.contentId, latest, props.api, refresh); install(latest); setEditing(true); setConflict(null); selection.current = null; setNotice('校对独立保存；原始响应和已有引用保持原版本。'); }
    catch { setError('最新校对版本不可读，原稿继续保留。'); } finally { if (mounted.current) setBusy(false); }
  }
  function change(text: string, remember = true) { session.current?.replace(text, remember); schedule(); }
  function history(kind: 'undo' | 'redo') { if (composing.current) return; session.current?.history(kind); schedule(); }
  async function finishEditing() { if (await save()) { setEditing(false); selection.current = null; } }
  function rememberSelection() { if (editing || !textHost.current) return; try { const value = readSourceSelection(textHost.current, window.getSelection()); selection.current = value && { start: value.start, end: value.end, excerpt: value.excerpt }; } catch { selection.current = null; } }
  async function addReference() {
    const value = recordRef.current, selected = selection.current; if (!value || !selected || !props.onAddReference || editing || composing.current) { setNotice('请先结束校对并保存，再在同一分片的只读文字中选择选区。'); return; }
    try { const segment = value.correction?.segment ?? value.result.segment, ref = asrRangeReference(segment, selected.start, selected.end); if (await props.onAddReference(ref, selected.excerpt)) setNotice('已加入当前导图，引用绑定此P与确切文字版本。'); else setNotice('请先打开已有的手工整理工作区，再添加引用；转录查看不要求初始化稿件。'); } catch (error) { setError(error instanceof Error ? error.message : '引用未完成。'); }
  }
  async function adopt() { if (!record || editing || !await save()) return; setBusy(true); try { setCollection(await props.api.adopt(target.contentId, target.resultId, { kind: record.correction ? 'correction' : 'original', revision: record.correction?.revision ?? 1 })); setNotice('已明确选择此来源版本；历史引用与人工稿保持不变。'); install(await props.api.read(target.contentId, target.resultId, record.correction?.revision ?? 1)); } catch { setError('来源采用未完成，已有版本保持。'); } finally { setBusy(false); } }
  async function exportVersion() { if (!record || !await save()) return; const value = recordRef.current!; setBusy(true); try { const result = await props.api.export(target.contentId, [{ resultId: value.result.resultId, version: { kind: value.correction ? 'correction' : 'original', revision: value.correction?.revision ?? 1 } }]); if (result.status === 'exported') setNotice('此确切转录版本已导出；默认不包含原音视频。'); } catch (error) { setError(error instanceof Error ? error.message : '导出未完成，已有文件保持。'); } finally { setBusy(false); } }
  async function exportCurrentSources() {
    if (!record || !await save()) return; setBusy(true);
    try {
      const snapshot = await props.api.list(target.contentId), selected = snapshot.results.filter(result => result.active).map(result => ({ resultId: result.resultId, version: result.adopted }));
      if (!selected.length) { setNotice('本次请求尚无已保存的转录；历史资料可按所选分片导出。'); return; }
      const result = await props.api.export(target.contentId, selected);
      if (result.status === 'exported') setNotice('本次已保存转录按各自确认的版本导出；失败或未完成范围会在文件中标为部分覆盖。当前查看版本如未确认，不会偷偷替换已保存版本。');
    } catch (error) { setError(error instanceof Error ? error.message : '导出未完成，已有文件保持。'); } finally { setBusy(false); }
  }
  function playInput() { if (!record || !player.current) return; player.current.currentTime = record.result.inputRange.startMs / 1000; void player.current.play().catch(() => setError('本地媒体无法播放，请检查固定原件。')); }
  const localMediaUrl = props.mediaUrl ?? (props.api.mediaUrl ? (_mediaId: number, resultId: string) => props.api.mediaUrl!(target.contentId, resultId) : undefined);
  const text = editing ? session.current?.text ?? '' : record?.correction?.text ?? record?.result.text ?? '', revision = record?.correction?.revision ?? 1;
  const range = target.range, pieces = range && range.end <= pointLength(text) && (!range.excerpt || pointSlice(text, range.start, range.end) === range.excerpt) ? { before: pointSlice(text, 0, range.start), selected: pointSlice(text, range.start, range.end), after: pointSlice(text, range.end) } : null;
  return <dialog className="e2-asr-workspace" ref={host} aria-label="转录来源与校对" onCancel={event => { event.preventDefault(); void close(); }} onKeyDown={event => { dispatchSaveShortcut(event, { composing: composing.current, save: () => { void save(); } }); }}>
    <header><div><h2>{props.title}</h2><p>转录来源／校对 · 独立于我的整理稿和导图</p></div><button onClick={() => void close()} aria-label="关闭转录来源">返回阅读 ×</button></header>
    {record ? <>
      <div className="e2-asr-toolbar"><label>媒体／输入分片 <select disabled={busy || composing.current} aria-label="转录媒体分片" value={record.result.resultId} onChange={event => void switchTarget({ contentId: target.contentId, resultId: event.target.value, revision: 1 })}>{(collection?.results ?? [{ resultId: record.result.resultId, partId: record.result.partId, chunkOrder: record.result.chunkOrder, active: true }]).map(item => <option key={item.resultId} value={item.resultId}>{item.partId} · 输入分片 {item.chunkOrder + 1}{item.active ? '' : ' · 历史'}</option>)}</select></label><label>文字版本 <select disabled={busy || editing || composing.current} aria-label="转录文字版本" value={revision} onChange={event => void switchTarget({ ...target, revision: Number(event.target.value) })}><option value={1}>原始转录 · revision 1</option>{record.correctionHistory.map(item => <option key={item.revision} value={item.revision}>人工校对 · revision {item.revision}</option>)}</select></label><button disabled={busy || editing} onClick={() => void beginCorrection()}>校对文字</button><button disabled={busy || editing} onClick={() => void adopt()}>采用此来源版本</button><button disabled={busy || composing.current} onClick={() => void exportVersion()}>导出当前输入分片 .md</button><button disabled={busy || composing.current} onClick={() => void exportCurrentSources()}>导出本次已保存转录（采用版本）.md</button></div>
      <p className="e2-muted" data-testid="asr-version-identity">媒体 {record.result.mediaId} · {record.result.partId} · {record.result.sourceIdentity} · 输入分片 {record.result.chunkOrder + 1} · {record.correction ? `人工校对 revision ${revision}，来源原稿 revision 1` : '供应商原始转录 revision 1，只读'} · 采用：{record.adopted.kind} revision {record.adopted.revision}</p>
      <p className="e2-muted">原P输入范围 {record.result.inputRange.startMs}–{record.result.inputRange.endMs} ms。供应商未提供逐句时间；只定位文字和版本，不把输入范围当作字幕时间。此分片已处理不代表整条全文无遗漏或字字正确。</p>
      {localMediaUrl && <section className="e2-input-player" aria-label="固定原P输入分片播放">{props.mediaKind === 'audio' ? <audio controls ref={element => { player.current = element; }} src={localMediaUrl(record.result.mediaId, record.result.resultId)} onTimeUpdate={() => { if (player.current && player.current.currentTime * 1000 >= record.result.inputRange.endMs) player.current.pause(); }} onError={() => setError('固定本地媒体不可读，未回退到网络。')} /> : <video controls ref={element => { player.current = element; }} src={localMediaUrl(record.result.mediaId, record.result.resultId)} onTimeUpdate={() => { if (player.current && player.current.currentTime * 1000 >= record.result.inputRange.endMs) player.current.pause(); }} onError={() => setError('固定本地媒体不可读，未回退到网络。')} />}<button onClick={playInput}>播放本输入分片（粗定位）</button></section>}
      {editing ? <section className="e2-correction-editor"><div><strong>{session.current?.status === 'saved' ? `校对已保存 revision ${session.current.revision}` : session.current?.status === 'saving' ? '校对正在保存…' : session.current?.status === 'conflict' ? '保存冲突 · 当前输入保留' : session.current?.status === 'failed' ? '校对保存失败 · 当前输入保留' : '校对有未保存修改'}</strong><button disabled={!session.current?.undo.length || composing.current} onMouseDown={event => event.preventDefault()} onClick={() => history('undo')}>撤销</button><button disabled={!session.current?.redo.length || composing.current} onMouseDown={event => event.preventDefault()} onClick={() => history('redo')}>重做</button><button disabled={busy || composing.current} onClick={() => void save()}>保存校对</button><button disabled={busy || composing.current} onClick={() => void finishEditing()}>保存并阅读</button></div><textarea aria-label="转录校对正文" value={text} onCompositionStart={() => { composing.current = true; compositionBefore.current = session.current?.text ?? ''; }} onCompositionEnd={event => { change(event.currentTarget.value, false); session.current?.rememberComposition(compositionBefore.current); composing.current = false; refresh(); schedule(); }} onChange={event => change(event.target.value, !composing.current)} onKeyDown={event => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo'); } }} />{session.current?.status === 'conflict' && <button onClick={() => { void props.api.read(target.contentId, target.resultId).then(setConflict); }}>查看磁盘校对（保留当前输入）</button>}{conflict && <details open><summary>磁盘已保存版本 {conflict.correctionHead}</summary><p className="e2-asr-text">{conflict.correction?.text || conflict.result.text}</p><p>当前输入仍保留。关闭前可复制保留；不会自动覆盖任一版本。</p></details>}</section> : <div className="e2-asr-reading"><div><span>{record.correction ? '人工校对稿' : '供应商原稿（未校对）'}</span><button disabled={!props.onAddReference} onMouseDown={event => event.preventDefault()} onClick={() => void addReference()}>选区引用到导图</button>{!props.onAddReference && <small>先打开已有手工整理工作区可添加引用；无需为查看转录创建稿件。</small>}</div><div ref={textHost} onMouseUp={rememberSelection} onKeyUp={rememberSelection}><p className="e2-asr-text" data-source-kind="transcript" data-source-identity={`${record.result.resultId}@${revision}`} data-source-block={(record.correction?.segment ?? record.result.segment).segmentId}>{pieces ? <>{pieces.before}<mark>{pieces.selected}</mark>{pieces.after}</> : text}</p></div></div>}
    </> : <p role="status">{busy ? '正在读取已保存的转录来源…' : '所选转录暂不可读。'}</p>}
    {notice && <p className="e2-muted" role="status">{notice}</p>}{error && <p className="e2-error" role="alert">{error}</p>}
    {leavePrompt && <section ref={leavePromptHost} className="e2-asr-warning" role="alertdialog" aria-label="校对未保存"><p>校对尚未保存，当前输入仍在本窗口。可继续编辑或重试；离开将放弃本次未保存输入。</p><button onClick={() => resolveLeave(false)}>保留输入继续编辑</button><button onClick={() => { void save().then(saved => { if (saved) resolveLeave(true); }); }}>重试保存并离开</button><button onClick={() => resolveLeave(true)}>明确放弃未保存输入并离开</button></section>}
  </dialog>;
}
