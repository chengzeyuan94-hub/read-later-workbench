import type { ContentRecord, MediaRecord } from '../shared/contracts';

/** Download locations can contain credentials. They are never useful in user-facing errors. */
export function safeError(value?: string | null): string {
  return (value || '').replace(/https?:\/\/[^\s<>"']+/gi, '[资源地址已隐藏]')
    .replace(/\b(cookie|token|authorization|sessdata|xsec_token|signature)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]');
}

export function currentMedia(item: Pick<ContentRecord, 'media'>): MediaRecord[] {
  return item.media.filter(m => m.current !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

export function hasSaveFailure(item: ContentRecord): boolean {
  return item.detailState === 'failed' || item.repairState === 'failed'
    || (item.detailState === 'succeeded' && item.mediaManifestComplete === false)
    || currentMedia(item).some(media => media.state === 'failed');
}

export function mediaLabel(media: MediaRecord, index = 0): string {
  const position = (media.order ?? index) + 1;
  if (media.kind === 'video') return media.title ? (/^P\d+\b/i.test(media.title) ? media.title : `P${position} ${media.title}`) : `P${position}`;
  return media.title || (media.kind === 'audio' ? `音频 ${position}` : `图片 ${position}`);
}

export function contentSaveState(item: ContentRecord): { text: string; failed: boolean } {
  if (item.availability === 'unavailable') return { text: '内容失效 / 无法访问', failed: true };
  if (item.availability === 'unsupported') return { text: '当前格式不支持保存', failed: true };
  if (item.detailState === 'failed') return { text: '正文 / 清单获取失败', failed: true };
  if (item.detailState === 'queued') return { text: '正文排队获取', failed: false };
  if (item.detailState === 'running') return { text: '正在获取正文与清单', failed: false };
  if (!item.bodyComplete) return { text: '正文尚未完整', failed: false };
  const media = currentMedia(item);
  if (item.mediaManifestComplete === false || ((item.kind === 'video' || item.kind === 'audio') && !media.some(m => m.kind === item.kind))) {
    return { text: `${item.kind === 'video' ? '视频' : item.kind === 'audio' ? '音频' : '媒体'}清单未取得`, failed: !!item.manifestError };
  }
  if (media.some(m => m.state === 'failed')) return { text: '资源下载失败 · 可重试', failed: true };
  if (media.some(m => m.state === 'running')) return { text: '资源下载中', failed: false };
  if (media.some(m => m.state === 'queued')) return { text: '资源排队下载', failed: false };
  if (item.offline) return { text: '● 可离线', failed: false };
  return { text: '本地资源尚未完整', failed: false };
}

/** E4.9: whether the saved source files can actually feed a digest request —
 * the same gate the batch lane uses before freezing a request scope. */
export function digestReady(item: ContentRecord): boolean {
  if (!item.offline || !item.bodyComplete || item.mediaManifestComplete !== true) return false;
  return currentMedia(item).every(media => media.state === 'succeeded' && !!media.localPath);
}

/** E4.9: plain-Chinese reasons a collection cannot be digested yet, for the
 * note workspace's honest blocked state. */
export function digestBlockReasons(item: ContentRecord): string[] {
  const reasons: string[] = [];
  const error = safeError(item.manifestError || item.detailError);
  if (item.availability === 'unavailable') reasons.push('平台内容已失效或当前账号无法访问');
  else if (item.availability === 'unsupported') reasons.push('平台未提供可保存的完整格式');
  if (!item.bodyComplete) {
    if (/长文章/.test(error)) reasons.push('X 长文章只有摘要，完整正文还没取得');
    else if (/转发/.test(error)) reasons.push('这是转发包装，原帖正文还没取得');
    else reasons.push('正文未完整取得');
  }
  if (item.mediaManifestComplete === false && !reasons.length) reasons.push(error ? `媒体清单尚未完整取得：${error}` : '媒体清单尚未完整取得');
  const pending = currentMedia(item).filter(media => media.state !== 'succeeded' || !media.localPath);
  if (pending.length) reasons.push(pending.some(media => media.state === 'failed') ? '有资源下载失败，重试后可消化' : '本地资源还没下载完');
  if (!reasons.length) reasons.push(error || '资料还没准备好');
  return reasons;
}

/** Preserve position when changing a filter removes the card that opened the reader. */
export function restoreReaderFocus(origin: HTMLElement | null, cardIds: number[], openedIndex: number, fallback: HTMLElement | null): void {
  if (origin?.isConnected) { origin.focus(); return; }
  const candidates = [cardIds[openedIndex], cardIds[openedIndex - 1], ...cardIds];
  for (const id of candidates) {
    if (id === undefined) continue;
    const card = document.querySelector<HTMLElement>(`[data-content-id="${id}"]`);
    if (card) { card.focus(); return; }
  }
  fallback?.focus();
}
