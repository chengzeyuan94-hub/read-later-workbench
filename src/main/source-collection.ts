import type { CollectionItem, RecentScopeEvidence, CollectionOptions, CollectionSnapshot } from '../shared/contracts.js';
import { mapXhsFavorite, mapBilibiliFavorite, mergeFavorite, sanitizeSourceError } from './source-core.js';

export function recentLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('近期同步数量必须为1至100');
  return value;
}

/** Cross-folder mtime merge. Never substitute publication time for a missing favorite time. */
export function selectBiliRecent(items: CollectionItem[], limit: number): { items: CollectionItem[]; reliable: boolean } {
  recentLimit(limit);
  const unique = new Map<string, CollectionItem>();
  for (const item of items) mergeFavorite(unique, { ...item, folderIds: [...item.folderIds] });
  const values = [...unique.values()];
  const reliable = values.every(item => typeof item.collectedAt === 'number' && Number.isFinite(item.collectedAt) && item.collectedAt > 0);
  values.sort((a,b) => (b.collectedAt ?? -1) - (a.collectedAt ?? -1) || a.sourceId.localeCompare(b.sourceId));
  return { items: values.slice(0, limit), reliable };
}

export function requireSourceAccount(actual: string, expected?: string): void {
  if (expected !== undefined && actual !== expected) throw new Error('ACCOUNT_CHANGED：当前平台账号与本批次不一致，已暂停该平台，请切回原账号后继续');
}

type Json = Record<string, any>;
/** A capture belongs to one isolated navigation. Never persist its request URL or payload. */
export interface XhsCollectionCapture {
  requestId: string; requestOrder: number; accountId: string; cursor: string | null;
  payload?: Json; status?: number; failed?: boolean;
}
export function xhsCollectionRequest(requestId: string, requestOrder: number, request: Json): XhsCollectionCapture | null {
  if (!['GET', 'POST'].includes(String(request.method ?? 'GET').toUpperCase())) return null;
  let url: URL;
  try { url = new URL(String(request.url)); } catch { return null; }
  if (url.protocol !== 'https:' || !/(^|\.)xiaohongshu\.com$/i.test(url.hostname) || !/\/note\/collect\/page\/?$/.test(url.pathname)) return null;
  let body: Json = {};
  if (typeof request.postData === 'string') {
    try { body = JSON.parse(request.postData); } catch { body = Object.fromEntries(new URLSearchParams(request.postData)); }
  }
  const accountId = String(url.searchParams.get('user_id') ?? body.user_id ?? '');
  // An explicit empty cursor identifies the head; an absent cursor is not guessed to be the head.
  const cursorValue = url.searchParams.has('cursor') ? url.searchParams.get('cursor') : body.cursor;
  const cursor = typeof cursorValue === 'string' || typeof cursorValue === 'number' ? String(cursorValue) : null;
  return { requestId, requestOrder, accountId, cursor };
}
interface ParsedPage {
  capture: XhsCollectionCapture; items: CollectionItem[]; ids: string[];
  parsed: boolean; terminal: boolean; next: string | null; reason: string;
}
function parsePage(capture: XhsCollectionCapture): ParsedPage {
  const base = { capture, items: [] as CollectionItem[], ids: [] as string[], parsed: false, terminal: false, next: null as string | null, reason: '' };
  if (capture.failed || capture.status !== 200 || !capture.payload) return { ...base, reason: '收藏响应未完成或读取失败' };
  const response = capture.payload;
  if (response.success === false || (typeof response.code === 'number' && response.code !== 0)) return { ...base, reason: '平台收藏接口拒绝请求' };
  const data = response.data;
  const notes = data?.notes ?? data?.note_list;
  if (!Array.isArray(notes)) return { ...base, reason: '收藏分页结构无法完整解析' };
  const items = notes.map(raw => mapXhsFavorite(raw));
  if (items.some(item => !item)) return { ...base, reason: '收藏分页有缺失ID或来源签名的内容' };
  const terminal = data.has_more === false || data.has_more === 0 || data.hasMore === false;
  const cursor = data.cursor ?? data.next_cursor ?? data.nextCursor;
  const next = typeof cursor === 'string' || typeof cursor === 'number' ? String(cursor) : null;
  if (!terminal && (!next || next === capture.cursor)) return { ...base, reason: '未取得可验证的下一页游标' };
  const valid = items as CollectionItem[];
  if (new Set(valid.map(item => item.sourceId)).size !== valid.length) return { ...base, reason: '同页重复ID，列表顺序无法确认' };
  return { capture, items: valid, ids: valid.map(item => item.sourceId), parsed: true, terminal, next: terminal ? null : next, reason: '' };
}
/** CDP completion order has no meaning. Follow only the current account's explicit cursor chain. */
export function assembleXhsCollection(accountId: string, captures: XhsCollectionCapture[]): {
  items: CollectionItem[]; complete: boolean; evidence: RecentScopeEvidence; warning?: string;
} {
  const own = captures.filter(capture => capture.accountId === accountId).sort((a, b) => a.requestOrder - b.requestOrder);
  const pages = own.map(parsePage);
  const map = new Map<string, ParsedPage[]>();
  for (const page of pages) if (page.capture.cursor !== null) map.set(page.capture.cursor, [...(map.get(page.capture.cursor) ?? []), page]);
  const items = new Map<string, CollectionItem>();
  const orderedIds: string[] = [];
  const evidencePages: RecentScopeEvidence['pages'] = [];
  const visited = new Set<string>();
  let cursor = '';
  let terminal = false;
  let reason = '';
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const candidates = map.get(cursor);
    if (!candidates?.length) { reason = cursor === '' ? '未取得当前账号显式空游标首屏' : '游标链断页；仅此前连续头部可供检查点判断'; break; }
    // A failed/reordered duplicate can reflect concurrent page changes. Do not choose whichever finished last.
    const first = candidates[0]!;
    if (candidates.some(page => !page.parsed || JSON.stringify([page.ids, page.next, page.terminal]) !== JSON.stringify([first.ids, first.next, first.terminal]))) {
      reason = cursor === '' ? '首屏请求失败、损坏或多次结果不一致' : '重复分页结果不一致；保留此前连续头部'; break;
    }
    if (!first.parsed) { reason = first.reason; break; }
    if (first.ids.some(id => items.has(id))) { reason = '分页ID重叠，可能发生列表变动；保留此前连续头部'; break; }
    evidencePages.push({ cursor, nextCursor: first.next, ids: first.ids, parsed: true });
    for (const item of first.items) { mergeFavorite(items, item); orderedIds.push(item.sourceId); }
    if (first.terminal) { terminal = true; break; }
    cursor = first.next!;
  }
  if (!terminal && !reason) reason = '收藏游标链循环，历史范围未知';
  const reliable = evidencePages.length > 0 && evidencePages[0]!.parsed;
  const complete = terminal && pages.every(page => page.parsed && visited.has(page.capture.cursor ?? '<unknown>'));
  if (!reason && !complete) reason = '连续头部已取得；其他分页未完成，历史部分覆盖';
  const evidence: RecentScopeEvidence = {
    scopeId: 'saved', reliable, orderedIds, sort: reliable ? 'collection-order' : 'unknown',
    reason: reason || '已验证当前账号空游标首屏、连续分页及平台页内顺序；收藏时间顺序需真实新增验证', pages: evidencePages,
  };
  return { items: [...items.values()], complete, evidence, warning: complete ? undefined : reason || '历史部分覆盖' };
}

