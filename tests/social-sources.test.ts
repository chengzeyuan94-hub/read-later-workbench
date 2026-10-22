import assert from 'node:assert/strict';
import test from 'node:test';
import { mapZhihuFavorite, nextZhihuOffset, parseWeiboCard, readWeiboDetail, readWeiboFavorites, readWeiboFavoritePages, readZhihuDetail, readZhihuFavorites, safeWeiboPathname, socialAccount, socialIdentityEvidence, socialText, verifyWeiboProfile, weiboDetailEvidence, weiboFavoritePageNumber, weiboPageControlNumber, weiboProfileEvidence, weiboRouteEvidence, type WeiboVisiblePage, type WeiboFavoritesPage } from '../src/main/social-source-core.js';

const account = { id: '12345', name: 'fixture', token: 'fixture-user' };
const card = (id: string) => ({ url: `https://weibo.com/12345/${id}`, author: '作者', body: `正文 ${id}`, image: true });
const page = (ids: string[], extra: Partial<WeiboVisiblePage> = {}): WeiboVisiblePage => ({ cards: ids.map(card), accountId: account.id, atTop: false, terminal: false, empty: false, ...extra });
const answer = (id: string, time?: number) => ({ ...(time ? { created_time: time } : {}), content: { type: 'answer', id, question: { title: '问题' }, author: { name: '作者' }, content: '<p>正文</p>', created_time: 10 } });
const noop = async () => {};

test('social account probes require actual self identities and reject anonymous or unsafe numeric identities', () => {
  assert.deepEqual(socialAccount('weibo', { ok: 1, data: { uid: '12345', nick: 'fixture' } }), { id: '12345', name: 'fixture' });
  assert.throws(() => socialAccount('weibo', { ok: 1, data: { uid: 0 } }), /LOGIN_REQUIRED/);
  assert.throws(() => socialAccount('weibo', { ok: 1, data: { uid: 12345, islogin: false } }), /LOGIN_REQUIRED/);
  assert.throws(() => socialAccount('zhihu', { id: 9007199254740993, url_token: 'fixture' }), /LOGIN_REQUIRED/);
  assert.equal(socialAccount('zhihu', { id: '9007199254740993', url_token: 'fixture', name: '昵称' }).id, '9007199254740993');
  assert.throws(() => socialAccount('zhihu', { id: 'a' }), /LOGIN_REQUIRED/);
});

test('Weibo identity compatibility does not let an unrelated config object shadow self uid or accept a conflicting/logout identity', () => {
  assert.equal(socialAccount('weibo', { ok: 1, data: { uid: '12345', config: { theme: 'light' } } }).id, '12345');
  assert.equal(socialAccount('weibo', { ok: '1', data: { config: { uid: '12345', islogin: '1' } } }).id, '12345');
  assert.equal(socialAccount('weibo', { uid: '12345', isLogin: true }).id, '12345');
  assert.throws(() => socialAccount('weibo', { ok: 1, data: { uid: '12345', islogin: '0' } }), /LOGIN_REQUIRED/);
  assert.throws(() => socialAccount('weibo', { ok: 0, data: { uid: '12345', islogin: true } }), /LOGIN_REQUIRED/);
  assert.throws(() => socialAccount('weibo', { ok: 1, data: { uid: '12345', config: { uid: '67890' } } }), /ACCOUNT_CHANGED/);
  assert.throws(() => socialAccount('weibo', { data: { uid: '12345' } }), /LOGIN_REQUIRED/);
  assert.equal(verifyWeiboProfile(account, { data: { user: { id: '12345', screen_name: '确认昵称' } } }).name, '确认昵称');
  assert.throws(() => verifyWeiboProfile(account, { data: { user: { id: '67890' } } }), /ACCOUNT_CHANGED/);
});

test('Weibo identity evidence contains only structural keys/types and boolean identity/login state', () => {
  const raw = { ok: 1, data: { uid: '1234567890', islogin: '1', screen_name: '私人昵称', config: { cookie: 'sensitive-value', token: 'secret-token' } } };
  const evidence = socialIdentityEvidence(raw);
  assert.equal(evidence.idPresent, true); assert.deepEqual(evidence.isLogin, [true, null, null]);
  const serialized = JSON.stringify(evidence);
  for (const secret of ['1234567890', '私人昵称', 'sensitive-value', 'secret-token']) assert.equal(serialized.includes(secret), false);
  assert.equal((evidence.dataKeys as string[]).includes('uid'), true);
});

