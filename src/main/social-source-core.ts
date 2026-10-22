import { createHash } from 'node:crypto';
import type { CollectionItem, CollectionOptions, CollectionSnapshot, DetailResult, MediaDescriptor, RecentScopeEvidence } from '../shared/contracts.js';
import { epochMillis, mergeFavorite, sanitizeSourceError } from './source-core.js';
import { recentLimit, requireSourceAccount } from './source-collection.js';

export type SocialPlatform = 'weibo' | 'zhihu';
type Json = Record<string, any>;
export interface SocialAccount { id: string; name: string; token?: string }
// E4.7: a mid-page rate limit ends the collect as partial — items already read
// are kept and the service cools the platform down. Auth failures still throw.
const RATE_LIMITED = /限流|访问受限|HTTP\s*(?:403|412|429)|rate.?limit|频繁|风控/i;
const AUTH_REQUIRED = /LOGIN_REQUIRED|ACCOUNT_CHANGED|登录失效|未登录/i;
function pageFailure(error: unknown): { message: string; limited: boolean } {
  const message = sanitizeSourceError(error);
  if (AUTH_REQUIRED.test(message)) throw error;
  return { message, limited: RATE_LIMITED.test(message) };
}
const safeId = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
export function socialText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => { const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''; })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, key: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key.toLowerCase()] ?? ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function date(value: unknown): number | null { const numeric = epochMillis(value); if (numeric) return numeric; const parsed = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
const flag = (value: unknown): boolean | null => value === true || value === 1 || value === '1' || value === 'true' ? true : value === false || value === 0 || value === '0' || value === 'false' ? false : null;
const object = (value: unknown): Json | undefined => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const weiboConfigs = (payload: Json): Json[] => [object(payload.data), object(payload.data?.config), object(payload.config), object(payload)].filter((value): value is Json => !!value);
const loginFlag = (value: Json): boolean | null => flag(value.islogin ?? value.isLogin ?? value.is_login);
/** Diagnostic output is structural only; never spread a source payload into evidence. */
export function socialIdentityEvidence(payload: Json): Record<string, unknown> {
  const keys = (value: unknown): string[] => object(value) ? Object.keys(value as Json).filter(key => /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(key)).slice(0, 60) : [];
  const configs = weiboConfigs(payload);
  return { keys: keys(payload), dataType: payload.data === null ? 'null' : Array.isArray(payload.data) ? 'array' : typeof payload.data,
    dataKeys: keys(payload.data), configKeys: keys(payload.data?.config ?? payload.config), okType: typeof payload.ok,
    uidTypes: configs.map(value => typeof value.uid), idPresent: configs.some(value => /^[1-9]\d*$/.test(safeId(value.uid))),
    isLogin: configs.map(loginFlag) };
}
export function socialAccount(platform: SocialPlatform, payload: Json): SocialAccount {
  if (platform === 'weibo') {
    const configs = weiboConfigs(payload);
    const candidates = configs.filter(config => /^[1-9]\d*$/.test(safeId(config.uid)));
    if (flag(payload.ok) === false || configs.some(config => loginFlag(config) === false) || !candidates.length || flag(payload.ok) !== true && !candidates.some(config => loginFlag(config) === true)) throw new Error('LOGIN_REQUIRED：微博当前页面尚未提供有效登录身份');
    const ids = [...new Set(candidates.map(config => safeId(config.uid)))];
    if (ids.length !== 1) throw new Error('ACCOUNT_CHANGED：微博身份响应中的账号不一致，已停止读取');
    const config = candidates[0]; const id = ids[0];
    return { id, name: String(config.screen_name ?? config.nick ?? config.name ?? id) };
  }
  const id = safeId(payload.id ?? payload.uid);
  const token = safeId(payload.url_token);
  if (!id || !token || payload.error || payload.is_anonymous === true) throw new Error('LOGIN_REQUIRED：知乎尚未登录，请在应用内完成登录');
  return { id, token, name: String(payload.name ?? token) };
}
export function verifyWeiboProfile(self: SocialAccount, payload: Json): SocialAccount {
  const user = payload.data?.user;
  const id = safeId(user?.idstr ?? user?.id);
  if (!id) throw new Error('LOGIN_REQUIRED：微博当前身份未获得平台确认');
  requireSourceAccount(id, self.id);
  return { id, name: typeof user?.screen_name === 'string' && user.screen_name.trim() ? user.screen_name : self.name };
}
export function weiboProfileEvidence(self: SocialAccount, payload: Json): Record<string, unknown> {
  const user = payload.data?.user;
  const raw = user?.idstr ?? user?.id;
  const id = safeId(raw);
  return { userType: typeof user, idType: typeof raw, idPresent: !!id, accountMatches: !!id && id === self.id };
}
export function safeWeiboPathname(pathname: string): string {
  const publicSegments = new Set(['u', 'page', 'fav', 'favorites', 'favorite', 'collect', 'collection', 'login', 'signin', 'passport', 'home', 'mygroups']);
  const parts = pathname.split('/').filter(Boolean);
  const masked = parts.slice(0, 12).map(part => {
    if (publicSegments.has(part)) return part;
    if (/^\d+$/.test(part)) return ':id';
    const kind = /^[A-Za-z]+$/.test(part) ? 'letters' : /^[A-Za-z0-9]+$/.test(part) ? 'alnum' : /^[A-Za-z0-9_-]+$/.test(part) ? 'token' : /%[0-9a-f]{2}/i.test(part) ? 'encoded' : 'other';
    return `:${kind}(${Math.min(part.length, 256)}${part.length > 256 ? '+' : ''})`;
  });
  if (parts.length > 12) masked.push(':more');
  return '/' + masked.join('/') + (parts.length && pathname.endsWith('/') ? '/' : '');
}
export function weiboRouteEvidence(pathname: string, expectedAccountId: string): Record<string, unknown> {
  const match = pathname.match(/^\/(?:u\/page\/fav|fav)\/(\d+)\/?$/);
  const pattern = match ? 'favorites-with-account' : /(?:^|\/)(?:fav|favorites|collect)(?:\/|$)/i.test(pathname) ? 'favorites-other'
    : /(?:^|\/)(?:login|signin|passport)(?:\/|$)/i.test(pathname) ? 'login'
      : /^\/(?:u\/)?\d+\/?$/.test(pathname) ? 'profile' : /^\/\d+\/[a-zA-Z0-9]+\/?$/.test(pathname) ? 'post' : pathname === '/' ? 'home' : 'other';
  return { pathnamePattern: pattern, pathnameTemplate: safeWeiboPathname(pathname), routeShape: match ? pathname.startsWith('/fav/') ? '/fav/:id' : '/u/page/fav/:id' : 'unrecognized', pathnameSegments: pathname.split('/').filter(Boolean).length, accountIdPresent: !!match, accountMatches: !!match && match[1] === expectedAccountId };
}

/** A preview title only: never apply card chrome cleanup to the source document or structured post text. */
export function weiboCardTitle(card: Json): string {
  const lines = socialText(card.body ?? card.text).split('\n').map(line => line.trim()).filter(Boolean);
  if (card.bodyFromCard === true) {
    const timestamp = /^(?:\d{2,4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}[-/月]\d{1,2}日?|今天|昨天|前天|刚刚|\d+\s*(?:秒|分钟|小时)前)(?:\s+\d{1,2}:\d{2})?$/;
    // The actual favorite card header has author, timestamp, then device attribution on separate lines.
    const hasHeader = lines.length >= 3 && lines[0].length <= 80 && timestamp.test(lines[1]) && /^来自\s*\S.{0,80}$/.test(lines[2]);
    if (hasHeader) {
      lines.splice(0, 3);
      while (lines.length && /^(?:关注|已关注|互相关注|已编辑|置顶|已置顶|精选)$/.test(lines[0])) lines.shift();
    }
  }
  return Array.from((lines[0] ?? '').replace(/\s+/g, ' ')).slice(0, 120).join('');
}

export function parseWeiboCard(card: Json): CollectionItem | null {
  let url: URL;
  try { url = new URL(String(card.url)); } catch { return null; }
  const match = url.pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)\/?$/);
  if (url.protocol !== 'https:' || !['weibo.com', 'www.weibo.com'].includes(url.hostname) || !match || url.username || url.password || url.port) return null;
  const title = weiboCardTitle(card);
  if (!title) return null;
  return { sourceId: match[2], title, author: String(card.author ?? ''), url: `https://weibo.com/${match[1]}/${match[2]}`,
    kind: card.video ? 'video' : card.image ? 'image' : 'text', collectedAt: null, publishedAt: null, folderIds: ['saved'] };
}
export interface WeiboVisiblePage { cards: Json[]; accountId: string; atTop: boolean; terminal: boolean; empty: boolean; blocked?: boolean; pathname?: string; scrollerCount?: number; visibleScrollerCount?: number; favoriteHeadingPresent?: boolean }
export async function readWeiboFavorites(options: CollectionOptions, io: { account(): Promise<SocialAccount>; first(account: SocialAccount): Promise<WeiboVisiblePage>; next(): Promise<WeiboVisiblePage> }): Promise<CollectionSnapshot> {
  if (options.fullHistory && options.recentLimit !== undefined) throw new Error('同步范围参数互斥');
  const limit = options.fullHistory ? 5000 : (recentLimit(options.recentLimit) ?? 100);
  const account = await io.account();
  requireSourceAccount(account.id, options.expectedAccountId);
  const items = new Map<string, CollectionItem>();
  const pages: RecentScopeEvidence['pages'] = [];
  let reliable = true; let terminal = false; let reason = '已读取收藏页连续头部'; let priorIds: string[] = []; let idle = 0;
  for (let index = 0; index < 300 && items.size < limit; index++) {
    const page = index === 0 ? await io.first(account) : await io.next();
    requireSourceAccount(page.accountId, account.id);
    if (page.blocked) throw new Error('微博访问受限，请在登录窗口完成平台验证后重试');
    if (index === 0 && !page.atTop) { reliable = false; reason = '收藏页未从头部开始，不能确认最近范围'; break; }
    const parsed = page.cards.map(parseWeiboCard);
    if (parsed.some(item => !item)) { reliable = false; reason = '部分收藏卡片缺少有效身份或正文，已保留可读取内容'; }
    const current = parsed.filter((item): item is CollectionItem => !!item);
    const ids = [...new Set(current.map(item => item.sourceId))];
    if (index > 0 && ids.length && priorIds.length && !ids.some(id => priorIds.includes(id))) { reliable = false; reason = '滚动收藏卡片之间缺少连续重叠，未声称最近范围完整'; break; }
    const before = items.size;
    for (const item of current) mergeFavorite(items, item);
    pages.push({ cursor: String(index), nextCursor: page.terminal ? null : String(index + 1), ids, parsed: parsed.every(Boolean) });
    if (ids.length) priorIds = ids;
    terminal = page.terminal && (items.size > 0 || page.empty);
    if (terminal) break;
    idle = before === items.size ? idle + 1 : 0;
    // A long post can occupy several viewports; lack of newly visible cards is not an end marker.
    if (idle >= 24) { reason = '收藏页未提供更多可读取卡片；当前结果为部分成功'; break; }
  }
  requireSourceAccount((await io.account()).id, account.id);
  const all = [...items.values()];
  const targetComplete = reliable && (terminal || all.length >= limit);
  if (!targetComplete && reason === '已读取收藏页连续头部') reason = '收藏页未到明确终点或目标数量，当前结果为部分成功';
  return { platform: 'weibo', accountId: account.id, accountName: account.name, folders: [{ id: 'saved', title: '微博收藏' }], items: all.slice(0, limit), complete: reliable && terminal && all.length <= limit,
    warning: targetComplete ? undefined : reason, target: { limit, complete: targetComplete, reliable, reason }, recent: { scopes: [{ scopeId: 'saved', reliable, orderedIds: all.map(item => item.sourceId), sort: 'collection-order', reason, pages }] } };
}