/** Explicitly numbered B站 pages, requested in order=mtime. Reliability stops before the first damaged page. */
export function biliRecentScope(scopeId: string, pages: RecentScopeEvidence['pages'], reason = ''): RecentScopeEvidence {
  const orderedIds: string[] = [];
  const retained: RecentScopeEvidence['pages'] = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    if (page.cursor !== String(index + 1) || !page.parsed || new Set(page.ids).size !== page.ids.length || page.ids.some(id => orderedIds.includes(id))) break;
    retained.push(page); orderedIds.push(...page.ids);
  }
  const reliable = retained.length > 0;
  return { scopeId, reliable, orderedIds, pages: retained, sort: reliable ? 'collection-order' : 'unknown', reason: reason || (reliable ? 'order=mtime，首屏开始连续解析收藏夹分页' : '未取得可靠首屏，不能判定新增') };
}


/** Selecting platform tabs is a read-only view change and asks the platform itself for its first API page. */
export function xhsProfileTabScript(label: '笔记' | '收藏', click: boolean): string {
  return `(() => {
    const label = ${JSON.stringify(label)};
    const candidates = Array.from(document.querySelectorAll('[role="tab"],.reds-tab-item,.red-tabs__tab,.tab-item,.tab')).filter(element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden' && (element.textContent || '').trim() === label;
    });
    if (candidates.length !== 1) return { found: false, count: candidates.length, active: false, clicked: false };
    const element = candidates[0];
    const active = element.getAttribute('aria-selected') === 'true' || /(?:^|\\s)(?:active|reds-tab-item-active|red-tabs__tab--active)(?:\\s|$)/.test(element.className || '');
    if (${JSON.stringify(click)} && !active) element.click();
    return { found: true, count: 1, active, clicked: ${JSON.stringify(click)} && !active };
  })()`;
}

