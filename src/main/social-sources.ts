import { BrowserWindow, session, type Session } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CollectionItem, Connection, SourceAdapter } from '../shared/contracts.js';
import { sanitizeSourceError } from './source-core.js';
import { requireSourceAccount } from './source-collection.js';
import { SourceAccountVerificationCache } from './source-account-cache.js';
import { synchronizeSourceUserAgent } from './source-user-agent.js';
import { readWeiboDetail, readWeiboFavoritePages, readZhihuDetail, readZhihuFavorites, socialAccount, socialIdentityEvidence, socialText, verifyWeiboProfile, weiboDetailEvidence, weiboFavoritePageNumber, weiboPageControlNumber, weiboProfileEvidence, weiboRouteEvidence, type SocialAccount, type SocialPlatform, type WeiboVisiblePage, type WeiboFavoritesPage, type WeiboFavoriteSlot } from './social-source-core.js';

type Json = Record<string, any>;
const PLATFORMS: SocialPlatform[] = ['weibo', 'zhihu'];
const HOME: Record<SocialPlatform, string> = { weibo: 'https://weibo.com/', zhihu: 'https://www.zhihu.com/' };
const LOGIN: Record<SocialPlatform, string> = { weibo: 'https://weibo.com/login', zhihu: 'https://www.zhihu.com/signin' };
const LABEL: Record<SocialPlatform, string> = { weibo: '微博', zhihu: '知乎' };
const METHOD = '应用内独立消费者会话（只读）';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function socialEvidence(event: string, fields: Record<string, unknown>): void {
  if (!process.env.RLW_EVIDENCE_DIR) return;
  try { const directory = path.resolve(process.env.RLW_EVIDENCE_DIR); mkdirSync(directory, { recursive: true }); appendFileSync(path.join(directory, 'sources-social.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 }); }
  catch { /* Diagnostics never interrupt collection. Callers provide structural fields only. */ }
}
const allowed = (platform: SocialPlatform, raw: string): boolean => {
  try {
    const url = new URL(raw);
    const hosts = platform === 'weibo' ? ['weibo.com', 'weibo.cn', 'sina.com.cn'] : ['zhihu.com'];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
};

/** Consumers use injected Electron sessions; no Chrome credential copying or write APIs. */
export function createSocialSources(options: { sessionFor?: (platform: SocialPlatform) => Session; probeOnStart?: boolean } = {}): {
  adapters: SourceAdapter[]; login(platform: SocialPlatform): Promise<void>; connections(): Connection[]; dispose(): void;
} {
  let disposed = false;
  const sessions = new Map<SocialPlatform, Session>();
  const windows = new Set<BrowserWindow>();
  const loginWindows = new Map<SocialPlatform, BrowserWindow>();
  const loginTasks = new Map<SocialPlatform, Promise<void>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const collecting = new Set<SocialPlatform>();
  const accounts = new SourceAccountVerificationCache();
  const connections = new Map<SocialPlatform, Connection>(PLATFORMS.map(platform => [platform, { platform, state: 'disconnected', method: METHOD, message: `请在应用内完成${LABEL[platform]}登录` }]));
  const getSession = (platform: SocialPlatform): Session => {
    if (disposed) throw new Error('采集会话已关闭');
    let selected = sessions.get(platform);
    if (!selected) {
      selected = options.sessionFor?.(platform) ?? session.fromPartition(`persist:rlw-${platform}`);
      synchronizeSourceUserAgent(selected);
      accounts.watch(platform, selected.cookies); sessions.set(platform, selected);
    }
    return selected;
  };
  const setError = (platform: SocialPlatform, error: unknown) => {
    accounts.invalidate(platform);
    const message = sanitizeSourceError(error);
    connections.set(platform, { platform, state: message.includes('LOGIN_REQUIRED') ? 'expired' : 'error', method: METHOD, message });
  };
  function makeWindow(platform: SocialPlatform, show = false): BrowserWindow {
    if (disposed) throw new Error('采集会话已关闭');
    const sourceSession = getSession(platform);
    const win = new BrowserWindow({ width: 1120, height: 900, show, title: `${LABEL[platform]} · 应用内登录`, webPreferences: { session: sourceSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    windows.add(win);
    win.webContents.setUserAgent(sourceSession.getUserAgent());
    win.webContents.setWindowOpenHandler(({ url }) => { if (allowed(platform, url)) void win.loadURL(url).catch(() => undefined); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { if (!allowed(platform, url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!allowed(platform, url)) event.preventDefault(); });
    win.on('closed', () => { windows.delete(win); if (loginWindows.get(platform) === win) loginWindows.delete(platform); });
    return win;
  }
  async function navigate(win: BrowserWindow, url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); if (!win.webContents.isDestroyed()) win.webContents.removeListener('dom-ready', ready); win.removeListener('closed', closed); if (error) reject(error); else resolve(); };
      const ready = () => finish(); const closed = () => finish(new Error('平台窗口已关闭'));
      const timer = setTimeout(() => finish(new Error('平台页面加载超时')), 45_000); timer.unref();
      win.webContents.once('dom-ready', ready); win.once('closed', closed);
      try { void win.loadURL(url).catch(finish); } catch (error) { finish(error); }
    });
  }
  async function pageJson(win: BrowserWindow, platform: SocialPlatform, relative: string): Promise<Json> {
    if (!relative.startsWith('/') || relative.startsWith('//')) throw new Error('平台读取路径无效');
    const origin = HOME[platform];
    const result = await win.webContents.executeJavaScript(`(async () => {
      try {
        const response = await fetch(${JSON.stringify(new URL(relative, origin).toString())}, { credentials: 'include', method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        if (!response.ok) return { __socialHttpStatus: response.status };
        const raw = await response.text();
        try { return JSON.parse(raw, (key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^\\d+$/.test(context.source) ? context.source : value); }
        catch { return { __socialInvalidJson: true }; }
      } catch { return { __socialNetworkFailure: true }; }
    })()`) as Json;
    if (platform === 'weibo' && relative.startsWith('/ajax/config/get_config')) socialEvidence('weibo-config', { ...socialIdentityEvidence(result ?? {}), httpStatus: typeof result?.__socialHttpStatus === 'number' ? result.__socialHttpStatus : null, invalidJson: result?.__socialInvalidJson === true });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${LABEL[platform]}返回格式异常`);
    if (result.__socialHttpStatus === 401) throw new Error(`LOGIN_REQUIRED：${LABEL[platform]}登录失效`);
    if ([403, 412, 429].includes(result.__socialHttpStatus)) throw new Error(`${LABEL[platform]}访问受限或触发限流（HTTP ${result.__socialHttpStatus}），请在登录窗口检查后重试`);
    if (result.__socialHttpStatus) throw new Error(`${LABEL[platform]}读取失败（HTTP ${result.__socialHttpStatus}）`);
    if (result.__socialInvalidJson) throw new Error(`${LABEL[platform]}返回非 JSON 页面，可能需要登录或完成平台验证`);
    if (result.__socialNetworkFailure) throw new Error(`${LABEL[platform]}读取超时或网络不可用`);
    if (result.error || result.error_code) throw new Error(`${LABEL[platform]}拒绝读取该内容，请在平台页面确认权限后重试`);
    return result;
  }
  async function account(win: BrowserWindow, platform: SocialPlatform, refreshFallback = true): Promise<SocialAccount> {
    let result: SocialAccount;
    if (platform === 'zhihu') result = socialAccount(platform, await pageJson(win, platform, '/api/v4/me?include=url_token'));
    else {
      const payload = await pageJson(win, platform, '/ajax/config/get_config');
      try { result = socialAccount(platform, payload); }
      catch (error) {
        if (!sanitizeSourceError(error).includes('LOGIN_REQUIRED')) throw error;
        // OpenCLI's primary identity source is this current self-config. Reload
        // first so a store from before an external account change is not reused.
        if (refreshFallback) { await navigate(win, HOME.weibo); await wait(2200); }
        const config = await win.webContents.executeJavaScript(`(() => {
          const store = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store;
          const config = store?.state?.config?.config;
          return config ? { uid: config.uid, islogin: config.islogin, isLogin: config.isLogin, is_login: config.is_login, screen_name: config.screen_name, nick: config.nick, name: config.name } : {};
        })()`) as Json;
        const current = { ok: true, data: config };
        socialEvidence('weibo-page-self-config', socialIdentityEvidence(current));
        result = socialAccount(platform, current);
        const profile = await pageJson(win, platform, `/ajax/profile/info?uid=${encodeURIComponent(result.id)}`);
        socialEvidence('weibo-self-profile', { keys: Object.keys(profile).filter(key => /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(key)).slice(0, 60), ...weiboProfileEvidence(result, profile) });
        result = verifyWeiboProfile(result, profile);
      }
    }
    if (!disposed) connections.set(platform, { platform, state: 'connected', method: METHOD, accountName: result.name, verifiedAt: Date.now(), message: '应用内登录有效；同步只读取收藏与内容' });
    return result;
  }
  async function withWindow<T>(platform: SocialPlatform, operation: (win: BrowserWindow) => Promise<T>): Promise<T> {
    const win = makeWindow(platform);
    try { await navigate(win, HOME[platform]); await wait(1600); return await operation(win); }
    finally { if (!win.isDestroyed()) win.destroy(); }
  }
  async function weiboVisible(win: BrowserWindow, expectedId: string): Promise<WeiboVisiblePage> {
    const result = await win.webContents.executeJavaScript(`(() => {
      const match = location.pathname.match(/^\\/(?:u\\/page\\/fav|fav)\\/(\\d+)\\/?$/);
      const scrollers = [...document.querySelectorAll('.wbpro-scroller-item, .vue-recycle-scroller__item-view')];
      const candidates = scrollers
        .filter(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight; })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const cards = [];
      for (const element of candidates) {
        let component = element.__vueParentComponent; let source = null;
        for (let depth = 0; component && depth < 8; depth++, component = component.parent) {
          const props = component.props || {};
          const candidate = props.item?.mblog || props.item || props.data?.mblog || props.mblog;
          if (candidate?.mblogid && candidate?.user) { source = candidate; break; }
        }
        const links = [...element.querySelectorAll('a[href]')];
        const anchor = links.find(link => /^https:\\/\\/(?:www\\.)?weibo\\.com\\/\\d+\\/[a-zA-Z0-9]+(?:[?#]|$)/.test(link.href));
        const body = element.querySelector('.wbpro-feed-content,[class*="_content_"] [class*="_text_"],[class*="_body_"]') || element;
        if (!(body.innerText || '').trim()) continue;
        const author = element.querySelector('[class*="_name_"]') || links.find(link => /^https:\\/\\/(?:www\\.)?weibo\\.com\\/(?:u\\/)?\\d+(?:[?#]|$)/.test(link.href));
        const images = [...body.querySelectorAll('img')].some(image => /sinaimg/.test(image.src) && !/avatar|orj50|thumb50/.test(image.src));
        const sourceUrl = source?.mblogid && (source.user?.idstr || source.user?.id) ? 'https://weibo.com/' + String(source.user.idstr || source.user.id) + '/' + source.mblogid : '';
        cards.push({ url: anchor?.href || sourceUrl, body: source?.text_raw || body.innerText || '', author: source?.user?.screen_name || author?.textContent?.trim() || '', image: images || Number(source?.pic_num) > 0, video: !!source?.page_info?.media_info || source?.page_info?.type === 'video' || !!element.querySelector('video,[class*="video-box"],[class*="VideoPlayer"]') });
      }
      const text = document.body?.innerText || '';
      const terminal = [...document.querySelectorAll('.wbpro-empty,[class*="empty"],[class*="bottom"],[class*="loading"]')].some(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.top < innerHeight && /^(?:没有更多了|没有更多内容|暂无收藏|暂无收藏内容|还没有收藏)(?:[。！!\\s]*)$/.test((element.textContent || '').trim()); });
      const favoriteHeadingPresent = [...document.querySelectorAll('h1,h2,[role="heading"],[class*="title"]')].some(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && /^(?:我的)?收藏$/.test((element.textContent || '').trim()); });
      return { cards, accountId: match?.[1] || '', pathname: location.pathname, scrollerCount: scrollers.length, visibleScrollerCount: candidates.length, favoriteHeadingPresent, atTop: window.scrollY < 5 && (document.scrollingElement?.scrollTop || 0) < 5, terminal, empty: terminal && !cards.length && /暂无收藏|还没有收藏/.test(text), blocked: /访问频次过高|访问异常|请输入验证码|安全验证/.test(text) };
    })()`) as WeiboVisiblePage;
    socialEvidence('weibo-favorites-view', { ...weiboRouteEvidence(result.pathname ?? '', expectedId), scrollerCount: result.scrollerCount ?? null, visibleScrollerCount: result.visibleScrollerCount ?? null, cardCount: result.cards.length, atTop: result.atTop, terminal: result.terminal, empty: result.empty, blocked: result.blocked === true, favoriteHeadingPresent: result.favoriteHeadingPresent === true });
    if (!result.accountId) throw new Error('微博收藏页路径尚未识别，未确认当前收藏账号；本次停止读取');
    requireSourceAccount(result.accountId, expectedId);
    return result;
  }
  async function weiboFavoritesPage(win: BrowserWindow, expectedId: string, page: number): Promise<WeiboFavoritesPage> {
    await navigate(win, `https://weibo.com/u/favorites?page=${page}`); await wait(1800);
    const slots = new Map<string, WeiboFavoriteSlot & { position: number | null }>();
    let reliable = true;
    let last: Json = {};
    for (let pass = 0; pass < 45; pass++) {
      last = await win.webContents.executeJavaScript(`(() => {
        const parsePage = ${weiboFavoritePageNumber.toString()};
        const controlPage = ${weiboPageControlNumber.toString()};
        const text = document.body?.innerText || '';
        const routePage = parsePage(location.href);
        const labels = element => [element.getAttribute('aria-label'), element.getAttribute('aria-description'), element.getAttribute('title'), element.innerText, element.textContent].filter(value => typeof value === 'string' && value.trim());
        const selfNavigation = [...document.querySelectorAll('a[href]')].filter(link => !link.closest('.wbpro-scroller-item,.vue-recycle-scroller__item-view') && labels(link).some(value => /我的主页$/.test(value.replace(/\\s/g, ''))));
        const navigationAccountIds = selfNavigation.map(link => {
          try { const url = new URL(link.href); return url.protocol === 'https:' && ['weibo.com','www.weibo.com'].includes(url.hostname) ? url.pathname.match(/^\\/u\\/(\\d+)\\/?$/)?.[1] || '' : ''; } catch { return ''; }
        }).filter(Boolean);
        const selfConfig = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store?.state?.config?.config;
        const selfUid = selfConfig?.uid;
        const pageSelfAccountId = (typeof selfUid === 'string' || Number.isSafeInteger(selfUid)) && /^[1-9]\\d*$/.test(String(selfUid)) && ![false,0,'0','false'].includes(selfConfig?.islogin ?? selfConfig?.isLogin ?? selfConfig?.is_login) ? String(selfUid) : '';
        const totalMatch = text.match(/我的收藏\\s*[（(]\\s*(\\d+)\\s*[）)]/);
        const selectors = '.wbpro-scroller-item, .vue-recycle-scroller__item-view';
        const elements = [...document.querySelectorAll(selectors)].filter(element => !element.parentElement?.closest(selectors));
        const virtual = !!document.querySelector('.vue-recycle-scroller');
        const extracted = [];
        for (let index = 0; index < elements.length; index++) {
          const element = elements[index];
          if (!element.getClientRects().length || !element.innerText?.trim()) continue;
          let component = element.__vueParentComponent; let source = null; let position = null;
          const rawIndex = element.getAttribute('data-index');
          if (rawIndex !== null && /^\\d+$/.test(rawIndex)) position = Number(rawIndex);
          for (let depth = 0; component && depth < 8; depth++, component = component.parent) {
            const props = component.props || {};
            const candidate = props.item?.mblog || props.item || props.data?.mblog || props.mblog;
            if (!source && candidate && (candidate.mblogid || candidate.idstr) && candidate.user) source = candidate;
            if (position === null && Number.isSafeInteger(props.index) && props.index >= 0 && (props.item || props.data)) position = props.index;
          }
          const links = [...element.querySelectorAll('a[href]')];
          const anchor = links.find(link => /^https:\\/\\/(?:www\\.)?weibo\\.com\\/\\d+\\/[a-zA-Z0-9]+(?:[?#]|$)/.test(link.href));
          const textBody = element.querySelector('.wbpro-feed-content [class*="_text_"],[class*="_content_"] [class*="_text_"]');
          const body = textBody || element.querySelector('.wbpro-feed-content,[class*="_body_"],.wbpro-item-body') || element;
          const structuredText = typeof source?.text_raw === 'string' && source.text_raw.trim() ? source.text_raw : typeof source?.text === 'string' && source.text.trim() ? source.text : '';
          const bodyText = structuredText || body.innerText || '';
          const unavailable = !source && !anchor && /微博已被删除|此微博已被作者删除|该微博已被删除|微博已删除|账号.*(?:封禁|被封|注销|违反|异常)|内容.*(?:已被删除|暂时无法查看|已被屏蔽)/.test(element.innerText || '');
          const sourceUrl = source?.mblogid && (source.user?.idstr || source.user?.id) ? 'https://weibo.com/' + String(source.user.idstr || source.user.id) + '/' + source.mblogid : '';
          const url = anchor?.href || sourceUrl;
          const sourceKey = source?.mblogid || source?.idstr || url.match(/weibo\\.com\\/\\d+\\/([a-zA-Z0-9]+)/)?.[1];
          const key = position !== null ? 'position:' + position : sourceKey ? 'post:' + sourceKey : 'dom:' + index;
          const author = element.querySelector('[class*="_name_"]');
          extracted.push({ key, position: position ?? (virtual ? null : index), stable: position !== null || !!sourceKey || !virtual, unavailable,
            card: { url, body: bodyText, bodyFromCard: !structuredText && !textBody, author: source?.user?.screen_name || author?.textContent?.trim() || '', image: Number(source?.pic_num) > 0 || [...body.querySelectorAll('img')].some(image => /sinaimg/.test(image.src) && !/avatar|orj50|thumb50/.test(image.src)), video: !!source?.page_info?.media_info || source?.page_info?.type === 'video' || !!element.querySelector('video,[class*="video-box"],[class*="VideoPlayer"]') } });
        }
        const pager = document.querySelector('[aria-label="收藏列表分页"]') || [...document.querySelectorAll('nav,[role="navigation"],[class*="pagination"],[class*="Pagination"]')].find(element => /上一页/.test(element.innerText || '') && /下一页/.test(element.innerText || ''));
        const controls = pager ? [...pager.querySelectorAll('a,button,[role="button"]')] : [];
        const label = element => labels(element).join(' ');
        const previous = controls.find(element => /上一页/.test(label(element)));
        const next = controls.find(element => /下一页/.test(label(element)));
        const disabled = element => !!element && (element.disabled || element.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(element.className)) || element.parentElement?.getAttribute('aria-disabled') === 'true');
        const active = controls.find(element => element.getAttribute('aria-current') === 'page' || /(?:active|current)/.test(String(element.className)));
        const currentPage = active ? (controlPage(labels(active)) ?? (Number(label(active).match(/(?:第)?\\s*(\\d+)\\s*(?:页)?/)?.[1]) || null)) : routePage;
        const nextHref = next?.getAttribute('href');
        let nextPage = nextHref ? parsePage(new URL(nextHref, location.href).toString()) : null;
        if (next && !disabled(next) && nextPage === null) nextPage = controls.map(element => { const href = element.getAttribute('href'); return href ? parsePage(new URL(href, location.href).toString()) : null; }).find(value => value === ${page + 1}) ?? null;
        if (next && !disabled(next) && nextPage === null && controls.some(element => !disabled(element) && controlPage(labels(element)) === ${page + 1})) nextPage = ${page + 1};
        const rect = pager?.getBoundingClientRect();
        return { routePage, navigationAccountIds, pageSelfAccountId, selfNavigationLabelCount: selfNavigation.length, total: totalMatch ? Number(totalMatch[1]) : null, slots: extracted, currentPage,
          paginationVerified: !!previous && !!next && currentPage === routePage, previousDisabled: !!disabled(previous), nextPage: next && disabled(next) ? null : nextPage,
          terminal: !!next && !!disabled(next), footerVisible: !!rect && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0,
          blocked: /访问频次过高|访问异常|请输入验证码|安全验证/.test(text), empty: /暂无收藏|还没有收藏/.test(text) };
      })()`) as Json;
      if (last.routePage !== page) break;
      for (const slot of last.slots ?? []) {
        if (!slot.stable) reliable = false;
        const previous = slots.get(slot.key);
        if (previous && previous.unavailable !== slot.unavailable) reliable = false;
        slots.set(slot.key, { key: slot.key, card: slot.card, unavailable: slot.unavailable, position: slot.position });
      }
      if (last.blocked || last.footerVisible || last.empty && last.terminal) break;
      await win.webContents.executeJavaScript('window.scrollBy(0, Math.min(600, innerHeight * 0.7))'); await wait(450);
    }
    const result: WeiboFavoritesPage = { page, routePage: last.routePage ?? null, navigationAccountIds: last.navigationAccountIds ?? [], pageSelfAccountId: last.pageSelfAccountId || undefined, total: last.total ?? null,
      slots: [...slots.values()].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)), slotsReliable: reliable && !!last.footerVisible,
      paginationVerified: !!last.paginationVerified, previousDisabled: !!last.previousDisabled, nextPage: last.nextPage ?? null, terminal: !!last.terminal, blocked: !!last.blocked };
    socialEvidence('weibo-favorites-page', { requestedPage: page, routeMatches: result.routePage === page, navigationAccountCount: new Set(result.navigationAccountIds).size, navigationAccountMatches: result.navigationAccountIds.length > 0 && result.navigationAccountIds.every(id => id === expectedId), selfNavigationLabelCount: last.selfNavigationLabelCount ?? 0, pageSelfIdPresent: !!result.pageSelfAccountId, pageSelfAccountMatches: !!result.pageSelfAccountId && result.pageSelfAccountId === expectedId, total: result.total, observedSlots: result.slots.length, unavailableSlots: result.slots.filter(slot => slot.unavailable).length, slotsReliable: result.slotsReliable, paginationVerified: result.paginationVerified, previousDisabled: result.previousDisabled, nextPage: result.nextPage, terminal: result.terminal, blocked: result.blocked });
    return result;
  }
  async function detailWeibo(win: BrowserWindow, item: CollectionItem): Promise<ReturnType<typeof readWeiboDetail>> {
    if (!/^[A-Za-z0-9]+$/.test(item.sourceId)) throw new Error('微博收藏标识无效');
    const status = await pageJson(win, 'weibo', `/ajax/statuses/show?id=${encodeURIComponent(item.sourceId)}`);
    for (const part of [status, status.retweeted_status].filter(Boolean)) {
      if (!part.isLongText && !part.is_long_text) continue;
      const id = String(part.idstr ?? (typeof part.id === 'string' || Number.isSafeInteger(part.id) ? part.id : ''));
      if (!/^\d+$/.test(id)) continue;
      try {
        const full = await pageJson(win, 'weibo', `/ajax/statuses/longtext?id=${id}`);
        if (typeof full.data?.longTextContent === 'string') { part.__fullText = socialText(full.data.longTextContent); part.__longTextComplete = true; }
      } catch (error) {
        if (/LOGIN_REQUIRED|访问受限|限流/.test(sanitizeSourceError(error))) throw error;
      }
    }
    socialEvidence('weibo-detail-shape', weiboDetailEvidence(item, status));
    return readWeiboDetail(item, status);
  }
  const adapters: SourceAdapter[] = PLATFORMS.map(platform => ({
    platform,
    async collect(options = {}) {
      if (collecting.has(platform)) throw new Error('该来源正在同步，请等待');
      collecting.add(platform);
      try {
        return await withWindow(platform, async win => {
          if (platform === 'zhihu') return readZhihuFavorites(options, { account: () => account(win, platform), get: path => pageJson(win, platform, path), delay: () => wait(options.fullHistory ? 1000 : 350) });
          return readWeiboFavoritePages(options, { account: () => account(win, platform), page: (current, page) => weiboFavoritesPage(win, current.id, page), delay: options.fullHistory ? () => wait(1000) : undefined });
        });
      } catch (error) { setError(platform, error); throw new Error(sanitizeSourceError(error)); }
      finally { collecting.delete(platform); }
    },
    async detail(item, options) {
      try {
        return await withWindow(platform, async win => {
          const before = await account(win, platform); requireSourceAccount(before.id, options?.expectedAccountId);
          let result;
          if (platform === 'weibo') result = await detailWeibo(win, item);
          else {
            const match = item.sourceId.match(/^(answer|article|pin):(\d+)$/);
            if (!match) throw new Error('知乎收藏标识无效');
            const plural = { answer: 'answers', article: 'articles', pin: 'pins' }[match[1]];
            const include = 'content,author,created_time,updated_time,question';
            result = readZhihuDetail(item, await pageJson(win, platform, `/api/v4/${plural}/${match[2]}?include=${encodeURIComponent(include)}`));
          }
          requireSourceAccount((await account(win, platform)).id, before.id);
          return result;
        });
      } catch (error) { setError(platform, error); throw new Error(sanitizeSourceError(error)); }
    },
    async verifyAccount(expectedAccountId) {
      getSession(platform);
      try { await accounts.verify(platform, expectedAccountId, beginInspection => withWindow(platform, async win => { beginInspection(); return (await account(win, platform)).id; })); }
      catch (error) { setError(platform, error); throw new Error(sanitizeSourceError(error)); }
    },
  }));
  if (options.probeOnStart && process.env.RLW_BLOCK_NETWORK !== '1') queueMicrotask(() => {
    if (disposed) return;
    for (const platform of PLATFORMS) void withWindow(platform, win => account(win, platform)).catch(error => { if (!disposed) setError(platform, error); });
  });
  return {
    adapters,
    async login(platform) {
      if (!PLATFORMS.includes(platform)) throw new Error('不支持的平台');
      accounts.invalidate(platform);
      const existing = loginWindows.get(platform);
      if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return loginTasks.get(platform); }
      const win = makeWindow(platform, true); loginWindows.set(platform, win);
      let verified = false; let checking = false; let timer: ReturnType<typeof setInterval> | undefined;
      const task = new Promise<void>((resolve, reject) => {
        win.once('closed', () => { if (timer) { clearInterval(timer); intervals.delete(timer); } loginTasks.delete(platform); if (verified) resolve(); else reject(new Error('登录已取消；关闭窗口不等于登录成功')); });
        void navigate(win, LOGIN[platform]).then(() => {
          if (win.isDestroyed()) return;
          timer = setInterval(() => {
            if (checking || win.isDestroyed()) return;
            checking = true;
            void account(win, platform, false).then(() => { verified = true; if (!win.isDestroyed()) win.close(); }).catch(() => undefined).finally(() => { checking = false; });
          }, 3500); intervals.add(timer);
        }).catch(error => { reject(new Error(sanitizeSourceError(error))); if (!win.isDestroyed()) win.close(); });
      });
      loginTasks.set(platform, task); return task;
    },
    connections: () => [...connections.values()].map(value => ({ ...value })),
    dispose() { disposed = true; accounts.dispose(); for (const timer of intervals) clearInterval(timer); intervals.clear(); for (const win of windows) if (!win.isDestroyed()) win.destroy(); windows.clear(); sessions.clear(); },
  };
}