export function weiboFavoritePageNumber(raw: string): number | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['weibo.com', 'www.weibo.com'].includes(url.hostname) || url.username || url.password || url.port || url.pathname !== '/u/favorites' || url.hash) return null;
    if ([...url.searchParams.keys()].some(key => key !== 'page') || url.searchParams.getAll('page').length !== 1) return null;
    const page = url.searchParams.get('page')!;
    return /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page)) ? Number(page) : null;
  } catch { return null; }
}
export function weiboPageControlNumber(labels: unknown[]): number | null {
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const match = label.replace(/\s/g, '').match(/^第([1-9]\d*)页$/);
    if (match && Number.isSafeInteger(Number(match[1]))) return Number(match[1]);
  }
  return null;
}
export interface WeiboFavoriteSlot { key: string; card?: Json; unavailable: boolean }
export interface WeiboFavoritesPage {
  page: number; routePage: number | null; navigationAccountIds: string[]; pageSelfAccountId?: string; total: number | null;
  slots: WeiboFavoriteSlot[]; slotsReliable: boolean; paginationVerified: boolean;
  previousDisabled: boolean; nextPage: number | null; terminal: boolean; blocked: boolean;
}
export async function readWeiboFavoritePages(options: CollectionOptions, io: { account(): Promise<SocialAccount>; page(account: SocialAccount, page: number): Promise<WeiboFavoritesPage>; delay?(): Promise<void> }): Promise<CollectionSnapshot> {
  if (options.fullHistory && options.recentLimit !== undefined) throw new Error('同步范围参数互斥');
  const limit = options.fullHistory ? 5000 : (recentLimit(options.recentLimit) ?? 100);
  const account = await io.account(); requireSourceAccount(account.id, options.expectedAccountId);
  const items = new Map<string, CollectionItem>(); const pages: RecentScopeEvidence['pages'] = [];
  let current = 1; let declaredTotal: number | null = null; let unavailableSlots = 0; let unresolvedSlots = 0; let observedSlots = 0;
  let reliable = true; let terminal = false; let issue = ''; let limited: string | undefined;
  for (let attempt = 0; attempt < 100 && observedSlots < limit; attempt++) {
    let result: WeiboFavoritesPage;
    try { result = await io.page(account, current); }
    catch (error) { const failure = pageFailure(error); reliable = false; issue = failure.message; if (failure.limited) limited = failure.message; break; }
    if (result.blocked) { reliable = false; issue = '微博访问受限，请在登录窗口完成平台验证后重试'; limited = issue; break; }
    if (result.routePage !== current || result.page !== current) throw new Error('微博收藏分页路径与当前页码不一致，已停止读取');
    const selfLinks = [...new Set(result.navigationAccountIds)];
    if (selfLinks.length > 1) throw new Error('微博收藏页“我的主页”导航账号不唯一，已停止读取');
    if (selfLinks.length === 1) requireSourceAccount(selfLinks[0], account.id);
    if (result.pageSelfAccountId) requireSourceAccount(result.pageSelfAccountId, account.id);
    if (!result.pageSelfAccountId && !selfLinks.length) throw new Error('微博收藏页缺少当前 self 身份及“我的主页”导航核验，已停止读取');
    if (result.total === null || !Number.isSafeInteger(result.total) || result.total < 0) { reliable = false; issue = '页面收藏总数未能确认'; }
    else if (declaredTotal === null) declaredTotal = result.total;
    else if (declaredTotal !== result.total) { reliable = false; issue = '采集期间收藏总数发生变化'; }
    if (!result.slotsReliable || !result.paginationVerified || result.previousDisabled !== (current === 1)) { reliable = false; issue = '当前页槽位或分页状态尚未完整确认'; }
    const slotKeys = new Set<string>(); const ids: string[] = [];
    for (const slot of result.slots) {
      if (observedSlots >= limit) break;
      if (!slot.key || slotKeys.has(slot.key)) { reliable = false; issue = '当前页槽位标识重复或缺失'; continue; }
      slotKeys.add(slot.key); observedSlots++;
      if (slot.unavailable) { unavailableSlots++; continue; }
      const item = slot.card ? parseWeiboCard(slot.card) : null;
      if (!item) { unresolvedSlots++; reliable = false; issue = '部分可见槽位缺少可核验的原帖标识'; continue; }
      if (items.has(item.sourceId)) { reliable = false; issue = '相邻分页出现重复原帖，未确认最近范围'; continue; }
      items.set(item.sourceId, item); ids.push(item.sourceId);
    }
    pages.push({ cursor: String(current), nextCursor: result.nextPage === null ? null : String(result.nextPage), ids, parsed: result.slotsReliable && unresolvedSlots === 0 });
    terminal = result.terminal && result.nextPage === null && result.paginationVerified && slotKeys.size === result.slots.length;
    if (terminal || observedSlots >= limit) break;
    if (result.nextPage !== current + 1) { reliable = false; issue = '下一页链接不连续或尚未取得'; break; }
    current = result.nextPage; await io.delay?.();
  }
  requireSourceAccount((await io.account()).id, account.id);
  if (terminal && declaredTotal !== observedSlots) { reliable = false; issue = '可见槽位数量与页面收藏总数不一致，保留部分结果'; }
  const all = [...items.values()];
  const complete = reliable && (terminal || observedSlots >= limit);
  const summary = `平台显示 ${declaredTotal ?? '未知'} 条；已检查 ${observedSlots} 个槽位，可导入 ${all.length} 条，不可访问占位 ${unavailableSlots} 条，未识别 ${unresolvedSlots} 条`;
  const reason = summary + (issue ? `；${issue}` : terminal ? '；已逐页到达末页' : observedSlots >= limit ? '；已取得最近目标' : '；分页尚未结束');
  return { platform: 'weibo', accountId: account.id, accountName: account.name, folders: [{ id: 'saved', title: '微博收藏' }], items: all.slice(0, limit),
    complete: complete && terminal && all.length <= limit, warning: reason, target: { limit, complete, reliable, reason }, ...(limited ? { limited } : {}),
    recent: { scopes: [{ scopeId: 'saved', reliable, orderedIds: all.map(item => item.sourceId), sort: 'collection-order', reason, pages }] } };
}

