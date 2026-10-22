import React from 'react';
import type { EditorExportMediaPreview, EditorExportProgress } from '../shared/editor-contracts.js';
export function exportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
export function ExportMediaSummary({ preview, include, onChange, disabled }: { preview: EditorExportMediaPreview | null; include: boolean; onChange(value: boolean): void; disabled: boolean }) {
  return <section className="e1-export-summary" aria-label="音视频附件选项">
    <label className="e1-export-option"><input type="checkbox" data-testid="editor-export-include-media" checked={include} disabled={disabled || !preview} onChange={event => onChange(event.target.checked)} />包含本地音视频</label>
    {!include ? <p>默认不复制音视频。正文与必要图片照常导出；可在需要时包含下列本地文件。</p> : <p>将得到 Markdown 与附件的目录包，音视频使用相对链接，不重新下载。它是当前成果的阅读包，不是完整工程备份。</p>}
    {preview ? <><p>{preview.items.filter(item => item.status === 'available').length} 个可用音视频，共 {exportBytes(preview.totalBytes)}{preview.missingCount ? `；${preview.missingCount} 个不可用` : ''}。</p>
      <ul className="e1-export-media">{preview.items.map(item => <li key={item.mediaId} className={item.status === 'missing' ? 'missing' : ''}>{item.label} · {item.kind === 'video' ? '视频' : '音频'} · {item.status === 'available' ? exportBytes(item.bytes) : `不可用：${item.reason || '文件缺失或无法读取'}`}</li>)}</ul>
      {include && preview.missingCount > 0 && <p className="e1-error" role="alert">部分所需媒体不可用。本次不能导出完整音视频包；请恢复文件，或取消包含音视频。</p>}
      {!preview.items.length && <p>当前收藏没有可包含的音视频。</p>}</> : <p role="status">正在检查本地音视频…</p>}
  </section>;
}
export function ExportProgress({ progress, cancelling, onCancel }: { progress: EditorExportProgress | null; cancelling: boolean; onCancel(): void }) {
  return <section className="e1-export-progress" role="status" aria-label="导出进度"><span>{cancelling ? '正在取消，已存在的目标与当前稿保留…' : progress?.phase === 'copying' ? `正在复制 ${progress.currentFile || '本地附件'}` : progress?.phase === 'publishing' ? '正在校验并完成导出…' : '正在准备；请在系统对话框选择新位置…'}</span>{progress && progress.totalBytes > 0 && <><progress value={progress.copiedBytes} max={progress.totalBytes} /><span>{exportBytes(progress.copiedBytes)} / {exportBytes(progress.totalBytes)}</span></>}<button disabled={cancelling} data-testid="editor-export-cancel-copy" onClick={onCancel}>取消导出</button></section>;
}
