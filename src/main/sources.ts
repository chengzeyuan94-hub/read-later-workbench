import { BrowserWindow, session, type Session } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CollectionItem, CollectionSnapshot, Connection, DetailResult, Platform, SourceAdapter, CollectionOptions } from '../shared/contracts.js';
import { assembleXhsCollection, biliRecentScope, xhsCollectionRequest, xhsProfileTabScript, recentLimit, readBiliFavorites, requireSourceAccount, type XhsCollectionCapture } from './source-collection.js';
import { mapBilibiliFavorite, mapXhsFavorite, mergeFavorite, signWbi, sanitizeSourceError, connectionAfterDetailFailure } from './source-core.js';

import { readBiliDetail, readXhsDetailResult, SourceContentUnavailableError, xhsDetailExtractScript } from './source-detail.js';
import { SourceAccountVerificationCache } from './source-account-cache.js';

type Json = Record<string, any>;
const METHOD = '应用内独立 Electron 消费者会话（只读）';
import { PLATFORM_HOME as HOME } from '../shared/platforms.js';
const DOMAIN: Record<string, string> = { xiaohongshu: 'xiaohongshu.com', bilibili: 'bilibili.com' };
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const message = sanitizeSourceError;
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
function sourceEvidence(event: string, fields: Record<string, unknown>): void {
  if (!process.env.RLW_EVIDENCE_DIR) return;
  try {
    const directory = path.resolve(process.env.RLW_EVIDENCE_DIR);
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, 'sources.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields }) + '\n');
  } catch { /* Diagnostics must never interrupt collection or expose raw exceptions. */ }
}
function cursorEvidence(value: unknown): Record<string, unknown> {
  return value == null ? { state: 'missing' } : String(value) === '' ? { state: 'empty', length: 0 } : { state: 'present', length: String(value).length, hash: digest(String(value)) };
}
function responseEvidence(payload: Json): Record<string, unknown> {
  const data = payload?.data;
  const notes = data?.notes ?? data?.note_list;
  return { payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [], success: payload?.success, code: typeof payload?.code === 'number' ? payload.code : undefined,
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [], notesCount: Array.isArray(notes) ? notes.length : null,
    pagination: { hasMore: typeof (data?.has_more ?? data?.hasMore) === 'boolean' || typeof (data?.has_more ?? data?.hasMore) === 'number' ? (data?.has_more ?? data?.hasMore) : 'unknown', cursor: cursorEvidence(data?.cursor), nextCursor: cursorEvidence(data?.next_cursor ?? data?.nextCursor) } };
}

const allowed = (platform: Platform, url: string): boolean => {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && (parsed.hostname === DOMAIN[platform] || parsed.hostname.endsWith(`.${DOMAIN[platform]}`)); }
  catch { return false; }
};
const loginError = (platform: Platform) => new Error(`LOGIN_REQUIRED：${platform === 'bilibili' ? 'B站' : '小红书'}未登录或登录已失效，请在设置中重新进行应用内登录`);