export function mapZhihuFavorite(raw: Json, folderId: string): CollectionItem | null {
  const content = raw.content;
  if (!content || !['answer', 'article', 'pin'].includes(content.type)) return null;
  const id = safeId(content.id);
  if (!/^\d+$/.test(id)) return null;
  const type = content.type as 'answer' | 'article' | 'pin';
  const title = socialText(type === 'answer' ? content.question?.title : type === 'article' ? content.title : '知乎想法');
  const html = typeof content.content === 'string' ? content.content : '';
  const pinParts = type === 'pin' && Array.isArray(content.content) ? content.content : [];
  return { sourceId: `${type}:${id}`, title: title || '标题未取得', author: String(content.author?.name ?? '匿名用户'),
    url: type === 'article' ? `https://zhuanlan.zhihu.com/p/${id}` : `https://www.zhihu.com/${type === 'answer' ? 'answer' : 'pin'}/${id}`,
    kind: /<(?:video|iframe)\b|video-box|data-video-id/i.test(html) || pinParts.some((part: Json) => part.type === 'video') ? 'video' : /<img\b/i.test(html) || pinParts.some((part: Json) => part.type === 'image') ? 'image' : 'text',
    // Only the collection entry's explicit favorite time is admissible, never the content's publication time.
    collectedAt: date(raw.collected_time ?? raw.favorited_time ?? raw.created_time), publishedAt: date(content.created_time ?? content.created), folderIds: [folderId] };
}
export function nextZhihuOffset(payload: Json, offset: number, path: string): number | null {
  if (payload.paging?.is_end === true) return null;
  if (typeof payload.paging?.next !== 'string') throw new Error('知乎分页缺少明确后续游标，未将部分收藏记为完整');
  let next: URL;
  try { next = new URL(payload.paging.next); } catch { throw new Error('知乎分页游标格式异常'); }
  const raw = next.searchParams.get('offset');
  const value = Number(raw);
  if (next.protocol !== 'https:' || next.hostname !== 'www.zhihu.com' || next.pathname !== path || raw === null || !Number.isSafeInteger(value) || value <= offset) throw new Error('知乎分页游标不连续或来源不一致');
  return value;
}
export async function readZhihuFavorites(options: CollectionOptions, io: { account(): Promise<SocialAccount>; get(path: string): Promise<Json>; delay(): Promise<void> }): Promise<CollectionSnapshot> {
  if (options.fullHistory && options.recentLimit !== undefined) throw new Error('同步范围参数互斥');
  const limit = options.fullHistory ? 5000 : (recentLimit(options.recentLimit) ?? 100);
  const account = await io.account(); requireSourceAccount(account.id, options.expectedAccountId);
  if (!account.token) throw new Error('知乎账号标识未取得');
  const folders: { id: string; title: string }[] = [];
  const folderPath = `/api/v4/people/${encodeURIComponent(account.token)}/collections`;
  let offset = 0; let foldersComplete = false; let reason = ''; let reliable = true;
  for (let page = 0; page < 100; page++) {
    const payload = await io.get(`${folderPath}?include=data%5B*%5D.updated_time&offset=${offset}&limit=20`);
    if (!Array.isArray(payload.data)) throw new Error('知乎收藏夹返回格式异常');
    for (const folder of payload.data) {
      const id = safeId(folder.id);
      if (!/^\d+$/.test(id) || folders.some(existing => existing.id === id)) throw new Error('知乎收藏夹身份缺失或分页重复');
      folders.push({ id, title: socialText(folder.title) || '未命名收藏夹' });
    }
    const next = nextZhihuOffset(payload, offset, folderPath);
    if (next === null) { foldersComplete = true; break; }
    if (!payload.data.length) throw new Error('知乎收藏夹分页为空但未到终页');
    offset = next; await io.delay();
  }
  const all = new Map<string, CollectionItem>();
  const scopes: RecentScopeEvidence[] = [];
  let allEnded = foldersComplete; let limited: string | undefined;
  for (const folder of folders) {
    const path = `/api/v4/collections/${folder.id}/items`;
    const local = new Map<string, CollectionItem>(); const pages: RecentScopeEvidence['pages'] = [];
    let ended = false; let localReliable = true; offset = 0;
    for (let page = 0; page < 100 && local.size < limit; page++) {
      let payload: Json;
      try { payload = await io.get(`${path}?offset=${offset}&limit=20`); }
      catch (error) { const failure = pageFailure(error); localReliable = false; reason = failure.message; if (failure.limited) limited = failure.message; break; }
      if (!Array.isArray(payload.data)) throw new Error('知乎收藏内容返回格式异常');
      const mapped = payload.data.map((raw: Json) => mapZhihuFavorite(raw, folder.id));
      if (mapped.some((item: CollectionItem | null) => !item)) { localReliable = false; reason = '部分收藏内容类型尚不支持或标识缺失'; }
      const valid = mapped.filter((item: CollectionItem | null): item is CollectionItem => !!item) as CollectionItem[];
      if (valid.some(item => local.has(item.sourceId)) || new Set(valid.map(item => item.sourceId)).size !== valid.length) { localReliable = false; reason = '知乎收藏分页出现重复边界，最近范围尚未确认'; }
      for (const item of valid) { mergeFavorite(local, item); mergeFavorite(all, item); }
      let next: number | null;
      try { next = nextZhihuOffset(payload, offset, path); }
      catch { localReliable = false; reason = '知乎收藏分页缺少有效连续游标'; break; }
      pages.push({ cursor: String(offset), nextCursor: next === null ? null : String(next), ids: valid.map(item => item.sourceId), parsed: mapped.every(Boolean) });
      if (next === null) { ended = true; break; }
      if (!payload.data.length || !localReliable) break;
      offset = next; await io.delay();
    }
    allEnded &&= ended; reliable &&= localReliable;
    scopes.push({ scopeId: folder.id, reliable: localReliable, orderedIds: [...local.keys()], sort: 'collection-order', reason: localReliable ? '收藏夹连续头部' : reason, pages });
    await io.delay();
  }
  requireSourceAccount((await io.account()).id, account.id);
  const values = [...all.values()];
  const hasDates = values.every(item => item.collectedAt != null);
  const datedOrder = hasDates && scopes.every(scope => scope.orderedIds.every((id, index) => index === 0 || (all.get(scope.orderedIds[index - 1])?.collectedAt ?? 0) >= (all.get(id)?.collectedAt ?? 0)));
  const rankReliable = folders.length <= 1 || values.length <= limit && allEnded || datedOrder;
  if (hasDates) values.sort((a, b) => (b.collectedAt ?? 0) - (a.collectedAt ?? 0) || a.sourceId.localeCompare(b.sourceId));
  if (!foldersComplete) reason = '收藏夹列表未完整取得';
  else if (!rankReliable) reason = '逐夹近期内容已读取，但缺少可靠收藏时间，未确认全账号最近范围';
  else if (!reason) reason = allEnded ? '账号收藏已到终页' : '各收藏夹连续头部已取得';
  reliable &&= foldersComplete && rankReliable;
  const complete = reliable && (allEnded || values.length >= limit);
  return { platform: 'zhihu', accountId: account.id, accountName: account.name, folders, items: values.slice(0, limit), complete: reliable && allEnded && values.length <= limit,
    target: { limit, complete, reliable, reason }, warning: complete ? undefined : reason, ...(limited ? { limited } : {}), recent: { scopes } };
}

