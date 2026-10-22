import React, { useEffect, useRef } from 'react';
import { exportBytes } from './export-dialog-content';

export interface DeleteRequest { ids: number[]; bytes: number; blocked: { id: number; reason: string }[]; digested: number }

/** E4.6 destructive confirm: soft-deletes local copies, keeps platform favourites. */
export function DeleteConfirm({ request, busy, onCancel, onConfirm }: { request: DeleteRequest; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const blockedLines = request.blocked.map(row => `#${row.id}：${row.reason}`);
  return <dialog ref={dialog} className="delete-confirm" aria-labelledby="delete-confirm-title" onCancel={onCancel}>
    <h2 id="delete-confirm-title">删除 {request.ids.length} 条收藏？</h2>
    <p>将删除本机的正文、图片和视频、笔记（导图与文稿）和 AI 整理结果{request.digested ? `，包括 ${request.digested} 条消化库笔记` : ''}，约释放 {exportBytes(request.bytes)}。平台上的收藏不受影响；之后同步会自动跳过它们。此操作无法撤销。</p>
    {!!request.blocked.length && <div className="delete-blocked"><p>其中 {request.blocked.length} 条暂时无法删除，保留不动：</p><ul>{blockedLines.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
    <div className="delete-actions">
      <button className="btn" onClick={onCancel} autoFocus>取消</button>
      <button className="btn btn-danger" data-testid="delete-confirm" disabled={busy || !request.ids.length} onClick={onConfirm}>删除 {request.ids.length} 条</button>
    </div>
  </dialog>;
}

/** E4.7 全量同步确认：范围切到「全部」前的明确提醒。 */
export function SyncRangeConfirm({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="delete-confirm" aria-labelledby="sync-range-title" onCancel={onCancel}>
    <h2 id="sync-range-title">同步全部收藏？</h2>
    <p>首次全量同步可能需要较长时间，并会下载所有图片和视频（B站视频较大），期间平台可能限流并自动冷却。</p>
    <div className="delete-actions">
      <button className="btn" onClick={onCancel} autoFocus>取消</button>
      <button className="btn" data-testid="sync-range-all" disabled={busy} onClick={onConfirm}>开始全量同步</button>
    </div>
  </dialog>;
}

/** Settings → 本地数据 tombstone list. 重新导入 refetches body and media; notes stay gone. */
export function DeletedList({ rows, busy, onRestore, onClose }: { rows: { contentId: number; title: string; platform: string; deletedAt: number; bytesFreed: number }[]; busy: boolean; onRestore: (id: number) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const date = (at: number) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  return <dialog ref={dialog} className="delete-confirm deleted-list" aria-labelledby="deleted-list-title" onCancel={onClose}>
    <h2 id="deleted-list-title">已删除的收藏 {rows.length} 条</h2>
    <p>重新导入只取回正文与媒体；笔记（导图与文稿）和 AI 整理结果无法恢复。</p>
    <ul className="deleted-rows">{rows.map(row => <li key={row.contentId}><span>{row.title || '（无标题）'}<small>{row.platform} · {date(row.deletedAt)} · 释放约 {exportBytes(row.bytesFreed)}</small></span><button className="text-button" disabled={busy} onClick={() => onRestore(row.contentId)}>重新导入</button></li>)}</ul>
    <div className="delete-actions"><button className="btn" onClick={onClose} autoFocus>关闭</button></div>
  </dialog>;
}
