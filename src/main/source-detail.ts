import { createHash } from 'node:crypto';
import type { CollectionItem, DetailResult, MediaDescriptor } from '../shared/contracts.js';
import { currentXhsDomVideo, epochMillis, progressiveMp4, sanitizeSourceError } from './source-core.js';

type Json = Record<string, any>;
export const SOURCE_ADAPTER_VERSION = 2;
export class SourceContentUnavailableError extends Error {
  constructor(public readonly code: number) { super(`平台内容不可访问（${code}），已保留本地收藏和文件`); }
}
export function unavailableDetail(error: SourceContentUnavailableError): DetailResult {
  return { body: '', bodyComplete: false, bodyStatus: 'unavailable', subtitleStatus: 'unavailable', media: [], mediaManifestComplete: false, availability: 'unavailable', manifestError: sanitizeSourceError(error), adapterVersion: SOURCE_ADAPTER_VERSION };
}
/** A CDN host and its query are locations. The source path identifies the asset/version. */
export function mediaPathIdentity(raw: string): string {
  try { return new URL(raw).pathname; } catch { return raw; }
}
function shortIdentity(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
export function biliVideoDescriptor(sourceId: string, page: Json, play: Json, remoteUrl: string, referer: string): MediaDescriptor {
  const cid = String(page.cid);
  const quality = String(play.quality ?? 16);
  const version = `mp4:codec${String(play.video_codecid ?? play.codecid ?? 'platform-default')}:qn${quality}`;
  return { kind: 'video', remoteUrl, referer, mime: 'video/mp4', resourceKey: `bilibili:${sourceId}:cid:${cid}:video:${version}`, sourceIdentity: `cid:${cid}`, role: 'part', version, durationSeconds: Number(play.timelength) > 0 ? Number(play.timelength) / 1000 : undefined, order: Number(page.page) || 1, title: `P${Number(page.page) || 1}${page.part ? ` ${String(page.part)}` : ''}` };
}
/** Platform stream-group labels are opaque; only each entry's own format/codecs/timing prove an eligible alias. */
export function selectXhsPlayableStream(streams: Json | undefined, expectedSeconds = 0, drmType?: unknown): Json | null {
  if (!streams || typeof streams !== 'object' || (drmType != null && Number(drmType) !== 0)) return null;
  const candidates: Json[] = [];
  for (const group of Object.values(streams)) {
    const values = Array.isArray(group) ? group : [];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const format = String(value.format ?? '').toLowerCase();
      const videoCodec = String(value.videoCodec ?? value.video_codec ?? '').toLowerCase();
      const audioCodec = String(value.audioCodec ?? value.audio_codec ?? '').toLowerCase();
      if (format !== 'mp4' || !/^[a-z0-9._-]{1,32}$/i.test(videoCodec) || !/^(?:aac|mp4a(?:\..*)?)$/.test(audioCodec) || (value.drmType != null && Number(value.drmType) !== 0)) continue;
      let url: URL;
      try { url = new URL(String(value.masterUrl)); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/(^|\.)xhscdn\.(?:com|net)$/i.test(url.hostname) || !/\.mp4$/i.test(url.pathname)) continue;
      const duration = Number(value.duration ?? value.videoDuration);
      const audioDuration = Number(value.audioDuration);
      const videoDuration = Number(value.videoDuration);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(audioDuration) || audioDuration <= 0 || !Number.isFinite(videoDuration) || videoDuration <= 0) continue;
      // These stream timing fields are milliseconds; compare with the standard
      // DOM player's seconds when available, rather than infer duration from file extensions.
      const seconds = duration / 1000;
      const tolerance = Math.max(2, seconds * 0.02);
      if (Math.abs(videoDuration / 1000 - seconds) > tolerance || Math.abs(audioDuration / 1000 - seconds) > tolerance || (expectedSeconds > 0 && Math.abs(seconds - expectedSeconds) > Math.max(2, expectedSeconds * 0.02))) continue;
      candidates.push(value);
    }
  }
  return candidates.sort((a, b) => (Number(a.videoBitrate) || Number.MAX_SAFE_INTEGER) - (Number(b.videoBitrate) || Number.MAX_SAFE_INTEGER))[0] ?? null;
}
export function xhsVideoDescriptor(noteId: string, remoteUrl: string, referer: string, metadata: Json = {}): MediaDescriptor {
  const declaredCodec = String(metadata.codec ?? metadata.videoCodec ?? 'h264');
  const codec = /^(?:h\.?264|avc|avc[13](?:\..*)?)$/i.test(declaredCodec) ? declaredCodec.toLowerCase() : `source-declared:${declaredCodec}`;
  const videoId = typeof metadata.videoId === 'string' && metadata.videoId.trim() ? metadata.videoId.trim() : null;
  const variant = `${codec}:${String(metadata.width ?? '?')}x${String(metadata.height ?? '?')}:${String(metadata.videoBitrate ?? metadata.bitrate ?? '?')}:${String(metadata.qualityType ?? metadata.quality ?? '?')}:${String(metadata.format ?? 'mp4')}:${String(metadata.fps ?? '?')}`;
  // Reliable platform video identity plus actual encode attributes is independent
  // of both query and path signatures. A missing identity keeps the conservative asset-path fallback.
  const version = `${variant}:${videoId ? `video:${shortIdentity(videoId)}` : `asset:${shortIdentity(mediaPathIdentity(remoteUrl))}`}`;
  return { kind: 'video', remoteUrl, referer, mime: 'video/mp4', resourceKey: `xiaohongshu:${noteId}:video:${version}`, sourceIdentity: `note:${noteId}:video:${String(videoId || shortIdentity(mediaPathIdentity(remoteUrl)))}`, role: 'main', version, durationSeconds: Number(metadata.durationSeconds) > 0 ? Number(metadata.durationSeconds) : undefined, order: 0, title: '原视频' };
}
export function xhsImageDescriptor(noteId: string, raw: string | Json, index: number, referer: string): MediaDescriptor {
  const remoteUrl = typeof raw === 'string' ? raw : String(raw.url);
  const variant: Json = typeof raw === 'string' ? {} : raw;
  const reliableIdentity = typeof raw !== 'string' && typeof raw.identity === 'string' && raw.identity.trim() ? raw.identity.trim() : null;
  const identity = reliableIdentity ?? mediaPathIdentity(remoteUrl);
  // A platform fileId is independent of timed CDN path signatures. Describe the
  // chosen source variant explicitly; a new size/format/scene remains a new version.
  const version = reliableIdentity
    ? `image:${String(variant.width ?? '?')}x${String(variant.height ?? '?')}:${String(variant.scene ?? 'source')}:${String(variant.format ?? 'platform-default')}`
    : `image:${shortIdentity(mediaPathIdentity(remoteUrl))}`;
  const resource = reliableIdentity ? `file:${shortIdentity(reliableIdentity)}` : `index:${index}:${shortIdentity(identity)}`;
  return { kind: 'image', remoteUrl: remoteUrl.replace(/^http:/, 'https:'), referer, resourceKey: `xiaohongshu:${noteId}:image:${resource}:${version}`, sourceIdentity: identity, role: 'image', version, order: index, title: `图片 ${index + 1}` };
}
export async function readBiliDetail(item: CollectionItem, api: (path: string, params: Record<string, string | number>, signed?: boolean) => Promise<Json>, fetchJson: (url: string) => Promise<Json>): Promise<DetailResult> {
  const id: Record<string, string | number> = /^av\d+$/.test(item.sourceId) ? { aid: item.sourceId.slice(2) } : { bvid: item.sourceId };
  let view: Json;
  try { view = await api('/x/web-interface/view', id, false); }
  catch (error) { if (error instanceof SourceContentUnavailableError) return unavailableDetail(error); throw error; }
  if (!view.bvid || !view.cid) throw new Error('B站内容未提供有效视频标识，请稍后重试；已保留本地收藏');
  const referer = `https://www.bilibili.com/video/${view.bvid}`;
  const media: MediaDescriptor[] = [];
  if (typeof view.pic === 'string' && /^https?:\/\//.test(view.pic)) {
    const url = view.pic.replace(/^http:/, 'https:');
    const identity = mediaPathIdentity(url);
    media.push({ kind: 'image', remoteUrl: url, referer, role: 'cover', order: 0, title: '封面', sourceIdentity: identity, version: 'source-image', resourceKey: `bilibili:${item.sourceId}:cover:${shortIdentity(identity)}` });
  }
  const rawPages: Json[] = Array.isArray(view.pages) && view.pages.length ? view.pages : [{ cid: view.cid, page: 1 }];
  const pages = [...rawPages].sort((a, b) => Number(a.page) - Number(b.page));
  if (pages.some(page => !page.cid || !Number.isSafeInteger(Number(page.page)) || Number(page.page) < 1) || new Set(pages.map(page => String(page.cid))).size !== pages.length) throw new Error('B站分P清单格式异常，请重试');
  if (pages.some((page, index) => Number(page.page) !== index + 1) || (view.videos != null && (!Number.isSafeInteger(Number(view.videos)) || Number(view.videos) !== pages.length))) throw new Error('B站分P清单缺页或总数不一致，请重试；未将部分分P标为完整清单');
  const subtitles: string[] = [];
  const failures: string[] = [];
  let subtitleValid = true;
  let unsupported = false;
  for (const page of pages) {
    try {
      const play = await api('/x/player/playurl', { bvid: String(view.bvid), cid: String(page.cid), qn: 16, fnval: 0, fnver: 0, fourk: 0, platform: 'html5', type: 'mp4' }, false);
      const url = progressiveMp4(play, Number(page.duration) || (pages.length === 1 ? Number(view.duration) : 0));
      if (url) media.push(biliVideoDescriptor(item.sourceId, page, play, url, referer));
      else { unsupported = true; failures.push(`P${page.page} 平台未提供本轮支持的完整单文件 MP4（可能为DASH、分段或试看），可重试或查看原链接`); }
    } catch (error) {
      if (sanitizeSourceError(error).includes('LOGIN_REQUIRED')) throw error;
      failures.push(`P${page.page} 视频清单读取失败：${sanitizeSourceError(error)}`);
    }
    try {
      const player = await api('/x/player/wbi/v2', { bvid: String(view.bvid), cid: String(page.cid) });
      const available = player.subtitle?.subtitles;
      if (!Array.isArray(available)) { subtitleValid = false; continue; }
      if (!available.length) continue; // Explicitly valid empty result, unlike transport failure.
      const selected = available.find((sub: Json) => String(sub.lan).startsWith('zh')) ?? available[0];
      const url = String(selected.subtitle_url ?? '').replace(/^\/\//, 'https://');
      if (!/^https:\/\//.test(url)) { subtitleValid = false; continue; }
      const payload = await fetchJson(url);
      if (!Array.isArray(payload.body) || payload.body.some((line: Json) => typeof line.content !== 'string')) { subtitleValid = false; continue; }
      const lines = payload.body.map((line: Json) => String(line.content)).join('\n');
      if (lines) subtitles.push(pages.length > 1 ? `P${page.page} ${String(page.part ?? '')}\n${lines}` : lines);
    } catch { subtitleValid = false; }
  }
  return {
    body: typeof view.desc === 'string' ? view.desc : '', bodyComplete: typeof view.desc === 'string', bodyStatus: typeof view.desc === 'string' ? 'valid' : 'unavailable',
    subtitle: subtitleValid ? subtitles.join('\n\n') : undefined, subtitleStatus: subtitleValid ? 'valid' : 'unavailable',
    publishedAt: epochMillis(view.pubdate), media, mediaManifestComplete: failures.length === 0,
    manifestError: failures.length ? failures.join('；') : undefined,
    adapterVersion: SOURCE_ADAPTER_VERSION, availability: unsupported ? 'unsupported' : 'available',
  };
}
export function readXhsDetailResult(item: CollectionItem, result: Json): DetailResult {
  if (result.unavailable) return { ...unavailableDetail(new SourceContentUnavailableError(Number(result.unavailableCode) || 0)), manifestError: result.unavailableCode ? `小红书内容不可访问（${Number(result.unavailableCode)}），已保留本地收藏和文件` : '小红书页面明确提示笔记不存在，已保留本地收藏和文件' };
  if (!result.hasNote) throw new Error('小红书正文尚未加载，请稍后重试；已保留本地收藏');
  const media: MediaDescriptor[] = [];
  let videoUrl = String(result.videoUrl || '');
  if (!/^https?:\/\//.test(videoUrl)) videoUrl = currentXhsDomVideo(item.sourceId, String(result.pageUrl || ''), result.domVideos || []) || '';
  if (/^https?:\/\//.test(videoUrl) && !/\.(m3u8|m4s|ts)(?:[?#]|$)/i.test(videoUrl)) media.push(xhsVideoDescriptor(item.sourceId, videoUrl.replace(/^http:/, 'https:'), item.url, result.videoMetadata));
  for (const [index, image] of (result.images ?? []).entries()) media.push(xhsImageDescriptor(item.sourceId, image, index, item.url));
  const video = result.type === 'video';
  const complete = video ? media.some(resource => resource.kind === 'video') : Boolean(result.imageComplete && media.some(resource => resource.kind === 'image'));
  return {
    body: String(result.body ?? ''), bodyComplete: Boolean(result.hasSourceBody ?? result.hasBody), bodyStatus: (result.hasSourceBody ?? result.hasBody) ? 'valid' : 'unavailable',
    subtitleStatus: 'unavailable', publishedAt: epochMillis(result.time), media,
    mediaManifestComplete: complete, manifestError: complete ? undefined : video ? '视频清单尚未取得，请重试；封面不代表视频已保存' : '原图清单尚未完整取得，请重试',
    adapterVersion: SOURCE_ADAPTER_VERSION, availability: 'available',
  };
}

/** Shared extraction is restricted to this note; no global scripts or other notes' players. */
export function xhsDetailExtractScript(item: CollectionItem): string {
  return `(() => {
    const text = document.body?.innerText || '';
    const map = window.__INITIAL_STATE__?.note?.noteDetailMap || window.__INITIAL_STATE__?.note?.note || {};
    const entry = map[${JSON.stringify(item.sourceId)}]; const note = entry?.note || entry;
    const images = []; let imageComplete = Boolean(note && Array.isArray(note.imageList));
    if (imageComplete) for (const image of note.imageList) {
      const info = image.infoList?.find(value => value.imageScene === 'WB_DFT') || image.infoList?.[0];
      const url = image.urlDefault || image.urlPre || image.url || info?.url;
      const scene = image.urlDefault ? 'default' : image.urlPre ? 'preview' : image.url ? 'source' : String(info?.imageScene || 'unknown');
      if (typeof url === 'string' && /^https?:\\/\\//.test(url)) images.push({ url, identity: String(image.fileId || image.file_id || image.imageId || ''), width: image.width, height: image.height, scene, format: image.format || image.mimeType || info?.format || 'platform-default' }); else imageComplete = false;
    }
    if (!images.length) for (const image of document.querySelectorAll('.swiper-slide img,.note-slider img,.note-image img')) {
      if (/^https?:\\/\\//.test(image.src) && /xhscdn|xiaohongshu/.test(image.src) && !images.some(value => value.url === image.src)) images.push({ url: image.src });
    }
    const video = note?.video;
    const streams = video?.media?.stream;
    const stream = streams?.h264;
    let selected = null;
    let videoUrl = ''; 
    const playerRoot = document.querySelector('#noteContainer') || document.querySelector('.note-detail-mask .note-container') || document.querySelector('.note-detail-container');
    const domVideos = playerRoot ? Array.from(playerRoot.querySelectorAll('video')).filter(element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden';
    }).map(element => ({ durationSeconds: Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null, currentSrc: element.currentSrc || '', src: element.getAttribute('src') ? element.src : '', sources: Array.from(element.querySelectorAll('source[src]')).map(source => source.src || '') })) : [];
    const selectPlayableStream = ${selectXhsPlayableStream.toString()};
    const referenceSeconds = domVideos.length === 1 && domVideos[0].durationSeconds > 0 ? domVideos[0].durationSeconds : 0;
    selected = selectPlayableStream(streams, referenceSeconds, video?.media?.video?.drmType);
    videoUrl = selected?.masterUrl || video?.url || video?.consumer?.originVideoKey || video?.originVideoKey || '';
    if (videoUrl && !/^https?:\\/\\//.test(videoUrl)) videoUrl = 'https://sns-video-bd.xhscdn.com/' + videoUrl;
    const urlFacts = raw => {
      if (!raw || typeof raw !== 'string') return { scheme: 'empty', extension: 'none' };
      try { const url = new URL(raw); const ext = url.pathname.match(/\\.([a-z0-9]+)$/i)?.[1]?.toLowerCase(); return { scheme: url.protocol.replace(':', ''), extension: ['mp4','m3u8','m4s','ts','webm'].includes(ext) ? ext : ext ? 'other' : 'none' }; }
      catch { return { scheme: 'relative', extension: 'unknown' }; }
    };
    const allPlayers = playerRoot ? Array.from(playerRoot.querySelectorAll('video')).map(element => {
      const style = getComputedStyle(element);
      return { visible: element.getClientRects().length > 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden', readyState: element.readyState, networkState: element.networkState,
        currentSrc: urlFacts(element.currentSrc), src: urlFacts(element.getAttribute('src') ? element.src : ''), sources: Array.from(element.querySelectorAll('source[src]')).map(source => urlFacts(source.src)), durationSeconds: Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null };
    }) : [];
    const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const streamSummary = streams && typeof streams === 'object' ? Object.entries(streams).map(([key, group]) => {
      const first = Array.isArray(group) ? group[0] : null;
      const safeCodec = value => typeof value === 'string' && /^[a-z0-9._-]{1,32}$/i.test(value) ? value : typeof value === 'number' ? value : null;
      return { key, count: Array.isArray(group) ? group.length : null, keys: first && typeof first === 'object' ? Object.keys(first) : [], videoCodec: safeCodec(first?.videoCodec), audioCodec: safeCodec(first?.audioCodec), format: safeCodec(first?.format), qualityType: safeCodec(first?.qualityType), drmType: safeCodec(first?.drmType), width: finite(first?.width), height: finite(first?.height), duration: finite(first?.duration), videoDuration: finite(first?.videoDuration), audioDuration: finite(first?.audioDuration), masterUrl: urlFacts(first?.masterUrl) };
    }) : [];
    const diagnostics = { videoDrmType: finite(video?.media?.video?.drmType), streamSummary, noteKeys: note && typeof note === 'object' ? Object.keys(note) : [], videoKeys: video && typeof video === 'object' ? Object.keys(video) : [], mediaKeys: video?.media && typeof video.media === 'object' ? Object.keys(video.media) : [], mediaVideoKeys: video?.media?.video && typeof video.media.video === 'object' ? Object.keys(video.media.video) : [], streamKeys: video?.media?.stream && typeof video.media.stream === 'object' ? Object.keys(video.media.stream) : [], h264Count: Array.isArray(stream) ? stream.length : null, selectedStreamKeys: selected ? Object.keys(selected) : [], videoUrl: urlFacts(videoUrl), playerRoot: !!playerRoot, allPlayers,
      rawDurationFields: { video: finite(video?.duration), consumer: finite(video?.consumer?.videoDuration), mediaVideo: finite(video?.media?.video?.duration), selectedStream: finite(selected?.duration) } };
    const errorCode = Number(new URL(location.href).searchParams.get('error_code') || new URL(location.href).searchParams.get('code'));
    return {
      login: /登录后查看|请先登录|请登录后/.test(text),
      blocked: /安全限制|访问链接异常/.test(text) || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href),
      unavailable: errorCode === 62002 || /页面不见了|笔记不存在/.test(text), unavailableCode: errorCode || null,
      hasNote: Boolean(note || document.querySelector('#detail-title,#detail-desc')),
      body: typeof note?.desc === 'string' ? note.desc : document.querySelector('#detail-desc,.note-text,.note-content .desc')?.textContent || '',
      hasSourceBody: typeof note?.desc === 'string', time: note?.time, images, imageComplete, diagnostics,
      videoUrl, videoMetadata: { ...(selected || {}), videoId: video?.media?.videoId || video?.media?.video?.videoId || video?.videoId || '', durationSeconds: domVideos.length === 1 ? domVideos[0].durationSeconds : null }, domVideos, pageUrl: location.href, type: note?.type || ${JSON.stringify(item.kind === 'video' ? 'video' : 'normal')}
    };
  })()`;
}