test('Weibo profile and favorites-route diagnostics separate identity mismatch from unknown routes without recording identities', () => {
  const profile = weiboProfileEvidence(account, { data: { user: { id: 12345 } } });
  assert.equal(profile.accountMatches, true); assert.equal(profile.idType, 'number');
  assert.equal(weiboProfileEvidence(account, { data: { user: { id: '67890' } } }).accountMatches, false);
  const known = weiboRouteEvidence('/u/page/fav/12345', account.id);
  assert.equal(known.accountMatches, true); assert.equal(known.pathnamePattern, 'favorites-with-account');
  const other = weiboRouteEvidence('/u/page/fav/67890', account.id);
  assert.equal(other.accountIdPresent, true); assert.equal(other.accountMatches, false);
  const generic = weiboRouteEvidence('/fav', account.id);
  assert.equal(generic.accountIdPresent, false); assert.equal(generic.pathnamePattern, 'favorites-other');
  assert.equal(weiboRouteEvidence('/login', account.id).pathnamePattern, 'login');
  assert.equal(weiboRouteEvidence('/u/12345', account.id).pathnamePattern, 'profile');
  const serialized = JSON.stringify({ profile, known, other, generic });
  assert.equal(serialized.includes('12345'), false); assert.equal(serialized.includes('67890'), false); assert.equal(serialized.includes('/u/page/fav/12345'), false);
});

test('Weibo redirected two-segment /fav/:id route must still match the authenticated account exactly', () => {
  assert.equal(weiboRouteEvidence('/fav/12345', account.id).accountMatches, true);
  assert.equal(weiboRouteEvidence('/fav/12345/', account.id).routeShape, '/fav/:id');
  assert.equal(weiboRouteEvidence('/fav/67890', account.id).accountMatches, false);
  for (const path of ['/fav', '/fav/not-an-id', '/other/fav/12345', '/fav/12345/extra', '/u/page/fav']) {
    assert.equal(weiboRouteEvidence(path, account.id).accountIdPresent, false, path);
  }
  assert.equal(JSON.stringify(weiboRouteEvidence('/fav/12345', account.id)).includes('12345'), false);
});

test('Weibo unknown route templates reveal only approved route words, numeric placeholders and opaque segment shape', () => {
  assert.equal(safeWeiboPathname('/fav/1234567890'), '/fav/:id');
  assert.equal(safeWeiboPathname('/1234567890/fav/'), '/:id/fav/');
  assert.equal(safeWeiboPathname('/fav/privateNickname'), '/fav/:letters(15)');
  assert.equal(safeWeiboPathname('/fav/private123'), '/fav/:alnum(10)');
  assert.equal(safeWeiboPathname('/fav/private_name'), '/fav/:token(12)');
  assert.equal(safeWeiboPathname('/fav/%E7%A7%81'), '/fav/:encoded(9)');
  assert.equal(weiboRouteEvidence('/1234567890/fav', '1234567890').accountIdPresent, false, 'diagnostic coverage does not widen accepted route identities');
  assert.equal(safeWeiboPathname('/fav/' + 's'.repeat(400)), '/fav/:letters(256+)');
});

const paged = (current: number, count: number, available: number, extra: Partial<WeiboFavoritesPage> = {}): WeiboFavoritesPage => ({
  page: current, routePage: current, navigationAccountIds: [account.id], total: 34, slotsReliable: true, paginationVerified: true,
  previousDisabled: current === 1, nextPage: current === 1 ? 2 : null, terminal: current === 2, blocked: false,
  slots: Array.from({ length: count }, (_, index) => ({ key: `position:${index}`, unavailable: index >= available, ...(index < available ? { card: card(`p${current}n${index}`) } : {}) })), ...extra,
});

test('Weibo actual /u/favorites route accepts only a single positive page GET parameter', () => {
  assert.equal(weiboFavoritePageNumber('https://weibo.com/u/favorites?page=1'), 1);
  assert.equal(weiboFavoritePageNumber('https://www.weibo.com/u/favorites?page=2'), 2);
  for (const url of ['https://weibo.com/u/favorites', 'https://weibo.com/u/favorites?page=0', 'https://weibo.com/u/favorites?page=-1', 'https://weibo.com/u/favorites?page=1.5', 'https://weibo.com/u/favorites?page=1&page=2', 'https://weibo.com/u/favorites?page=1&uid=12345', 'https://evil.test/u/favorites?page=1', 'https://weibo.com/fav/12345?page=1']) assert.equal(weiboFavoritePageNumber(url), null, url);
});

