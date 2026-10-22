import { createHash } from 'node:crypto';
import type { CollectionItem, Connection } from '../shared/contracts.js';

type Json = Record<string, any>;
const text = (value: unknown): string => value == null ? '' : String(value).trim();
export function epochMillis(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? (number < 1e12 ? number * 1000 : number) : null;
}
export function mapBilibiliFavorite(raw: Json, folderId: string): CollectionItem | null {
  const aid = text(raw.id);
  const bvid = text(raw.bvid);
  if (!aid && !bvid) return null;
  // AV id survives unavailable/deleted entries, whose BV id can disappear.
  const sourceId = aid ? `av${aid}` : bvid;
  return {
    sourceId, title: text(raw.title) || '标题未取得', author: text(raw.upper?.name),
    url: `https://www.bilibili.com/video/${bvid || sourceId}`,
    kind: Number(raw.type) === 12 ? 'audio' : 'video',
    publishedAt: epochMillis(raw.pubtime), collectedAt: epochMillis(raw.fav_time), folderIds: [folderId],
  };
}
export function mapXhsFavorite(raw: Json): CollectionItem | null {
  const card = raw.note_card ?? raw.noteCard ?? raw;
  const sourceId = text(raw.note_id ?? raw.noteId ?? raw.id ?? card.note_id ?? card.noteId ?? card.id);
  const token = text(raw.xsec_token ?? raw.xsecToken ?? card.xsec_token ?? card.xsecToken);
  if (!/^[a-f0-9]{24}$/i.test(sourceId) || !token) return null;
  const user = card.user ?? raw.user ?? {};
  const url = new URL(`https://www.xiaohongshu.com/explore/${sourceId}`);
  url.searchParams.set('xsec_token', token);
  url.searchParams.set('xsec_source', 'pc_user');
  return {
    sourceId, title: text(card.display_title ?? card.displayTitle ?? card.title ?? raw.title) || '标题未取得',
    author: text(user.nickname ?? user.nick_name ?? user.name), url: url.toString(),
    kind: text(card.type ?? raw.type) === 'video' ? 'video' : 'image',
    // The collection API does not reliably expose favorite time. Never substitute publication time.
    publishedAt: epochMillis(card.time ?? card.publish_time), collectedAt: null, folderIds: ['saved'],
  };
}
export function mergeFavorite(target: Map<string, CollectionItem>, item: CollectionItem): void {
  const prior = target.get(item.sourceId);
  if (!prior) { target.set(item.sourceId, item); return; }
  prior.folderIds = [...new Set([...prior.folderIds, ...item.folderIds])];
  if (item.collectedAt && (!prior.collectedAt || item.collectedAt > prior.collectedAt)) prior.collectedAt = item.collectedAt;
}
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function signWbi(params: Record<string, string | number>, imgKey: string, subKey: string, now = Date.now()): URLSearchParams {
  if (!imgKey || !subKey) throw new Error('B站 WBI 签名信息未取得，请重试');
  const raw = imgKey + subKey;
  const salt = MIXIN.map(i => raw[i] || '').join('').slice(0, 32);
  const values: Record<string, string> = {};
  const all = { ...params, wts: Math.floor(now / 1000) };
  for (const key of Object.keys(all).sort()) values[key] = String(all[key as keyof typeof all]).replace(/[!'()*]/g, '');
  const query = new URLSearchParams(values);
  const encoded = query.toString().replace(/\+/g, '%20');
  query.set('w_rid', createHash('md5').update(encoded + salt).digest('hex'));
  return query;
}
export function progressiveMp4(payload: Json, expectedSeconds = 0): string | null {
  if (payload.is_preview || payload.isPreview) return null;
  if (expectedSeconds > 0) {
    const actualMilliseconds = Number(payload.timelength);
    if (!Number.isFinite(actualMilliseconds) || actualMilliseconds <= 0 || actualMilliseconds + 2000 < expectedSeconds * 1000) return null;
  }
  const streams = payload.durl;
  if (!Array.isArray(streams) || streams.length !== 1) return null;
  const url = text(streams[0]?.url);
  if (!/^https?:\/\//i.test(url)) return null;
  // A DASH video-only segment must never be labelled as a complete video.
  if (payload.dash || /\.m4s(?:\?|$)/i.test(url)) return null;
  if (text(payload.format).toLowerCase().includes('mp4') || /\.mp4(?:\?|$)/i.test(url)) return url.replace(/^http:/i, 'https:');
  return null;
}

/** Errors can contain signed note/CDN URLs. Credentials never belong in UI or reports. */
export function sanitizeSourceError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '平台请求失败');
  return raw.replace(/\b(cookie|authorization)\s*[:=][^\r\n]*/gi, '$1=[已隐藏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[来源地址已隐藏]')
    .replace(/\b(cookie|authorization|xsec_token|access_token|refresh_token|token|SESSDATA|bili_jct)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .slice(0, 500);
}

/** A content failure cannot invalidate an already authenticated platform account. */
export function connectionAfterDetailFailure(connection: Connection, error: unknown): Connection {
  const detail = sanitizeSourceError(error);
  return detail.includes('LOGIN_REQUIRED') ? { ...connection, state: 'expired', message: detail } : connection;
}

export interface XhsDomVideoCandidate {
  currentSrc?: unknown;
  src?: unknown;
  sources?: unknown[];
}

/** Select only an unambiguous MP4 from the current note's own player. */
export function currentXhsDomVideo(expectedNoteId: string, pageUrl: string, candidates: XhsDomVideoCandidate[]): string | null {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return null; }
  if (page.protocol !== 'https:' || !/(^|\.)xiaohongshu\.com$/i.test(page.hostname)) return null;
  const match = page.pathname.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]{24})(?:\/|$)|\/user\/profile\/[^/]+\/([a-f0-9]{24})(?:\/|$)/i);
  if (!match || (match[1] || match[2])!.toLowerCase() !== expectedNoteId.toLowerCase()) return null;
  const direct = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    try {
      const url = new URL(raw);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) return null;
      if (!/(^|\.)xhscdn\.(com|net)$/i.test(url.hostname) || !/\.mp4$/i.test(url.pathname)) return null;
      url.protocol = 'https:';
      url.port = '';
      return url.toString();
    } catch { return null; }
  };
  const selected = new Set<string>();
  for (const candidate of candidates) {
    let url = direct(candidate.currentSrc) || direct(candidate.src);
    if (!url && Array.isArray(candidate.sources)) {
      const alternatives = [...new Set(candidate.sources.map(direct).filter((value): value is string => !!value))];
      if (alternatives.length === 1) url = alternatives[0]!;
    }
    if (url) selected.add(url);
  }
  return selected.size === 1 ? [...selected][0]! : null;
}