export async function readBiliFavorites(options: CollectionOptions, io: {
  account(): Promise<Json>; folders(account: Json): Promise<Json>;
  page(folderId: string, page: number, account: Json): Promise<Json>; delay?(): Promise<void>;
}): Promise<CollectionSnapshot> {
    if (options.fullHistory && options.recentLimit !== undefined) throw new Error('同步范围参数互斥');
    const limit = options.fullHistory ? undefined : recentLimit(options.recentLimit);
    const nav = await io.account();
    requireSourceAccount(String(nav.mid), options.expectedAccountId);
    const list = await io.folders(nav);
    if (!Array.isArray(list.list)) {
      if (Number(list.count) === 0) return { platform: 'bilibili', accountId: String(nav.mid), accountName: String(nav.uname), folders: [], items: [], complete: true, recent: { scopes: [] }, ...(limit ? { target: { limit, complete: true, reliable: true, reason: '当前账号没有收藏夹' } } : {}) };
      throw new Error('B站收藏夹列表格式异常，未建立同步基线');
    }
    const folders = list.list.map((folder: Json) => ({ id: String(folder.id), title: String(folder.title || '未命名收藏夹') }));
    const items = new Map<string, CollectionItem>();
    const warnings: string[] = [];
    const scopes: NonNullable<CollectionSnapshot['recent']>['scopes'] = [];
    let allHistoryComplete = true, allTargetsComplete = true, orderReliable = true, limited: string | undefined;
    for (const folder of folders) {
      let completed = false;
      let stopCollection = false;
      let reason = '';
      const folderItems = new Map<string, CollectionItem>();
      let lastFavoriteTime = Number.POSITIVE_INFINITY;
      const pages: NonNullable<CollectionSnapshot['recent']>['scopes'][number]['pages'] = [];
      try {
        for (let page = 1; page <= 250; page++) {
          const data = await io.page(folder.id, page, nav);
          const medias = data.medias === null && Number(data.info?.media_count) === 0 ? [] : data.medias;
          if (!Array.isArray(medias)) throw new Error('收藏夹内容返回格式异常');
          const mapped = medias.map((raw: Json) => mapBilibiliFavorite(raw, folder.id));
          if (!limit || mapped.every(Boolean)) for (const item of mapped) if (item) {
            if (limit) {
              if (!item.collectedAt || item.collectedAt > lastFavoriteTime) orderReliable = false;
              if (item.collectedAt) lastFavoriteTime = item.collectedAt;
            }
            mergeFavorite(folderItems, item);
            if (!limit) mergeFavorite(items, item);
          }
          const count = data.info?.media_count;
          const countReached = count != null && count !== '' && Number.isSafeInteger(Number(count)) && Number(count) >= 0 && folderItems.size >= Number(count);
          // An explicit continuation wins over stale totals. Only actually read unique entries can satisfy the count fallback.
          completed = data.has_more === false || data.has_more === 0 || (data.has_more == null && countReached);
          pages.push({ cursor: String(page), nextCursor: completed ? null : String(page + 1), ids: mapped.filter((item: CollectionItem | null): item is CollectionItem => !!item).map((item: CollectionItem) => item.sourceId), parsed: mapped.every(Boolean) });
          if (mapped.some((item: CollectionItem | null) => !item)) throw new Error('分页包含无法解析的内容，新增仅采用之前连续完整页');
          if (completed || (limit && folderItems.size >= limit) || (!limit && items.size >= 5000)) break;
          if (medias.length < 40) throw new Error('非终页返回数量不足，未确认后续连续范围');
          await io.delay?.();
        }
        if (!completed && !(limit && folderItems.size >= limit)) { reason = !limit && items.size >= 5000 ? '达到 5000 条安全上限，历史部分覆盖' : '达到分页安全上限，历史部分覆盖'; warnings.push(`收藏夹 ${folder.title} ${reason}`); }
      } catch (error) {
        if (sanitizeSourceError(error).includes('LOGIN_REQUIRED')) throw error;
        reason = sanitizeSourceError(error); warnings.push(`收藏夹 ${folder.title}：${reason}`);
        // E4.7: a mid-page rate limit keeps the partial collect and cools down.
        if(/HTTP\s*(?:403|412|429)|限流|访问受限|风控/.test(reason)){limited=reason;stopCollection=true;}
      }
      const scope = biliRecentScope(folder.id, pages, reason);
      scopes.push(scope);
      if (limit) {
        const selected = scope.orderedIds.slice(0, limit);
        for (const id of selected) { const item = folderItems.get(id); if (item) mergeFavorite(items, item); }
        const reliableTerminal = completed && !reason && scope.pages.length === pages.length;
        allTargetsComplete &&= reliableTerminal || selected.length >= limit;
        allHistoryComplete &&= reliableTerminal;
      }
      if (!limit && items.size >= 5000) stopCollection = true;
      if(stopCollection){allTargetsComplete=false;allHistoryComplete=false;break;}
    }
    const finalNav = await io.account();
    requireSourceAccount(String(finalNav.mid), String(nav.mid));
    const recent = limit ? selectBiliRecent([...items.values()], limit) : undefined;
    const targetComplete = !!recent && allTargetsComplete && orderReliable && recent.reliable;
    return { platform: 'bilibili', accountId: String(nav.mid), accountName: String(nav.uname || nav.mid), folders, items: recent?.items ?? [...items.values()], complete: warnings.length === 0 && (!limit || (allHistoryComplete && items.size <= limit)), warning: warnings.length ? warnings.join('；') : undefined, ...(limited ? { limited } : {}), recent: { scopes }, ...(limit ? { target: { limit, complete: targetComplete, reliable: orderReliable && !!recent?.reliable, reason: targetComplete ? (recent!.items.length < limit ? '当前账号收藏不足目标数，已到所有收藏夹终页' : '全部收藏夹近期头部按收藏时间合并，近期目标完成') : '部分收藏夹分页或收藏时间顺序无法确认，保留已取得范围' } } : {}) };

}