test('Weibo numbered buttons accept exact accessible page labels and do not infer pages from arbitrary text', () => {
  assert.equal(weiboPageControlNumber([null, '第2页', '2']), 2);
  assert.equal(weiboPageControlNumber(['', '第 3 页', '\uE001']), 3);
  for (const label of ['2', '下一页', '收藏总数 34', '第0页', '转到第2页', '第2页已选中', '第9007199254740992页']) assert.equal(weiboPageControlNumber([label]), null, label);
});

test('Weibo real numbered pages count all 34 slots, import accessible posts and report deleted placeholders without inventing identities', async () => {
  const requested: number[] = []; let accountChecks = 0;
  const result = await readWeiboFavoritePages({}, { account: async () => { accountChecks++; return account; }, page: async (_account, number) => { requested.push(number); return number === 1 ? paged(1, 20, 8) : paged(2, 14, 6); } });
  assert.deepEqual(requested, [1, 2]); assert.equal(accountChecks, 2); assert.equal(result.items.length, 14);
  assert.equal(result.complete, true); assert.equal(result.target?.complete, true);
  assert.match(result.target!.reason, /平台显示 34 条；已检查 34 个槽位，可导入 14 条，不可访问占位 20 条，未识别 0 条/);
  assert.equal(result.items.every(item => /^p[12]n\d+$/.test(item.sourceId)), true);
});

test('Weibo slots missing from the declared total or unavailable navigation identity cannot become complete', async () => {
  const result = await readWeiboFavoritePages({}, { account: async () => account, page: async (_account, number) => number === 1 ? paged(1, 18, 8) : paged(2, 14, 6) });
  assert.equal(result.items.length, 14); assert.equal(result.target?.complete, false); assert.match(result.target!.reason, /总数不一致/);
  await assert.rejects(readWeiboFavoritePages({}, { account: async () => account, page: async () => paged(1, 20, 8, { navigationAccountIds: [] }) }), /我的主页/);
  await assert.rejects(readWeiboFavoritePages({}, { account: async () => account, page: async () => paged(1, 20, 8, { navigationAccountIds: ['67890'] }) }), /ACCOUNT_CHANGED/);
});

test('Weibo fresh favorite-page self identity supports hidden navigation while preserving all identity conflict checks', async () => {
  const finalPage = (extra: Partial<WeiboFavoritesPage>) => paged(1, 1, 1, { total: 1, nextPage: null, terminal: true, ...extra });
  let accountChecks = 0;
  const result = await readWeiboFavoritePages({}, { account: async () => { accountChecks++; return account; }, page: async () => finalPage({ navigationAccountIds: [], pageSelfAccountId: account.id }) });
  assert.equal(result.complete, true); assert.equal(accountChecks, 2); assert.equal(result.items.length, 1);
  await assert.rejects(readWeiboFavoritePages({}, { account: async () => account, page: async () => finalPage({ navigationAccountIds: [account.id], pageSelfAccountId: '67890' }) }), /ACCOUNT_CHANGED/);
  await assert.rejects(readWeiboFavoritePages({}, { account: async () => account, page: async () => finalPage({ navigationAccountIds: ['67890'], pageSelfAccountId: account.id }) }), /ACCOUNT_CHANGED/);
  await assert.rejects(readWeiboFavoritePages({}, { account: async () => account, page: async () => finalPage({ navigationAccountIds: [account.id, '67890'], pageSelfAccountId: account.id }) }), /不唯一/);
});

test('Weibo page gaps remain partial and recent scope counts unavailable slots instead of fetching older replacements', async () => {
  let calls = 0;
  const gap = await readWeiboFavoritePages({}, { account: async () => account, page: async () => { calls++; return paged(1, 20, 8, { nextPage: 3 }); } });
  assert.equal(calls, 1); assert.equal(gap.target?.complete, false); assert.match(gap.target!.reason, /下一页链接不连续/);
  calls = 0;
  const recent = await readWeiboFavoritePages({ recentLimit: 3 }, { account: async () => account, page: async () => { calls++; const value = paged(1, 4, 2, { total: 4, nextPage: null, terminal: true }); value.slots.reverse(); return value; } });
  assert.equal(calls, 1); assert.equal(recent.items.length, 1); assert.equal(recent.target?.complete, true); assert.equal(recent.complete, false);
  assert.match(recent.target!.reason, /已检查 3 个槽位.*不可访问占位 2 条/);
});