/** Private partitions live under this application's userData, never Chrome/legacy workbench. */
export function createSources(options: { sessionFor?: (platform: Platform) => Session; probeOnStart?: boolean } = {}): { adapters: SourceAdapter[]; login(platform: Platform): Promise<void>; connections(): Connection[]; dispose(): void } {
  const state = new Map<Platform, Connection>(['xiaohongshu', 'bilibili'].map(value => {
    const platform = value as Platform;
    return [platform, { platform, state: 'disconnected', message: '请在应用内完成平台登录', method: METHOD }];
  }));
  const windows = new Set<BrowserWindow>();
  const loginWindows = new Map<Platform, BrowserWindow>();
  const loginTasks = new Map<Platform, Promise<void>>();
  const collecting = new Set<Platform>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const sourceSessions = new Map<Platform, Session>();
  const accountVerification = new SourceAccountVerificationCache();
  let disposed = false;
  const getSession = (platform: Platform): Session => {
    if (disposed) throw new Error('采集会话已关闭');
    let selected = sourceSessions.get(platform);
    if (!selected) {
      selected = options.sessionFor?.(platform) ?? session.fromPartition(`persist:rlw-${platform}`);
      accountVerification.watch(platform, selected.cookies);
      sourceSessions.set(platform, selected);
    }
    return selected;
  };
  const setConnected = (platform: Platform, accountName: string) => state.set(platform, { platform, state: 'connected', accountName, method: METHOD, message: '应用内登录有效；同步只读取收藏与内容', verifiedAt: Date.now() });
  const setError = (platform: Platform, error: unknown) => state.set(platform, { platform, state: message(error).includes('LOGIN_REQUIRED') ? 'expired' : 'error', method: METHOD, message: message(error) });
  function makeWindow(platform: Platform, visible = false): BrowserWindow {
    if (disposed) throw new Error('采集会话已关闭');
    const win = new BrowserWindow({
      width: 1100, height: 820, show: visible, title: `${platform === 'bilibili' ? 'B站' : '小红书'} · 应用内登录`,
      webPreferences: { session: getSession(platform), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    windows.add(win);
    // Consumer pages should receive a normal browser UA, not an Electron-branded UA.
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(/\sread-later-workbench\/\S+/g, ''));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (allowed(platform, url)) void win.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => { if (!allowed(platform, url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!allowed(platform, url)) event.preventDefault(); });
    win.on('closed', () => { windows.delete(win); if (loginWindows.get(platform) === win) loginWindows.delete(platform); });
    return win;
  }
  async function navigate(win: BrowserWindow, url: string): Promise<void> {
    // A platform's remote images/video can keep the full load event pending.
    // DOM readiness plus the caller's hydration wait is sufficient for read-only extraction.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!win.webContents.isDestroyed()) win.webContents.removeListener('dom-ready', onReady);
        win.removeListener('closed', onClosed);
        if (error) reject(error); else resolve();
      };
      const onReady = () => finish();
      const onClosed = () => finish(new Error('平台采集窗口已关闭，请重试'));
      const timer = setTimeout(() => finish(new Error('平台页面加载超时，请检查网络后重试')), 45000);
      timer.unref();
      win.webContents.once('dom-ready', onReady);
      win.once('closed', onClosed);
      // Keep a rejection handler after DOM readiness; never leave loadURL rejection unhandled.
      try { void win.loadURL(url).catch(error => finish(error)); }
      catch (error) { finish(error); }
    });
  }
  async function waitForXhsDetail(win: BrowserWindow, sourceId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (win.isDestroyed()) throw new Error('平台采集窗口已关闭，请重试');
      const ready = await win.webContents.executeJavaScript(`(() => {
        const map = window.__INITIAL_STATE__?.note?.noteDetailMap || window.__INITIAL_STATE__?.note?.note || {};
        const entry = map[${JSON.stringify(sourceId)}];
        const note = entry?.note || entry;
        if (note && typeof note.desc === 'string') return true;
        const text = document.body?.innerText || '';
        return /登录后查看|请先登录|请登录后|安全限制|访问链接异常|页面不见了|笔记不存在|无法浏览/.test(text)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href);
      })()`) as boolean;
      if (ready) return;
      await wait(500);
    }
  }
  async function jsonFetch(platform: Platform, url: string): Promise<Json> {
    const response = await getSession(platform).fetch(url, { credentials: 'include', headers: { Referer: HOME[platform] }, signal: AbortSignal.timeout(30000) });
    if (response.status === 401) throw loginError(platform);
    if (response.status === 403 || response.status === 412 || response.status === 429) throw new Error(`平台限流或访问受限（HTTP ${response.status}），请稍后重试`);
    if (!response.ok) throw new Error(`平台请求失败（HTTP ${response.status}）`);
    try { return await response.json() as Json; }
    catch { throw new Error('平台返回了非 JSON 数据，可能遇到登录或风控页面'); }
  }
  async function biliNav(): Promise<Json> {
    const nav = await jsonFetch('bilibili', 'https://api.bilibili.com/x/web-interface/nav');
    if (nav.code !== 0 || !nav.data?.isLogin || !nav.data?.mid) throw loginError('bilibili');
    setConnected('bilibili', String(nav.data.uname || nav.data.mid));
    return nav.data;
  }
  function requireBili(payload: Json, label: string): Json {
    if (payload.code === -101 || payload.code === -111) throw loginError('bilibili');
    if (payload.code === 62002 || payload.code === -404) throw new SourceContentUnavailableError(Number(payload.code));
    if (payload.code !== 0) throw new Error(`B站${label}失败（${Number(payload.code) || '未知错误'}），请稍后重试`);
    if (!payload.data || typeof payload.data !== 'object') throw new Error(`B站${label}返回格式异常`);
    return payload.data as Json;
  }
  async function biliApi(path: string, params: Record<string, string | number>, nav: Json, signed = true): Promise<Json> {
    const key = (url: unknown) => String(url ?? '').split('/').pop()?.split('.')[0] ?? '';
    const query = signed ? signWbi(params, key(nav.wbi_img?.img_url), key(nav.wbi_img?.sub_url)) : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return requireBili(await jsonFetch('bilibili', `https://api.bilibili.com${path}?${query.toString().replace(/\+/g, '%20')}`), '读取');
  }
  async function xhsAccount(win: BrowserWindow): Promise<{ id: string; name: string }> {
    const account = await win.webContents.executeJavaScript(`(() => {
      const state = window.__INITIAL_STATE__?.user;
      const user = state?.userInfo;
      const value = user?._value ?? user ?? {};
      const loggedIn = state?.loggedIn?._value ?? state?.loggedIn;
      return { id: String(value.user_id || value.userId || value.userID || ''), name: String(value.nickname || value.nickName || value.nick_name || ''), loggedIn };
    })()`) as { id: string; name: string; loggedIn?: boolean };
    if (!/^[a-f0-9]{24}$/i.test(account.id) || account.loggedIn === false) throw loginError('xiaohongshu');
    setConnected('xiaohongshu', account.name || account.id);
    return account;
  }
  async function collectBili(options: CollectionOptions = {}): Promise<CollectionSnapshot> {
    return readBiliFavorites(options, {
      account: biliNav,
      folders: nav => biliApi('/x/v3/fav/folder/created/list-all', { up_mid: String(nav.mid) }, nav),
      page: (folderId, page, nav) => biliApi('/x/v3/fav/resource/list', { media_id: folderId, pn: page, ps: 40, order: 'mtime', type: 0, tid: 0 }, nav),
      delay: () => wait(options.fullHistory ? 1000 : 250),
    });
  }
  async function collectXhs(options: CollectionOptions = {}): Promise<CollectionSnapshot> {
    if (options.fullHistory && options.recentLimit !== undefined) throw new Error('同步范围参数互斥');
    const limit = options.fullHistory ? undefined : recentLimit(options.recentLimit);
    const win = makeWindow('xiaohongshu');
    const captures = new Map<string, XhsCollectionCapture>();
    const diagnosticRequests = new Set<string>();
    const pending = new Set<Promise<void>>();
    let requestOrder = 0;
    let collectionPhase = false;
    try {
      await navigate(win, HOME.xiaohongshu);
      await wait(1800);
      const account = await xhsAccount(win);
      requireSourceAccount(account.id, options.expectedAccountId);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Network.enable');
      await win.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
      win.webContents.debugger.on('message', (_event, method: string, params: Json) => {
        const requestId = String(params.requestId);
        if (method === 'Network.requestWillBeSent') {
          const order = requestOrder++;
          const request = params.request ?? {};
          const capture = xhsCollectionRequest(requestId, order, request);
          if (collectionPhase && capture?.accountId === account.id) captures.set(capture.requestId, capture);
          if (String(request.url).includes('/note/collect/page')) {
            diagnosticRequests.add(requestId);
            let requestPath = '<invalid>';
            let queryKeys: string[] = [];
            let bodyKeys: string[] = [];
            try { const url = new URL(String(request.url)); requestPath = url.pathname; queryKeys = [...url.searchParams.keys()]; } catch { /* No raw URL in logs. */ }
            if (typeof request.postData === 'string') {
              try { const body = JSON.parse(request.postData); bodyKeys = body && typeof body === 'object' ? Object.keys(body) : []; }
              catch { bodyKeys = [...new URLSearchParams(request.postData).keys()]; }
            }
            sourceEvidence('xhs-collection-request', { requestId, order, collectionPhase, method: request.method, requestPath, queryKeys, bodyKeys, identified: !!capture, accountPresent: !!capture?.accountId, accountMatches: capture?.accountId === account.id, accountIdLength: capture?.accountId.length ?? 0, cursor: cursorEvidence(capture?.cursor) });
          }
          return;
        }
        const capture = captures.get(requestId);
        const diagnostic = diagnosticRequests.has(requestId);
        if (!capture && !diagnostic) return;
        if (method === 'Network.responseReceived') {
          if (capture) capture.status = Number(params.response?.status);
          if (diagnostic) sourceEvidence('xhs-collection-response', { requestId, status: Number(params.response?.status), mimeType: params.response?.mimeType });
        }
        if (method === 'Network.loadingFailed') {
          if (capture) capture.failed = true;
          if (diagnostic) sourceEvidence('xhs-collection-loading-failed', { requestId, canceled: !!params.canceled, blockedReason: String(params.blockedReason || '') });
        }
        if (method !== 'Network.loadingFinished') return;
        const task = win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId }).then((body: Json) => {
          const raw = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          const payload = JSON.parse(raw) as Json;
          if (capture) capture.payload = payload;
          if (diagnostic) sourceEvidence('xhs-collection-parsed', { requestId, accountMatches: !!capture, ...responseEvidence(payload) });
        }).catch(() => {
          if (capture) capture.failed = true;
          if (diagnostic) sourceEvidence('xhs-collection-parse-failed', { requestId });
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
      await navigate(win, `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(account.id)}`);
      await wait(1800);
      const expectedPath = `/user/profile/${account.id}`;
      if (new URL(win.webContents.getURL()).pathname !== expectedPath) throw new Error('小红书收藏页跳转异常，请在应用内登录窗口确认平台状态后重试');
      const selectTab = async (label: '笔记' | '收藏'): Promise<void> => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const selected = await win.webContents.executeJavaScript(xhsProfileTabScript(label, true)) as { found: boolean; count: number; active: boolean; clicked: boolean };
          sourceEvidence('xhs-collection-tab', { label, attempt, ...selected });
          if (selected.found && selected.active) return;
          await wait(400);
        }
        throw new Error(`小红书${label}标签未能明确选中，未建立近期检查点，请重试`);
      };
      // Direct ?tab=fav navigation can hydrate its first page from SSR with no
      // API request. Toggle through 笔记 so the site issues a verifiable empty-cursor head.
      await selectTab('笔记');
      await Promise.all([...pending]);
      captures.clear(); diagnosticRequests.clear();
      collectionPhase = true;
      await selectTab('收藏');
      await wait(1200);

      let idle = 0;
      let priorSize = 0;
      let limited: string | undefined;
      let result = assembleXhsCollection(account.id, []);
      for (let round = 0; round < 40; round++) {
        await Promise.all([...pending]);
        for (const capture of captures.values()) {
          const response = capture.payload;
          if (response && (response.success === false || (typeof response.code === 'number' && response.code !== 0)) && /登录|login/i.test(String(response.msg ?? response.message))) throw loginError('xiaohongshu');
        }
        // E4.7: a mid-capture rate limit keeps the partial result; the service cools down.
        if ([...captures.values()].some(capture => [403, 429].includes(capture.status ?? 0) || /限流|频繁|访问受限/.test(String(capture.payload?.msg ?? capture.payload?.message ?? '')))) { limited = '小红书收藏读取受到平台限流或访问限制，请稍后重试'; break; }
        result = assembleXhsCollection(account.id, [...captures.values()]);
        if (result.complete || (limit && result.evidence.reliable && result.items.length >= limit)) break;
        idle = result.items.length === priorSize ? idle + 1 : 0;
        priorSize = result.items.length;
        if (idle >= 5 || result.items.length >= 2000) break;
        await win.webContents.executeJavaScript(`(() => {
          for (const element of document.querySelectorAll('.scroll-container, .main-content, .user-page, .feeds-container')) {
            if (element.scrollHeight > element.clientHeight + 10) element.scrollTop = element.scrollHeight;
          }
          window.scrollTo(0, document.body.scrollHeight);
        })()`);
        await wait(1300);
      }
      await Promise.all([...pending]);
      result = assembleXhsCollection(account.id, [...captures.values()]);
      sourceEvidence('xhs-collection-summary', { accountHash: digest(account.id), capturedRequests: diagnosticRequests.size, matchedRequests: captures.size, itemCount: result.items.length, complete: result.complete, reliable: result.evidence.reliable, reason: result.evidence.reason, pages: result.evidence.pages.map(page => ({ cursor: cursorEvidence(page.cursor), nextCursor: cursorEvidence(page.nextCursor), idsCount: page.ids.length, parsed: page.parsed })) });
      const finalAccount = await xhsAccount(win);
      if (finalAccount.id !== account.id) throw new Error('小红书账号在采集中发生变化，本次结果未用于同步，请重试');
      if (!result.items.length) {
        const dom = await win.webContents.executeJavaScript(`(() => {
          const active = document.querySelector('.tab.active,.tab-item.active,.red-tabs__tab--active,[role=tab][aria-selected=true]');
          if (!active || !/收藏/.test(active.textContent || '')) return [];
          return Array.from(document.querySelectorAll('section.note-item')).map(element => {
            const anchor = element.querySelector('a.cover, a[href*="/explore/"], a[href*="/user/profile/"]');
            const url = anchor ? new URL(anchor.getAttribute('href') || '', location.origin) : null;
            const match = url?.pathname.match(/\\/(?:explore|note|search_result)\\/([a-f0-9]{24})|\\/user\\/profile\\/[^/]+\\/([a-f0-9]{24})/i);
            return { id: match?.[1] || match?.[2] || '', title: element.querySelector('.title')?.textContent || '', user: { nickname: element.querySelector('.author .name,.author-name')?.textContent || '' }, xsec_token: url?.searchParams.get('xsec_token') || '' };
          });
        })()`) as Json[];
        const fallback = new Map<string, CollectionItem>();
        for (const raw of dom) { const item = mapXhsFavorite(raw); if (item) mergeFavorite(fallback, item); }
        result.items = [...fallback.values()];
      }
      return { platform: 'xiaohongshu', accountId: account.id, accountName: account.name || account.id, folders: [{ id: 'saved', title: '收藏笔记' }], items: limit ? result.items.slice(0, limit) : result.items, complete: !limited && result.complete && (!limit || result.items.length <= limit), warning: limited ?? result.warning, recent: { scopes: [result.evidence] }, ...(limited ? { limited } : {}), ...(limit ? { target: { limit, complete: !limited && result.evidence.reliable && (result.complete || result.evidence.orderedIds.length >= limit), reliable: result.evidence.reliable, reason: limited ?? (result.evidence.reliable && result.evidence.orderedIds.length >= limit ? '当前账号连续收藏头部已取得近期目标' : result.complete ? '当前账号收藏已到终页，实际不足目标数' : result.evidence.reason) } } : {}) };
    } finally {
      if (!win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
    }
  }
  async function detailBili(item: CollectionItem, expectedAccountId?: string): Promise<DetailResult> {
    const nav = await biliNav();
    requireSourceAccount(String(nav.mid), expectedAccountId);
    const result = await readBiliDetail(item, (path, params, signed = true) => biliApi(path, params, nav, signed), url => jsonFetch('bilibili', url));
    if (expectedAccountId) requireSourceAccount(String((await biliNav()).mid), expectedAccountId);
    return result;
  }
  async function detailXhs(item: CollectionItem, expectedAccountId?: string): Promise<DetailResult> {
    if (!allowed('xiaohongshu', item.url) || !new URL(item.url).searchParams.get('xsec_token')) throw new Error('小红书详情缺少有效来源签名链接，请重新同步');
    const win = makeWindow('xiaohongshu');
    try {
      await navigate(win, item.url);
      await wait(1800);
      await waitForXhsDetail(win, item.sourceId);
      if (expectedAccountId) requireSourceAccount((await xhsAccount(win)).id, expectedAccountId);
      let result: Json = {};
      for (let attempt = 0; attempt < 10; attempt++) {
        result = await win.webContents.executeJavaScript(xhsDetailExtractScript(item)) as Json;
        sourceEvidence('xhs-detail-inspection', { noteId: item.sourceId, attempt, hasNote: !!result.hasNote, hasSourceBody: !!result.hasSourceBody, type: String(result.type || ''), login: !!result.login, blocked: !!result.blocked, unavailable: !!result.unavailable, images: Array.isArray(result.images) ? result.images.length : null, imageComplete: !!result.imageComplete, diagnostics: result.diagnostics ?? null });
        if (result.login) throw loginError('xiaohongshu');
        if (result.blocked) throw new Error('小红书访问受限，请在应用内登录窗口查看状态后重试');
        if (result.unavailable || (result.hasNote && result.type !== 'video') || (result.hasNote && readXhsDetailResult(item, result).media.some(resource => resource.kind === 'video'))) break;
        // Hydrated正文 can precede the actual player's direct video URL. Give that same note time to initialize.
        await wait(600);
      }
      if (expectedAccountId) requireSourceAccount((await xhsAccount(win)).id, expectedAccountId);
      return readXhsDetailResult(item, result);
    } finally { if (!win.isDestroyed()) win.destroy(); }
  }
  const adapters: SourceAdapter[] = (['xiaohongshu', 'bilibili'] as Platform[]).map(platform => ({
    platform,
    async collect(options) {
      if (collecting.has(platform)) throw new Error('该来源正在同步，请等待当前同步结束');
      collecting.add(platform);
      try { return await (platform === 'bilibili' ? collectBili(options) : collectXhs(options)); }
      catch (error) { accountVerification.invalidate(platform); setError(platform, error); throw new Error(message(error)); }
      finally { collecting.delete(platform); }
    },
    async detail(item, options) {
      try { return await (platform === 'bilibili' ? detailBili(item, options?.expectedAccountId) : detailXhs(item, options?.expectedAccountId)); }
      catch (error) { accountVerification.invalidate(platform); state.set(platform, connectionAfterDetailFailure(state.get(platform)!, error)); throw new Error(message(error)); }
    },
    async verifyAccount(expectedAccountId) {
      getSession(platform); // Install invalidation before any cache lookup or real probe.
      await accountVerification.verify(platform, expectedAccountId, async beginInspection => {
        if (platform === 'bilibili') return String((await biliNav()).mid);
        const probe = makeWindow(platform);
        try { await navigate(probe, HOME[platform]); await wait(1800); beginInspection(); return (await xhsAccount(probe)).id; }
        finally { if (!probe.isDestroyed()) probe.destroy(); }
      });
    },
  }));
  // Check persisted consumer sessions without exposing or exporting their credentials.
  if (options.probeOnStart !== false && process.env.RLW_BLOCK_NETWORK !== '1') queueMicrotask(() => {
    void biliNav().catch(error => { if (!disposed) setError('bilibili', error); });
    void (async () => {
      let probe: BrowserWindow | undefined;
      try {
        if (disposed) return;
        probe = makeWindow('xiaohongshu');
        await navigate(probe, HOME.xiaohongshu);
        await wait(1800);
        if (!disposed && !probe.isDestroyed()) await xhsAccount(probe);
      } catch (error) { if (!disposed) setError('xiaohongshu', error); }
      finally { if (probe && !probe.isDestroyed()) probe.destroy(); }
    })();
  });
  return {
    adapters,
    async login(platform) {
      if (!['xiaohongshu','bilibili'].includes(platform)) throw new Error('不支持的平台');
      accountVerification.invalidate(platform);
      const prior = loginWindows.get(platform);
      if (prior && !prior.isDestroyed()) { prior.show(); prior.focus(); return loginTasks.get(platform); }
      const win = makeWindow(platform, true);
      loginWindows.set(platform, win);
      let verified = false;
      let checking = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      const task = new Promise<void>((resolve, reject) => {
        win.once('closed', () => {
          if (interval) { clearInterval(interval); intervals.delete(interval); }
          loginTasks.delete(platform);
          if (verified) resolve();
          else reject(new Error('登录已取消；关闭窗口不等于登录验证成功，请重新打开平台登录'));
        });
        void navigate(win, HOME[platform]).then(() => {
          if (win.isDestroyed()) return;
          interval = setInterval(() => {
            if (checking || win.isDestroyed()) return;
            checking = true;
            void (platform === 'bilibili' ? biliNav() : xhsAccount(win)).then(() => {
              verified = true;
              if (interval) { clearInterval(interval); intervals.delete(interval); }
              if (!win.isDestroyed()) win.close();
            }).catch(() => undefined).finally(() => { checking = false; });
          }, 2500);
          intervals.add(interval);
        }).catch(error => {
          reject(new Error(message(error)));
          if (!win.isDestroyed()) win.close();
        });
      });
      loginTasks.set(platform, task);
      return task;
    },
    connections: () => [...state.values()].map(value => ({ ...value })),
    dispose() {
      disposed = true;
      accountVerification.dispose();
      sourceSessions.clear();
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
      for (const win of windows) if (!win.isDestroyed()) win.destroy();
      windows.clear();
    },
  };
}