function mediaUrl(platform: SocialPlatform, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.replace(/^\/\//, 'https://').replace(/^http:/, 'https:'));
    const allowed = platform === 'weibo' ? /(^|\.)(sinaimg\.(cn|com)|weibocdn\.com|weibo\.(com|cn))$/i : /(^|\.)(zhimg\.com|zhihu\.com)$/i;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowed.test(url.hostname) ? url.toString() : null;
  } catch { return null; }
}
function descriptor(platform: SocialPlatform, sourceId: string, raw: unknown, kind: 'image' | 'video', index: number, referer: string, identity?: string): MediaDescriptor | null {
  const url = mediaUrl(platform, raw);
  if (!url || kind === 'video' && !/\.mp4$/i.test(new URL(url).pathname)) return null;
  const path = identity || new URL(url).pathname;
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 24);
  return { remoteUrl: url, kind, referer, sourceIdentity: path, version: 'source', role: kind === 'video' ? 'main' : 'image', order: index, title: kind === 'video' ? '原视频' : `图片 ${index + 1}`, resourceKey: `${platform}:${sourceId}:${kind}:${hash}`, ...(kind === 'video' ? { mime: 'video/mp4' } : {}) };
}
/** Safe structural evidence for real detail incompatibilities; never serialize identifiers, text or media URLs. */
export function weiboDetailEvidence(item: CollectionItem, status: Json): Record<string, unknown> {
  const keys = (value: unknown): string[] => object(value) ? Object.keys(value as Json).filter(key => /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(key)).slice(0, 60) : [];
  const present = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
  const parts = [status, object(status.retweeted_status)].filter((part): part is Json => !!part).map((part, index) => {
    const infos = object(part.pic_infos);
    const pics = Array.isArray(part.pics) ? part.pics : [];
    const candidates = [...(infos ? Object.values(infos) : []), ...pics].filter(value => !!object(value)) as Json[];
    const mix = object(part.mix_media_info);
    return { role: index ? 'retweet' : 'main', keys: keys(part), textRawPresent: present(part.text_raw), textHtmlPresent: present(part.text),
      picNum: Number.isSafeInteger(Number(part.pic_num)) && Number(part.pic_num) >= 0 ? Number(part.pic_num) : null,
      picIdsCount: Array.isArray(part.pic_ids) ? part.pic_ids.length : null, picsCount: Array.isArray(part.pics) ? part.pics.length : null,
      picInfosCount: infos ? Object.keys(infos).length : null,
      originalUrlEntries: candidates.filter(value => [value.largest?.url, value.original?.url, value.large?.url, value.url].some(present)).length,
      mixMediaKeys: keys(mix), mixItemCount: Array.isArray(mix?.items) ? mix.items.length : null,
      pageInfoKeys: keys(part.page_info), mediaInfoPresent: !!object(part.page_info?.media_info), pageTypeVideo: part.page_info?.type === 'video',
      fullTextPresent: present(part.__fullText), longTextFlag: !!(part.isLongText || part.is_long_text) };
  });
  return { requestedKind: item.kind, sourceIdentityMatches: [safeId(status.mblogid), safeId(status.idstr), safeId(status.id)].includes(item.sourceId),
    retweetType: status.retweeted_status === null ? 'null' : Array.isArray(status.retweeted_status) ? 'array' : typeof status.retweeted_status, parts };
}
export function readWeiboDetail(item: CollectionItem, status: Json): DetailResult {
  if (![safeId(status.mblogid), safeId(status.idstr), safeId(status.id)].includes(item.sourceId)) throw new Error('微博详情与收藏身份不一致');
  const media: MediaDescriptor[] = []; const failures: string[] = []; const bodies: string[] = []; let bodyComplete = true;
  for (const [partIndex, part] of [status, status.retweeted_status].filter(Boolean).entries()) {
    const body = typeof part.__fullText === 'string' ? part.__fullText : typeof part.text_raw === 'string' ? part.text_raw : typeof part.text === 'string' ? socialText(part.text) : null;
    const long = Boolean(part.isLongText || part.is_long_text);
    if (body === null || long && !part.__longTextComplete) bodyComplete = false;
    if (body !== null) bodies.push(`${partIndex ? `转发原文 · ${String(part.user?.screen_name ?? '')}\n` : ''}${body}`);
    const pics = Array.isArray(part.pic_ids) ? part.pic_ids : [];
    const fallback = Array.isArray(part.pics) ? part.pics : [];
    const images = pics.length ? pics.map((id: unknown) => ({ id: safeId(id), data: part.pic_infos?.[String(id)] })) : fallback.map((image: Json) => ({ id: safeId(image.pid), data: image }));
    for (const image of images) {
      const value = descriptor('weibo', item.sourceId, image.data?.largest?.url ?? image.data?.original?.url ?? image.data?.large?.url ?? image.data?.url, 'image', media.length, item.url, image.id || undefined);
      if (value) media.push(value); else failures.push('部分原图地址未取得');
    }
    if (Number(part.pic_num) > images.length) failures.push('图片清单数量不足');
    const info = part.page_info?.media_info;
    const video = !!info || String(part.page_info?.type) === 'video';
    if (video) {
      const candidates = [info?.stream_url_hd, info?.mp4_hd_url, info?.mp4_sd_url, info?.stream_url, ...(Array.isArray(info?.playback_list) ? info.playback_list.map((entry: Json) => entry.play_info?.url) : [])];
      const value = candidates.map(raw => descriptor('weibo', item.sourceId, raw, 'video', media.length, item.url)).find(Boolean);
      if (value) media.push(value); else failures.push('平台未提供可直接离线保存的 MP4，视频暂不支持');
    }
  }
  if (item.kind === 'image' && !media.some(entry => entry.kind === 'image')) failures.push('收藏中的图片尚未取得');
  if (item.kind === 'video' && !media.some(entry => entry.kind === 'video')) failures.push('收藏中的视频尚未取得');
  return { body: bodies.join('\n\n'), bodyComplete, bodyStatus: bodyComplete ? 'valid' : 'unavailable', media, mediaManifestComplete: !failures.length,
    manifestError: [...new Set(failures)].join('；') || undefined, availability: failures.some(value => value.includes('暂不支持')) ? 'unsupported' : 'available', publishedAt: date(status.created_at), adapterVersion: 1, subtitleStatus: 'unavailable' };
}