test('Weibo cards keep canonical post identity and never invent favorite time', () => {
  const value = parseWeiboCard({ ...card('AbCd123'), url: 'https://weibo.com/12345/AbCd123?tracking=1' })!;
  assert.equal(value.sourceId, 'AbCd123'); assert.equal(value.url, 'https://weibo.com/12345/AbCd123'); assert.equal(value.collectedAt, null);
  assert.equal(parseWeiboCard({ ...card('a'), url: 'https://evil.test/12345/a' }), null);
  assert.equal(parseWeiboCard({ ...card('a'), url: 'https://weibo.com/u/12345' }), null);
});

test('Weibo whole-card previews remove verified header chrome and take a single body line before playback controls', () => {
  const original = { ...card('preview'), bodyFromCard: true, body: '作者\n2025-10-17\n来自 微博网页版\n已编辑\n关注\n这是一段真正的正文。\n后续正文\n播放视频\n01:20\n12.3万次播放\n转发\n评论' };
  const result = parseWeiboCard(original)!;
  assert.equal(result.title, '这是一段真正的正文。'); assert.equal(result.sourceId, 'preview');
  assert.match(original.body, /后续正文\n播放视频/, 'title generation must not mutate original card text');
  assert.equal(parseWeiboCard({ ...original, body: '作者\n24-3-5 08:40\n来自 iPhone客户端\n视频正文\n播放视频' })!.title, '视频正文');
});

test('Weibo title cleanup leaves structured source words and unverified prose intact, including UI-like words', () => {
  assert.equal(parseWeiboCard({ ...card('preview'), bodyFromCard: false, body: '来自朋友的建议\n关注长期价值' })!.title, '来自朋友的建议');
  assert.equal(parseWeiboCard({ ...card('preview'), bodyFromCard: true, body: '作者\n正文中的昨天\n来自正文的引文\n关注' })!.title, '作者');
  assert.equal(parseWeiboCard({ ...card('preview'), bodyFromCard: false, body: '<p>关注</p><p>2025-10-17</p><p>来自阅读</p>' })!.title, '关注');
  const long = parseWeiboCard({ ...card('preview'), body: '🧠'.repeat(121) })!.title;
  assert.equal(Array.from(long).length, 120); assert.equal(long.endsWith('🧠'), true);
});

test('Weibo real detail diagnostics expose media structure without source IDs, authors, body or URLs', () => {
  const entry = parseWeiboCard(card('secretPostId'))!;
  const diagnostic = weiboDetailEvidence(entry, { mblogid: entry.sourceId, text_raw: 'private original body', user: { id: 'secretAccount', screen_name: 'private author' },
    retweeted_status: { text: '<p>private retweet</p>', pic_num: 1, pic_ids: ['secretPictureId'], pic_infos: { secretPictureId: { largest: { url: 'https://private.invalid/image?token=privateSignature' } } },
      mix_media_info: { items: [{ id: 'privateMixedMedia' }] }, page_info: { type: 'video', media_info: { stream_url: 'https://private.invalid/video.mp4' } } } });
  const serialized = JSON.stringify(diagnostic);
  for (const sensitive of ['secretPostId', 'secretAccount', 'private author', 'private original body', 'private retweet', 'secretPictureId', 'private.invalid', 'privateSignature', 'privateMixedMedia']) assert.equal(serialized.includes(sensitive), false, sensitive);
  assert.equal(diagnostic.sourceIdentityMatches, true); assert.equal(diagnostic.retweetType, 'object');
  const parts = diagnostic.parts as Record<string, unknown>[];
  assert.equal(parts.length, 2); assert.equal(parts[1].role, 'retweet'); assert.equal(parts[1].picIdsCount, 1); assert.equal(parts[1].picInfosCount, 1);
  assert.equal(parts[1].originalUrlEntries, 1); assert.equal(parts[1].mixItemCount, 1); assert.equal(parts[1].mediaInfoPresent, true);
  const absent = weiboDetailEvidence(entry, { mblogid: entry.sourceId, text_raw: 'text only' });
  assert.equal(absent.retweetType, 'undefined'); assert.equal((absent.parts as unknown[]).length, 1);
});

