import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CollectionItem, CollectionSnapshot, Connection, DetailResult, Platform, SourceAdapter } from '../shared/contracts.js';
import { mapBilibiliFavorite, mergeFavorite, sanitizeSourceError, signWbi, connectionAfterDetailFailure } from './source-core.js';

import { biliRecentScope } from './source-collection.js';
import { readBiliDetail, readXhsDetailResult, SourceContentUnavailableError, xhsDetailExtractScript } from './source-detail.js';

type Json = Record<string, any>;
const exec = promisify(execFile);
import { PLATFORM_HOME as HOME } from '../shared/platforms.js';
const METHOD = 'Chrome Browser Bridge 对照验证（外部 Chrome 登录，非应用内登录）';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Explicit opt-in only. Never imports Chrome cookies or claims application login is complete. */
export function createBridgeSources(profile: string, executable = process.env.RLW_OPENCLI || 'opencli') {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Chrome Bridge profile 名称无效');
  const sessions = new Map<Platform, string>(['xiaohongshu', 'bilibili'].map(platform => [platform as Platform, `rlw-${platform}-${process.pid}`]));
  const ready = new Set<Platform>();
  const locks = new Set<Platform>();
  const state = new Map<Platform, Connection>(['xiaohongshu', 'bilibili'].map(platform => [platform as Platform, { platform: platform as Platform, state: 'disconnected', method: METHOD, message: '对照模式：需在所选 Chrome profile 登录；应用内登录尚待独立验证' }]));
  const queues = new Map<Platform, Promise<unknown>>();
  let disposed = false;
  async function command(args: string[], timeout = 90000): Promise<any> {
    if (disposed) throw new Error('Chrome Bridge 对照会话已关闭');
    let stdout: string;
    try { ({ stdout } = await exec(executable, ['--profile', profile, ...args], { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } })); }
    catch (error) {
      // execFile errors embed the full command, which may contain signed source URLs.
      const raw = error instanceof Error ? error.message : '';
      if (/AuthRequired|LOGIN_REQUIRED|not logged|requires login|请.*登录|未登录/i.test(raw)) throw new Error('LOGIN_REQUIRED：Chrome 对照会话未登录或已过期，请在该 Chrome profile 登录后重试');
      if (/412|429|SECURITY_BLOCK|risk control|安全限制/.test(raw)) throw new Error('Chrome 对照采集遇到平台访问限制，请稍后重试');
      throw new Error('Chrome Bridge 对照请求失败，请检查扩展连接、所选 profile 与网络后重试');
    }
    try { return JSON.parse(stdout.trim()); }
    catch { throw new Error('OpenCLI 对照输出格式异常；请检查本机版本'); }
  }
  async function evaluate(platform: Platform, code: string): Promise<any> {
    return command(['browser', sessions.get(platform)!, 'eval', code]);
  }
  async function ensure(platform: Platform): Promise<void> {
    if (ready.has(platform)) return;
    await command(['browser', sessions.get(platform)!, 'open', HOME[platform], '--window', 'background']);
    await wait(1500);
    ready.add(platform);
  }
  function serial<T>(platform: Platform, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(platform) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    queues.set(platform, result.catch(() => undefined));
    return result;
  }
  function fail(platform: Platform, error: unknown): void {
    const detail = sanitizeSourceError(error);
    state.set(platform, { platform, state: detail.includes('LOGIN_REQUIRED') ? 'expired' : 'error', method: METHOD, message: detail });
  }
  async function navAccount(): Promise<Json> {
    await ensure('bilibili');
    const result = await evaluate('bilibili', `(async()=>{const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'});return r.json()})()`);
    if (result?.code !== 0 || !result.data?.isLogin || !result.data?.mid) throw new Error('LOGIN_REQUIRED：所选 Chrome profile 的 B站未登录，请在 Chrome 完成登录后重试');
    state.set('bilibili', { platform: 'bilibili', state: 'connected', accountName: String(result.data.uname || result.data.mid), method: METHOD, message: 'Chrome 对照账号有效；应用内登录未在此路径验证', verifiedAt: Date.now() });
    return result.data;
  }
  async function api(path: string, params: Record<string, string | number>, account: Json, signed = true): Promise<Json> {
    const key = (url: unknown) => String(url ?? '').split('/').pop()?.split('.')[0] ?? '';
    const query = signed ? signWbi(params, key(account.wbi_img?.img_url), key(account.wbi_img?.sub_url)) : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const url = `https://api.bilibili.com${path}?${query.toString().replace(/\+/g, '%20')}`;
    const result = await evaluate('bilibili', `(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include'});return r.json()})()`);
    if (result.code === -101 || result.code === -111) throw new Error('LOGIN_REQUIRED：Chrome B站登录已失效');
    if (result.code === 62002 || result.code === -404) throw new SourceContentUnavailableError(Number(result.code));
    if (result.code !== 0 || !result.data) throw new Error(`B站 Chrome 对照接口失败（${Number(result.code) || '未知错误'}）`);
    return result.data;
  }
  async function collectBili(): Promise<CollectionSnapshot> {
    const nav = await navAccount();
    const list = await api('/x/v3/fav/folder/created/list-all', { up_mid: String(nav.mid) }, nav);
    if (!Array.isArray(list.list)) {
      if (Number(list.count) === 0) return { platform: 'bilibili', accountId: String(nav.mid), accountName: String(nav.uname), folders: [], items: [], complete: true, recent: { scopes: [] } };
      throw new Error('B站收藏夹列表格式异常，未建立同步基线');
    }
    const folders = list.list.map((folder: Json) => ({ id: String(folder.id), title: String(folder.title || '未命名收藏夹') }));
    const items = new Map<string, CollectionItem>();
    const warnings: string[] = [];
    const scopes: NonNullable<CollectionSnapshot['recent']>['scopes'] = [];
    for (const folder of folders) {
      let completed = false;
      let reason = '';
      const pages: NonNullable<CollectionSnapshot['recent']>['scopes'][number]['pages'] = [];
      try {
        for (let page = 1; page <= 250; page++) {
          const data = await api('/x/v3/fav/resource/list', { media_id: folder.id, pn: page, ps: 40, order: 'mtime', type: 0, tid: 0 }, nav);
          const medias = data.medias === null && Number(data.info?.media_count) === 0 ? [] : data.medias;
          if (!Array.isArray(medias)) throw new Error('收藏夹内容返回格式异常');
          const mapped = medias.map((raw: Json) => mapBilibiliFavorite(raw, folder.id));
          for (const item of mapped) if (item) mergeFavorite(items, item);
          completed = data.has_more === false || data.has_more === 0 || (data.info?.media_count != null && data.info.media_count !== '' && Number.isSafeInteger(Number(data.info.media_count)) && page * 40 >= Number(data.info.media_count));
          pages.push({ cursor: String(page), nextCursor: completed ? null : String(page + 1), ids: mapped.filter((item: CollectionItem | null): item is CollectionItem => !!item).map((item: CollectionItem) => item.sourceId), parsed: mapped.every(Boolean) });
          if (mapped.some((item: CollectionItem | null) => !item)) throw new Error('分页包含无法解析的内容，新增仅采用之前连续完整页');
          if (completed) break;
          if (!medias.length) throw new Error('分页未提供明确结束标志');
        }
        if (!completed) { reason = '达到分页安全上限，历史部分覆盖'; warnings.push(`收藏夹 ${folder.title} ${reason}`); }
      } catch (error) {
        if (sanitizeSourceError(error).includes('LOGIN_REQUIRED')) throw error;
        reason = sanitizeSourceError(error); warnings.push(`收藏夹 ${folder.title}：${reason}`);
      }
      scopes.push(biliRecentScope(folder.id, pages, reason));
    }
    return { platform: 'bilibili', accountId: String(nav.mid), accountName: String(nav.uname || nav.mid), folders, items: [...items.values()], complete: warnings.length === 0, warning: warnings.length ? warnings.join('；') : undefined, recent: { scopes } };
  }
  async function xhsAccount(): Promise<{ id: string; name: string }> {
    if (ready.has('xiaohongshu')) {
      await command(['browser', sessions.get('xiaohongshu')!, 'open', HOME.xiaohongshu, '--window', 'background']);
      await wait(1500);
    } else await ensure('xiaohongshu');
    const result = await evaluate('xiaohongshu', `(()=>{const s=window.__INITIAL_STATE__?.user;const u=s?.userInfo;const p=u?._value??u??{};return {id:String(p.user_id||p.userId||p.userID||''),name:String(p.nickname||p.nickName||p.nick_name||''),loggedIn:s?.loggedIn?._value??s?.loggedIn}})()`);
    if (!/^[a-f0-9]{24}$/i.test(result.id) || result.loggedIn === false) throw new Error('LOGIN_REQUIRED：所选 Chrome profile 的小红书未登录，请在 Chrome 登录后重试');
    state.set('xiaohongshu', { platform: 'xiaohongshu', state: 'connected', accountName: result.name || result.id, method: METHOD, message: 'Chrome 对照账号有效；应用内登录未在此路径验证', verifiedAt: Date.now() });
    return result;
  }
  async function collectXhs(): Promise<CollectionSnapshot> {
    const account = await xhsAccount();
    const rows = await command(['xiaohongshu', 'saved', '--limit', '100', '-f', 'json']);
    if (!Array.isArray(rows)) throw new Error('小红书 OpenCLI 收藏输出格式异常');
    const items: CollectionItem[] = rows.filter(row => /^[a-f0-9]{24}$/i.test(String(row.id)) && /^https:\/\/(?:www\.)?xiaohongshu\.com\//.test(String(row.url))).map(row => ({
      sourceId: String(row.id), title: String(row.title || '标题未取得'), author: String(row.author || ''), url: String(row.url), kind: row.type === 'video' ? 'video' : 'image', publishedAt: null, collectedAt: null, folderIds: ['saved'],
    }));
    return { platform: 'xiaohongshu', accountId: account.id, accountName: account.name || account.id, folders: [{ id: 'saved', title: '收藏笔记' }], items, complete: false, warning: 'Chrome Bridge 对照：OpenCLI saved 最多读取100条且受滚动限制；历史部分覆盖且近期顺序未知', recent: { scopes: [{ scopeId: 'saved', reliable: false, orderedIds: [], sort: 'unknown', reason: 'OpenCLI未提供请求游标证据，不用于可靠新增判断', pages: [] }] } };
  }
  async function detailBili(item: CollectionItem): Promise<DetailResult> {
    const account = await navAccount();
    return readBiliDetail(item, (path, params, signed = true) => api(path, params, account, signed), url => evaluate('bilibili', `(async()=>{const r=await fetch(${JSON.stringify(url)});return r.json()})()`));
  }
  async function detailXhs(item: CollectionItem): Promise<DetailResult> {
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || !/(^|\.)xiaohongshu\.com$/.test(url.hostname) || !url.searchParams.get('xsec_token')) throw new Error('小红书来源签名链接无效，请重新同步');
    await ensure('xiaohongshu');
    await command(['browser', sessions.get('xiaohongshu')!, 'open', item.url, '--window', 'background']);
    await wait(1800);
    let result: Json = {};
    for (let attempt = 0; attempt < 10; attempt++) {
      result = await evaluate('xiaohongshu', xhsDetailExtractScript(item));
      if (result.login) throw new Error('LOGIN_REQUIRED：Chrome 小红书登录已失效');
      if (result.blocked) throw new Error('小红书对照详情访问受限，请稍后重试');
      if (result.unavailable || (result.hasNote && result.type !== 'video') || (result.hasNote && readXhsDetailResult(item, result).media.some(resource => resource.kind === 'video'))) break;
      await wait(600);
    }
    return readXhsDetailResult(item, result);
  }
  const adapters: SourceAdapter[] = (['xiaohongshu', 'bilibili'] as Platform[]).map(platform => ({
    platform,
    async collect() {
      if (locks.has(platform)) throw new Error('该来源正在同步，请等待');
      locks.add(platform);
      try { return await serial(platform, () => platform === 'bilibili' ? collectBili() : collectXhs()); }
      catch (error) { fail(platform, error); throw new Error(sanitizeSourceError(error)); }
      finally { locks.delete(platform); }
    },
    async detail(item) {
      try { return await serial(platform, () => platform === 'bilibili' ? detailBili(item) : detailXhs(item)); }
      catch (error) { state.set(platform, connectionAfterDetailFailure(state.get(platform)!, error)); throw new Error(sanitizeSourceError(error)); }
    },
  }));
  return {
    adapters,
    async login(platform: Platform): Promise<void> {
      if (!['xiaohongshu','bilibili'].includes(platform)) throw new Error('不支持的平台');
      await command(['browser', sessions.get(platform)!, 'open', HOME[platform], '--window', 'foreground']);
      ready.add(platform);
      state.set(platform, { platform, state: 'disconnected', method: METHOD, message: '已打开 Chrome 对照登录页；完成登录后请手动同步。此操作不等于应用内登录' });
    },
    connections: () => [...state.values()].map(value => ({ ...value })),
    fetch: (url: string, init?: RequestInit, _platform?: Platform): Promise<Response> => globalThis.fetch(url, init),
    dispose(): void {
      for (const name of sessions.values()) void command(['browser', name, 'close'], 10000).catch(() => undefined);
      disposed = true;
      ready.clear();
    },
  };
}