function attribute(tag: string, name: string): string | null { const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i')); return match ? socialText(match[2]) : null; }
export function readZhihuDetail(item: CollectionItem, payload: Json): DetailResult {
  const match = item.sourceId.match(/^(answer|article|pin):(\d+)$/);
  if (!match || safeId(payload.id) !== match[2]) throw new Error('知乎详情与收藏身份不一致');
  const type = match[1];
  const parts = type === 'pin' && Array.isArray(payload.content) ? payload.content : null;
  const html = typeof payload.content === 'string' ? payload.content : parts ? parts.filter((part: Json) => part.type === 'text').map((part: Json) => String(part.content ?? '')).join('\n') : null;
  if (html === null) throw new Error('知乎详情未返回完整正文');
  const media: MediaDescriptor[] = []; const failures: string[] = [];
  const urls: unknown[] = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const raw = attribute(tag, 'data-original') ?? attribute(tag, 'data-actualsrc') ?? attribute(tag, 'data-src') ?? attribute(tag, 'src');
    if (raw?.startsWith('data:') && attribute(tag, 'class')?.includes('Formula')) continue;
    urls.push(raw);
  }
  if (parts) for (const part of parts) {
    if (part.type === 'image') urls.push(part.original_url ?? part.url);
    if (!['image', 'text'].includes(String(part.type))) failures.push('想法包含当前暂不支持的媒体类型');
  }
  for (const raw of [...new Set(urls)]) { const value = descriptor('zhihu', item.sourceId, raw, 'image', media.length, item.url); if (value) media.push(value); else failures.push('部分正文图片未取得有效原图地址'); }
  const videoTags = html.match(/<video\b[\s\S]*?<\/video>/gi) ?? [];
  for (const tag of videoTags) {
    const candidates = [attribute(tag, 'src'), ...(tag.match(/<source\b[^>]*>/gi) ?? []).map(source => attribute(source, 'src'))];
    const value = candidates.map(raw => descriptor('zhihu', item.sourceId, raw, 'video', media.length, item.url)).find(Boolean);
    if (value) media.push(value); else failures.push('知乎内嵌视频没有可直接保存的 MP4，暂不支持');
  }
  if (/video-box|data-video-id|<iframe\b/i.test(html) || item.kind === 'video' && !media.some(entry => entry.kind === 'video')) failures.push('知乎内嵌视频暂不支持；正文与图片可独立保存');
  if (item.kind === 'image' && !media.some(entry => entry.kind === 'image')) failures.push('收藏中的图片尚未取得');
  const paid = payload.is_locked === true || payload.is_paid === true && payload.has_purchased !== true || payload.paid_info?.has_purchased === false;
  return { body: socialText(html), bodyComplete: !paid, bodyStatus: paid ? 'unavailable' : 'valid', media, mediaManifestComplete: !failures.length,
    manifestError: [...new Set(failures)].join('；') || undefined, availability: failures.some(value => value.includes('暂不支持')) ? 'unsupported' : 'available', publishedAt: date(payload.created_time ?? payload.created), adapterVersion: 1, subtitleStatus: 'unavailable' };
}