test('Weibo collection reads continuous overlapping head to 100 without claiming complete history', async () => {
  let index = 0; let checks = 0;
  const result = await readWeiboFavorites({ recentLimit: 100, expectedAccountId: account.id }, {
    account: async () => { checks++; return account; }, first: async () => page(['p0', 'p1'], { atTop: true }),
    next: async () => { index++; return page([`p${index}`, `p${index + 1}`]); },
  });
  assert.equal(result.items.length, 100); assert.equal(result.target?.complete, true); assert.equal(result.complete, false);
  assert.equal(checks, 2); assert.equal(index, 98); assert.equal(new Set(result.items.map(item => item.sourceId)).size, 100);
});

test('Weibo missing head, gaps, malformed cards and uncertain empty pages remain partial', async () => {
  const gap = await readWeiboFavorites({ recentLimit: 3 }, { account: async () => account, first: async () => page(['a'], { atTop: true }), next: async () => page(['c']) });
  assert.deepEqual(gap.items.map(item => item.sourceId), ['a']); assert.equal(gap.target?.reliable, false);
  const malformed = await readWeiboFavorites({ recentLimit: 3 }, { account: async () => account, first: async () => page(['a'], { atTop: true, terminal: true, cards: [card('a'), { text: '正文身份丢失' }] }), next: async () => { throw Error('should stop'); } });
  assert.equal(malformed.target?.complete, false);
  const empty = await readWeiboFavorites({}, { account: async () => account, first: async () => page([], { atTop: true }), next: async () => page([]) });
  assert.equal(empty.complete, false); assert.equal(empty.target?.complete, false);
  const validEmpty = await readWeiboFavorites({}, { account: async () => account, first: async () => page([], { atTop: true, terminal: true, empty: true }), next: async () => { throw Error('should stop'); } });
  assert.equal(validEmpty.complete, true);
});

test('Weibo account changes fail before producing a snapshot', async () => {
  let checks = 0;
  await assert.rejects(readWeiboFavorites({ recentLimit: 1, expectedAccountId: account.id }, { account: async () => (++checks === 1 ? account : { ...account, id: '67890' }), first: async () => page(['a'], { atTop: true }), next: async () => page([]) }), /ACCOUNT_CHANGED/);
  await assert.rejects(readWeiboFavorites({}, { account: async () => account, first: async () => page(['a'], { atTop: true, accountId: '67890' }), next: async () => page([]) }), /ACCOUNT_CHANGED/);
});

test('Zhihu preserves large string IDs, type namespaces and only collection-entry timestamps', () => {
  const value = mapZhihuFavorite(answer('1937205528846655537'), '1')!;
  assert.equal(value.sourceId, 'answer:1937205528846655537'); assert.equal(value.collectedAt, null); assert.equal(value.publishedAt, 10_000);
  assert.equal(mapZhihuFavorite({ content: { type: 'answer', id: 9007199254740993 } }, '1'), null);
  assert.equal(mapZhihuFavorite({ content: { type: 'unsupported', id: '1' } }, '1'), null);
  assert.equal(mapZhihuFavorite({ content: { type: 'pin', id: '1', content: [{ type: 'video' }] } }, '1')?.kind, 'video');
  assert.throws(() => nextZhihuOffset({ paging: { next: 'https://evil.test/api/v4/collections/1/items?offset=20' } }, 0, '/api/v4/collections/1/items'));
  assert.throws(() => nextZhihuOffset({ paging: { next: 'https://www.zhihu.com/api/v4/collections/1/items?offset=0' } }, 0, '/api/v4/collections/1/items'));
  assert.throws(() => nextZhihuOffset({ data: [] }, 0, '/api/v4/collections/1/items'));
});

test('Zhihu merges all owned folders, keeps duplicate membership and ranks on explicit favorite time', async () => {
  const calls: string[] = [];
  const result = await readZhihuFavorites({ recentLimit: 3, expectedAccountId: account.id }, { account: async () => account, delay: noop, get: async path => {
    calls.push(path);
    if (path.includes('/people/')) return { data: [{ id: '1', title: '一' }, { id: '2', title: '二' }], paging: { is_end: true } };
    if (path.includes('/collections/1/')) return { data: [answer('1', 500), answer('2', 300), answer('3', 200)], paging: { is_end: true } };
    return { data: [answer('4', 600), answer('1', 500), answer('5', 100)], paging: { is_end: true } };
  } });
  assert.deepEqual(result.items.map(item => item.sourceId), ['answer:4', 'answer:1', 'answer:2']);
  assert.deepEqual(result.items[1].folderIds, ['1', '2']); assert.equal(result.target?.complete, true); assert.equal(result.complete, false); assert.equal(calls.length, 3);
});

test('Zhihu imports readable multi-folder candidates without claiming unprovable account-wide recency', async () => {
  const result = await readZhihuFavorites({ recentLimit: 2 }, { account: async () => account, delay: noop, get: async path => path.includes('/people/')
    ? { data: [{ id: '1' }, { id: '2' }], paging: { is_end: true } }
    : { data: [answer(path.includes('/1/') ? '1' : '3'), answer(path.includes('/1/') ? '2' : '4')], paging: { is_end: true } } });
  assert.equal(result.items.length, 2); assert.equal(result.target?.complete, false); assert.equal(result.target?.reliable, false); assert.match(result.warning!, /缺少可靠收藏时间/);
});

test('Zhihu missing pagination and changed account cannot be reported as a complete successful scope', async () => {
  const result = await readZhihuFavorites({ recentLimit: 2 }, { account: async () => account, delay: noop, get: async path => path.includes('/people/') ? { data: [{ id: '1' }], paging: { is_end: true } } : { data: [answer('1')] } });
  assert.equal(result.items.length, 1); assert.equal(result.target?.complete, false);
  let count = 0;
  await assert.rejects(readZhihuFavorites({}, { account: async () => ++count === 1 ? account : { ...account, id: 'other' }, delay: noop, get: async () => ({ data: [], paging: { is_end: true } }) }), /ACCOUNT_CHANGED/);
});

test('Weibo detail preserves full text and original images; missing long text/video never masquerades as offline complete', () => {
  const item = parseWeiboCard(card('AbCd123'))!;
  const raw = { mblogid: 'AbCd123', idstr: '12345678901234567890', text_raw: '正文', pic_num: 1, pic_ids: ['p1'], pic_infos: { p1: { largest: { url: 'https://wx1.sinaimg.cn/large/p1.jpg?signature=one' } } } };
  const full = readWeiboDetail(item, raw); assert.equal(full.bodyComplete, true); assert.equal(full.mediaManifestComplete, true); assert.equal(full.media.length, 1);
  const stable = readWeiboDetail(item, { ...raw, pic_infos: { p1: { largest: { url: 'https://wx1.sinaimg.cn/large/p1.jpg?signature=two' } } } });
  assert.equal(stable.media[0].resourceKey, full.media[0].resourceKey);
  assert.equal(readWeiboDetail(item, { ...raw, isLongText: true }).bodyComplete, false);
  assert.equal(readWeiboDetail(item, { ...raw, isLongText: true, __fullText: '完整正文', __longTextComplete: true }).bodyComplete, true);
  const video = readWeiboDetail({ ...item, kind: 'video' }, { ...raw, page_info: { type: 'video', media_info: { stream_url: 'https://f.video.weibocdn.com/a.m3u8' } } });
  assert.equal(video.mediaManifestComplete, false); assert.equal(video.availability, 'unsupported'); assert.equal(video.media.filter(value => value.kind === 'video').length, 0);
  assert.throws(() => readWeiboDetail(item, { ...raw, mblogid: 'different' }), /身份不一致/);
});

test('Zhihu detail captures body and original images but leaves protected and unsupported media incomplete', () => {
  const item = mapZhihuFavorite(answer('123'), '1')!;
  const result = readZhihuDetail(item, { id: '123', content: '<p>正文 &amp; 引用</p><script>bad()</script><img src="data:placeholder" data-original="https://picx.zhimg.com/real.jpg" />' });
  assert.equal(result.body, '正文 & 引用'); assert.equal(result.media.length, 1); assert.equal(result.mediaManifestComplete, true);
  assert.equal(readZhihuDetail(item, { id: '123', content: '付费预览', is_locked: true }).bodyComplete, false);
  assert.equal(readZhihuDetail(item, { id: '123', content: '<iframe src="https://www.zhihu.com/video/1"></iframe>' }).availability, 'unsupported');
  assert.equal(readZhihuDetail(item, { id: '123', content: '<img src="https://evil.test/photo.jpg">' }).mediaManifestComplete, false);
  assert.throws(() => readZhihuDetail(item, { id: '124', content: '其他正文' }), /身份不一致/);
  assert.equal(socialText('<p>标题</p><p>&#x4e2d;文</p>'), '标题\n中文');
});
