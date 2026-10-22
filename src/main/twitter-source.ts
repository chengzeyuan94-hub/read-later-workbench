import type { BrowserWindow, Session } from 'electron';
import { createHash } from 'node:crypto';
import type { CollectionItem, CollectionOptions, CollectionSnapshot, Connection, DetailResult, MediaDescriptor, Platform, RecentScopeEvidence, SourceAdapter } from '../shared/contracts.js';
import { SourceAccountVerificationCache } from './source-account-cache.js';
import { readTwitterArticle, twitterArticleEntity } from './twitter-article.js';

type Json = Record<string, any>;
const PLATFORM = 'twitter' as Platform;
const HOME = 'https://x.com/home', BOOKMARKS = 'https://x.com/i/bookmarks';
const METHOD = '应用内 X 会话 · 收藏页面只读响应';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const numericId = (value: unknown): string | null => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null;
const allowedPage = (raw: string): boolean => { try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname); } catch { return false; } };
const loginError = () => Error('LOGIN_REQUIRED：X 未登录或登录已过期，请在应用内完成登录');
const accountError = () => Error('ACCOUNT_CHANGED：X 当前账号与本次收藏范围不一致，请切回原账号');
function safeError(error: unknown): string { const text = error instanceof Error ? error.message : ''; if (/^(?:LOGIN_REQUIRED|ACCOUNT_CHANGED)：/.test(text) || /^X (?:收藏|页面|内容|采集|账号)/.test(text)) return text; return 'X 页面读取未完成，请检查登录、网络或平台访问限制后重试'; }

/** The cookie is read only inside the app and is never returned or logged. This
 * function returns only the numeric account identity, not authentication data. */
export function twitterAccountId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  try { return numericId(/^u=(\d+)$/.exec(decodeURIComponent(value))?.[1]); } catch { return null; }
}
export interface TwitterCapture { requestId: string; order: number; accountId: string; cursor: string; status?: number; failed?: boolean; payload?: Json }
/** Match the operation name of a request issued by X itself. No query ID,
 * bearer token, feature switches or cursor is invented or replayed by the app. */
export function twitterBookmarkRequest(requestId: string, order: number, accountId: string, request: Json): TwitterCapture | null {
  if (String(request.method).toUpperCase() !== 'GET' || !numericId(accountId)) return null;
  try {
    const u = new URL(String(request.url));
    if (!allowedPage(u.origin) || !/^\/i\/api\/graphql\/[^/]+\/Bookmarks\/?$/.test(u.pathname)) return null;
    const variables = JSON.parse(u.searchParams.get('variables') ?? 'null');
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return null;
    if (variables.userId != null && String(variables.userId) !== accountId) return null;
    if (variables.cursor != null && typeof variables.cursor !== 'string') return null;
    return {requestId,order,accountId,cursor:variables.cursor ?? ''};
  } catch { return null; }
}
function unwrapTweet(raw: Json | undefined): Json | null { if (!raw || typeof raw !== 'object') return null; return raw.__typename === 'TweetWithVisibilityResults' ? unwrapTweet(raw.tweet) : raw; }
function mediaUrl(value: unknown, kind: 'image' | 'video'): string | null { try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password && (kind === 'image' ? u.hostname === 'pbs.twimg.com' : u.hostname === 'video.twimg.com' && /\.mp4$/i.test(u.pathname)) ? u.toString() : null; } catch { return null; } }
function statusUrl(id: string, screenName?: string): string { return screenName && /^[A-Za-z0-9_]{1,50}$/.test(screenName) ? `https://x.com/${screenName}/status/${id}` : `https://x.com/i/web/status/${id}`; }
function unavailable(id: string): {item: CollectionItem; detail: DetailResult} { return {item:{sourceId:id,title:'不可访问的 X 收藏',author:'',url:statusUrl(id),kind:'text',collectedAt:null,folderIds:['bookmarks']},detail:{body:'',bodyComplete:false,bodyStatus:'unavailable',media:[],mediaManifestComplete:false,availability:'unavailable',manifestError:'X 内容已删除、不可访问或当前账号无权限',adapterVersion:3}}; }

export function readTwitterTweet(value: Json, fallbackId?: string, depth = 0): {item: CollectionItem; detail: DetailResult} | null {
  const raw = unwrapTweet(value); if (!raw) return null;
  const id = numericId(raw.rest_id) ?? numericId(raw.legacy?.id_str) ?? numericId(fallbackId);
  if (!id) return null;
  if (/Tombstone|Unavailable|Deleted/.test(String(raw.__typename))) return unavailable(id);
  const legacy = raw.legacy;
  if (!legacy || typeof legacy !== 'object') return null;
  const author = raw.core?.user_results?.result, screenName = String(author?.legacy?.screen_name ?? author?.core?.screen_name ?? '');
  const url = statusUrl(id, screenName), note = raw.note_tweet?.note_tweet_results?.result;
  let body = typeof note?.text === 'string' ? note.text : typeof legacy.full_text === 'string' ? legacy.full_text : typeof legacy.text === 'string' ? legacy.text : '';
  let bodyComplete = (typeof note?.text === 'string' || legacy.truncated !== true) && (typeof legacy.full_text === 'string' || typeof legacy.text === 'string' || typeof note?.text === 'string');
  const media: MediaDescriptor[] = [], problems: string[] = [], warnings: string[] = [];
  const mediaEntries = legacy.extended_entities?.media ?? legacy.entities?.media;
  if (mediaEntries !== undefined && !Array.isArray(mediaEntries)) problems.push('媒体清单结构未识别');
  for (const [order, entry] of (Array.isArray(mediaEntries) ? mediaEntries : []).entries()) {
    const mediaId = numericId(entry.id_str) ?? `${order}`, identity = `tweet:${id}:media:${mediaId}`;
    const image = mediaUrl(entry.media_url_https, 'image');
    if (entry.type === 'photo') {
      if (!image) { problems.push(`图片 ${order + 1} 未提供可保存的原图地址`); continue; }
      media.push({kind:'image',remoteUrl:image,referer:url,role:'gallery',order,title:`图片 ${order + 1}`,sourceIdentity:identity,version:`image:${hash(new URL(image).pathname + new URL(image).search)}`,resourceKey:`twitter:${id}:${identity}:image`});
    } else if (entry.type === 'video' || entry.type === 'animated_gif') {
      if (image) media.push({kind:'image',remoteUrl:image,referer:url,role:'cover',order,title:`视频 ${order + 1} 封面`,sourceIdentity:`${identity}:cover`,version:'source-cover',resourceKey:`twitter:${id}:${identity}:cover`});
      const variants: Json[] = Array.isArray(entry.video_info?.variants) ? entry.video_info.variants : [];
      const selected = variants.filter(v=>v.content_type==='video/mp4' && mediaUrl(v.url,'video')).sort((a,b)=>(Number(b.bitrate)||0)-(Number(a.bitrate)||0))[0];
      if (!selected) { problems.push(`视频 ${order + 1} 未提供完整 MP4，HLS／外链播放器暂不保存`); continue; }
      const remoteUrl = mediaUrl(selected.url,'video')!, duration = Number(entry.video_info?.duration_millis);
      media.push({kind:'video',remoteUrl,referer:url,mime:'video/mp4',role:entry.type==='animated_gif'?'animation':'main',order,title:entry.type==='animated_gif'?`动画 ${order + 1}（可能无音轨）`:`视频 ${order + 1}`,sourceIdentity:identity,version:`mp4:${Number(selected.bitrate)||0}:${hash(new URL(remoteUrl).pathname)}`,resourceKey:`twitter:${id}:${identity}:mp4:${Number(selected.bitrate)||0}`,...(Number.isFinite(duration)&&duration>0?{durationSeconds:duration/1000}:{})});
    } else problems.push(`媒体 ${order + 1} 类型暂不支持`);
  }
  // E4.12: an X Article's full body is Draft.js content_state / plain_text on
  // the article entity. A complete parse contributes the body and its images;
  // a summary-only entity keeps the item honestly incomplete.
  let articleTitle = '';
  const articleEntity = twitterArticleEntity(raw);
  if (articleEntity) {
    const article = readTwitterArticle(articleEntity);
    if (article.complete) {
      articleTitle = article.title;
      const own = body.trim();
      body = own === '' || /^https?:\/\/t\.co\/\S+$/i.test(own) ? article.markdown : `${own}\n\n${article.markdown}`;
      for (const [index, image] of article.images.entries()) {
        const remote = mediaUrl(image.url, 'image');
        if (!remote) { warnings.push(`文章图片 ${index + 1} 来源不支持保存`); continue; }
        const identity = `tweet:${id}:article:${image.key}`;
        media.push({kind:'image',remoteUrl:remote,referer:url,role:'article',order:media.length,title:`文章图片 ${index + 1}`,sourceIdentity:identity,version:`image:${hash(new URL(remote).pathname + new URL(remote).search)}`,resourceKey:`twitter:${id}:${identity}:image`});
      }
    } else {
      bodyComplete = false;
      problems.push(article.reason ?? 'X 长文章只有摘要，完整文章正文尚未取得');
    }
  }
  if (raw.card?.legacy?.name && /player|video|broadcast/i.test(String(raw.card.legacy.name)) && !media.some(m=>m.kind==='video')) problems.push('嵌入播放器未提供本地可保存的完整媒体');
  // E4.9: an unreadable quoted tweet (tombstone / deleted / protected /
  // incomplete / missing result / nested past the depth limit) never decides the
  // own tweet's completeness. The body and media of the tweet itself set the
  // flags; the missing quote becomes an honest note plus a manifest warning.
  const quoted = raw.quoted_status_result?.result;
  const quotedId = numericId(legacy.quoted_status_id_str);
  const unreadableQuote = () => {
    warnings.push('引用帖未完整取得');
    body += `\n\n（引用的帖子无法取得：已删除、受保护或暂不可读）${quotedId ? `\n原帖：${statusUrl(quotedId)}` : ''}`;
  };
  if (quoted && depth < 2) {
    const quote = readTwitterTweet(quoted, quotedId ?? undefined, depth + 1);
    if (quote && quote.detail.bodyComplete) { body += `\n\n引用 ${quote.item.author || '原作者'}：\n${quote.detail.body}\n来源：${quote.item.url}`; for(const m of quote.detail.media) media.push({...m,order:media.length}); if(!quote.detail.mediaManifestComplete)problems.push('引用帖媒体未完整取得'); }
    else unreadableQuote();
  } else if (quoted || legacy.is_quote_status === true) unreadableQuote();
  if (raw.retweeted_status_result?.result || legacy.retweeted_status_result?.result) { bodyComplete=false;problems.push('转发包装内容需取得原帖完整正文'); }
  if (legacy.truncated === true && typeof note?.text !== 'string') problems.push('正文仍为截断摘要');
  const published = Date.parse(String(legacy.created_at ?? ''));
  const kind = media.some(m=>m.kind==='video') ? 'video' : media.some(m=>m.kind==='image') ? 'image' : 'text';
  return {item:{sourceId:id,title:Array.from((articleTitle || body.trim().split('\n')[0].replace(/^#{1,3}\s+/,'') || 'X 收藏')).slice(0,100).join(''),author:screenName?`@${screenName}`:String(author?.legacy?.name??author?.core?.name??''),url,kind,publishedAt:Number.isFinite(published)?published:null,collectedAt:null,folderIds:['bookmarks']},detail:{body,bodyComplete,bodyStatus:bodyComplete?'valid':'unavailable',subtitleStatus:'unavailable',media,mediaManifestComplete:problems.length===0,availability:problems.some(p=>/MP4|播放器|类型暂不支持/.test(p))?'unsupported':'available',...(problems.length||warnings.length?{manifestError:[...problems,...warnings].join('；')} : {}),adapterVersion:3,...(Number.isFinite(published)?{publishedAt:published}:{})}};
}

interface TwitterPage {items: {item:CollectionItem;detail:DetailResult}[]; next:string|null; terminal:boolean; parsed:boolean; reason:string}
export function parseTwitterBookmarkPage(capture: TwitterCapture): TwitterPage {
  const bad = (reason:string):TwitterPage => ({items:[],next:null,terminal:false,parsed:false,reason});
  if (capture.failed || capture.status!==200 || !capture.payload) return bad('X 收藏响应未完成或受到访问限制');
  if (Array.isArray(capture.payload.errors) && capture.payload.errors.length) return bad('X 收藏响应包含错误，未视为完整分页');
  const data=capture.payload.data, instructions=data?.bookmark_timeline_v2?.timeline?.instructions ?? data?.bookmark_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) return bad('X 收藏分页结构尚未识别');
  const entries:Json[]=[], items:TwitterPage['items']=[];let terminal=false,sawEntries=false;
  for(const instruction of instructions){
    if(instruction.type==='TimelineAddEntries' && Array.isArray(instruction.entries)){entries.push(...instruction.entries);sawEntries=true;}
    else if(instruction.type==='TimelineReplaceEntry' && instruction.entry)entries.push(instruction.entry);
    else if(instruction.type==='TimelineTerminateTimeline' && instruction.direction==='Bottom')terminal=true;
  }
  if(!sawEntries&&!terminal)return bad('X 收藏响应缺少明确列表');
  let next:string|null=null;
  for(const entry of entries){
    const content=entry.content??{}, cursor=content.cursorType;
    if(cursor==='Bottom'){if(typeof content.value!=='string'||!content.value)return bad('X 下一页游标无效');next=content.value;continue;}
    if(cursor==='Top')continue;
    const subentries=Array.isArray(content.items)?content.items.map((part:Json)=>({entryId:part.entryId,itemContent:part.item?.itemContent??part.itemContent})): [{entryId:entry.entryId,itemContent:content.itemContent}];
    for(const sub of subentries){const itemContent=sub.itemContent;
      if(itemContent?.promotedMetadata)continue;
      const fallback=/^(?:tweet|tweetdetail)-(\d+)$/.exec(String(sub.entryId))?.[1];
      if(!itemContent?.tweet_results?.result)return bad(fallback?'X 收藏条目未提供完整身份':'X 收藏列表含未识别条目，未确认本页完整');
      const tweet=readTwitterTweet(itemContent.tweet_results.result,fallback);if(!tweet)return bad('X 收藏条目无法解析');items.push(tweet);
    }
  }
  if(new Set(items.map(t=>t.item.sourceId)).size!==items.length)return bad('X 同页内容重复，暂不确认顺序');
  if(terminal)next=null;else if(next===null)return bad('X 收藏响应没有下一页游标或明确结束标志');
  if(!terminal&&next===capture.cursor)return bad('X 分页游标未前进');
  return{items,next,terminal,parsed:true,reason:''};
}
export function assembleTwitterBookmarks(accountId:string,captures:TwitterCapture[]):{items:CollectionItem[];details:Map<string,DetailResult>;complete:boolean;evidence:RecentScopeEvidence;warning?:string}{
  const candidates=new Map<string,TwitterCapture[]>();for(const c of captures.filter(c=>c.accountId===accountId).sort((a,b)=>a.order-b.order))candidates.set(c.cursor,[...(candidates.get(c.cursor)??[]),c]);
  const items:CollectionItem[]=[],details=new Map<string,DetailResult>(),pages:RecentScopeEvidence['pages']=[],visited=new Set<string>();let cursor='',complete=false,warning='';
  while(!visited.has(cursor)){visited.add(cursor);const capturesAt=candidates.get(cursor);if(!capturesAt?.length){warning=cursor===''?'X 收藏首屏未取得':'X 收藏分页未连续取得';break;}
    const parsed=capturesAt.map(parseTwitterBookmarkPage),page=parsed[0];
    if(parsed.some(p=>!p.parsed)||parsed.some(p=>JSON.stringify([p.items.map(t=>t.item.sourceId),p.next,p.terminal])!==JSON.stringify([page.items.map(t=>t.item.sourceId),page.next,page.terminal]))){warning=page.reason||'X 重复分页结果不一致';break;}
    if(page.items.some(t=>details.has(t.item.sourceId))){warning='X 分页内容重叠，保留此前连续范围';break;}
    pages.push({cursor,nextCursor:page.next,ids:page.items.map(t=>t.item.sourceId),parsed:true});for(const t of page.items){items.push(t.item);details.set(t.item.sourceId,t.detail);}
    if(page.terminal){complete=true;break;}cursor=page.next!;
  }
  if(!complete&&!warning)warning='X 分页游标循环，未声称完整历史';
  return{items,details,complete,evidence:{scopeId:'bookmarks',reliable:pages.length>0,orderedIds:items.map(item=>item.sourceId),sort:pages.length?'collection-order':'unknown',reason:warning||'按当前账号收藏页的实际顺序；未提供可靠收藏时间',pages},...(warning?{warning}:{})};
}
/** Reaching the requested recent prefix is distinct from reading all history. */
export function twitterCollectionSnapshot(accountId:string,accountName:string,result:ReturnType<typeof assembleTwitterBookmarks>,limit:number,limited?:string):CollectionSnapshot{
  const target=result.items.slice(0,limit),targetComplete=result.evidence.reliable&&(target.length>=limit||result.complete),historyComplete=result.complete&&result.items.length<=limit;
  const reason=limited??(targetComplete&&!historyComplete?`当前账号最近 ${limit} 条收藏已取得；未同步完整历史`:result.evidence.reason);
  const warning=targetComplete&&result.warning==='X 收藏分页未连续取得'?undefined:result.warning;
  return{platform:PLATFORM,accountId,accountName,folders:[{id:'bookmarks',title:'X 收藏'}],items:target,complete:limited?false:historyComplete,recent:{scopes:[{...result.evidence,reason}]},target:{limit,complete:limited?false:targetComplete,reliable:result.evidence.reliable,reason},...(warning?{warning}:{}) ,...(limited?{limited}:{})};
}

export interface TwitterSourceOptions {sessionFor?:(platform:Platform)=>Session;probeOnStart?:boolean}
export interface TwitterSources {adapters:SourceAdapter[];login(platform?:Platform):Promise<void>;connections():Connection[];dispose():void}
/** Pure helpers above remain testable without importing or launching Electron. */
export async function createTwitterSources(options:TwitterSourceOptions={}):Promise<TwitterSources>{
  const {BrowserWindow:Window,session}=await import('electron');
  const sourceSession=options.sessionFor?.(PLATFORM)??session.fromPartition('persist:rlw-twitter');
  const accounts=new SourceAccountVerificationCache();accounts.watch(PLATFORM,sourceSession.cookies);
  const windows=new Set<BrowserWindow>(),timers=new Set<ReturnType<typeof setInterval>>(),details=new Map<string,DetailResult>();
  let connection:Connection={platform:PLATFORM,state:'disconnected',message:'请在应用内完成 X 登录',method:METHOD},disposed=false,collecting=false,loginWindow:BrowserWindow|undefined;
  const updateError=(error:unknown)=>{accounts.invalidate(PLATFORM);const message=safeError(error);connection={platform:PLATFORM,state:message.includes('LOGIN_REQUIRED')?'expired':'error',message,method:METHOD};};
  function makeWindow(show=false):BrowserWindow{
    if(disposed)throw Error('X 采集会话已关闭');const win=new Window({width:1100,height:820,show,title:'X（推特） · 应用内登录',webPreferences:{session:sourceSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});windows.add(win);
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/\S+/g,'').replace(/\sread-later-workbench\/\S+/g,''));
    win.webContents.setWindowOpenHandler(({url})=>{if(allowedPage(url))void win.loadURL(url).catch(()=>{});return{action:'deny'};});
    win.webContents.on('will-navigate',(event,url)=>{if(!allowedPage(url))event.preventDefault();});win.webContents.on('will-redirect',(event,url)=>{if(!allowedPage(url))event.preventDefault();});
    win.on('closed',()=>{windows.delete(win);if(loginWindow===win)loginWindow=undefined;});return win;
  }
  async function navigate(win:BrowserWindow,url:string):Promise<void>{
    await new Promise<void>((resolve,reject)=>{let done=false;const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(timeout);if(!win.webContents.isDestroyed())win.webContents.removeListener('dom-ready',ready);win.removeListener('closed',closed);error?reject(Error('X 页面加载未完成，请检查网络和平台登录')):resolve();},ready=()=>finish(),closed=()=>finish(Error());const timeout=setTimeout(()=>finish(Error()),45000);timeout.unref();win.webContents.once('dom-ready',ready);win.once('closed',closed);void win.loadURL(url).catch(finish);});
  }
  async function cookieAccount():Promise<string>{const cookies=await sourceSession.cookies.get({url:'https://x.com',name:'twid'}),ids=[...new Set(cookies.map(c=>twitterAccountId(c.value)).filter((id):id is string=>!!id))];if(ids.length!==1)throw loginError();return ids[0];}
  async function account(win:BrowserWindow,expected?:string):Promise<{id:string;name:string}>{
    const id=await cookieAccount();
    const page=await win.webContents.executeJavaScript(`(() => { const profile=document.querySelector('[data-testid="AppTabBar_Profile_Link"]'); const switcher=document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'); return {sessionId:String(window.__INITIAL_STATE__?.session?.user_id||''),loggedIn:!!profile&&!!switcher,name:(switcher?.innerText||profile?.getAttribute('href')||'').slice(0,160)}; })()`) as {sessionId:string;loggedIn:boolean;name:string};
    if(!page.loggedIn)throw loginError();if(page.sessionId&&page.sessionId!==id||expected&&id!==expected)throw accountError();
    connection={platform:PLATFORM,state:'connected',accountName:page.name||'X 已登录账号',verifiedAt:Date.now(),message:'应用内账号已核验；只读取收藏与内容',method:METHOD};return{id,name:page.name||id};
  }
  async function readyAccount(win:BrowserWindow,expected?:string){for(let i=0;i<12;i++){try{return await account(win,expected);}catch(error){if(safeError(error).includes('ACCOUNT_CHANGED'))throw error;if(i===11)throw error;await wait(500);}}throw loginError();}
  async function verifyAccount(expected:string):Promise<void>{try{await accounts.verify(PLATFORM,expected,async beginInspection=>{const win=makeWindow();try{await navigate(win,HOME);beginInspection();return(await readyAccount(win,expected)).id;}finally{if(!win.isDestroyed())win.close();}});}catch(error){updateError(error);throw Error(safeError(error));}}
  async function collect(options:CollectionOptions={}):Promise<CollectionSnapshot>{
    if(collecting)throw Error('X 收藏正在同步，请等待当前任务完成');if(options.fullHistory&&options.recentLimit!==undefined)throw Error('同步范围参数互斥');const limit=options.fullHistory?5000:(options.recentLimit??100);if(!Number.isSafeInteger(limit)||limit<1)throw Error('X 收藏同步数量无效');if(!options.fullHistory&&limit>100)throw Error('X 收藏同步数量须为 1 至 100');collecting=true;
    const win=makeWindow(),captures=new Map<string,TwitterCapture>(),pending=new Set<Promise<void>>();let order=0,owner:{id:string;name:string}|undefined;
    try{
      await navigate(win,HOME);owner=await readyAccount(win,options.expectedAccountId);
      win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Network.enable');await win.webContents.debugger.sendCommand('Network.setCacheDisabled',{cacheDisabled:true});
      win.webContents.debugger.on('message',(_event,method:string,params:Json)=>{
        const requestId=String(params.requestId);
        if(method==='Network.requestWillBeSent'){const c=twitterBookmarkRequest(requestId,order++,owner!.id,params.request??{});if(c)captures.set(requestId,c);return;}
        const capture=captures.get(requestId);if(!capture)return;
        if(method==='Network.responseReceived')capture.status=Number(params.response?.status);
        if(method==='Network.loadingFailed')capture.failed=true;
        if(method!=='Network.loadingFinished')return;
        const task=win.webContents.debugger.sendCommand('Network.getResponseBody',{requestId}).then((response:Json)=>{const body=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;if(typeof body!=='string'||Buffer.byteLength(body)>16*1024*1024)throw Error();capture.payload=JSON.parse(body);}).catch(()=>{capture.failed=true;});pending.add(task);void task.finally(()=>pending.delete(task));
      });
      await navigate(win,BOOKMARKS);await wait(1500);let result=assembleTwitterBookmarks(owner.id,[]),idle=0,prior=-1,limited:string|undefined;
      for(let round=0,maxRounds=options.fullHistory?300:45;round<maxRounds;round++){
        await Promise.all([...pending]);result=assembleTwitterBookmarks(owner.id,[...captures.values()]);
        if([...captures.values()].some(c=>c.status===401))throw loginError();
        // E4.7: a mid-capture rate limit keeps the partial result; the service cools down.
        if([...captures.values()].some(c=>[403,429].includes(c.status??0))){limited='X 收藏读取受到平台限流或访问限制，请稍后重试';break;}
        if(result.complete||result.evidence.reliable&&result.items.length>=limit)break;
        idle=result.items.length===prior?idle+1:0;prior=result.items.length;if(idle>=6)break;
        await win.webContents.executeJavaScript(`(() => { window.scrollTo(0,document.documentElement.scrollHeight); for(const element of document.querySelectorAll('main [style*="overflow"]'))if(element.scrollHeight>element.clientHeight+20)element.scrollTop=element.scrollHeight; })()`);await wait(1000);
      }
      await account(win,owner.id);const target=result.items.slice(0,limit);for(const item of target){const detail=result.details.get(item.sourceId);if(detail)details.set(`${owner.id}:${item.sourceId}`,detail);}
      return twitterCollectionSnapshot(owner.id,owner.name,result,limit,limited);
    }catch(error){updateError(error);throw Error(safeError(error));}finally{collecting=false;if(!win.isDestroyed()){try{if(win.webContents.debugger.isAttached())win.webContents.debugger.detach();}catch{}win.close();}}
  }
  async function detail(item:CollectionItem,options:{expectedAccountId?:string}={}):Promise<DetailResult>{
    const expected=options.expectedAccountId??await cookieAccount();
    const key=`${expected}:${item.sourceId}`,cached=details.get(key);details.delete(key);
    if(!numericId(item.sourceId))throw Error('X 内容身份无效');const win=makeWindow(),tweets:Json[]=[],pending=new Set<Promise<void>>(),ids=new Set<string>();
    try{
      // Detail identity is checked live. Only the media dispatch gate may use
      // the short cookie-invalidated account cache.
      await navigate(win,HOME);await readyAccount(win,expected);
      // Consume a fresh collection result once. A later media refresh must
      // visit the actual post again rather than reuse an expired URL forever.
      if(cached&&cached.bodyComplete&&cached.mediaManifestComplete)return structuredClone(cached);
      const articles=new Map<string,Json>();let articlePhase=false;
      win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Network.enable');
      win.webContents.debugger.on('message',(_event,method:string,p:Json)=>{
        if(method==='Network.requestWillBeSent'){try{const u=new URL(p.request?.url);const graphql=p.request?.method==='GET'&&allowedPage(u.origin)&&/^\/i\/api\/graphql\/[^/]+\/[^/]+\/?$/.test(u.pathname);if(!graphql)return;if(articlePhase){ids.add(String(p.requestId));return;}if(!/\/Tweet(?:Detail|ResultByRestId)\/?$/.test(u.pathname))return;const v=JSON.parse(u.searchParams.get('variables')??'{}');if(String(v.focalTweetId??v.tweetId)!==item.sourceId)return;ids.add(String(p.requestId));}catch{}return;}
        if(method!=='Network.loadingFinished'||!ids.has(String(p.requestId)))return;
        const task=win.webContents.debugger.sendCommand('Network.getResponseBody',{requestId:String(p.requestId)}).then((r:Json)=>{const text=r.base64Encoded?Buffer.from(r.body,'base64').toString('utf8'):r.body;if(typeof text!=='string'||Buffer.byteLength(text)>16*1024*1024)return;const payload=JSON.parse(text);const visit=(value:any,depth=0)=>{if(!value||typeof value!=='object'||depth>20)return;if(numericId(value.rest_id)===item.sourceId&&value.legacy) tweets.push(value);const articleId=numericId(value.rest_id);if(articleId&&((value.content_state&&typeof value.content_state==='object')||typeof value.plain_text==='string'&&value.plain_text))articles.set(articleId,value);for(const v of Object.values(value))if(v&&typeof v==='object')visit(v,depth+1);};visit(payload);}).catch(()=>{});pending.add(task);void task.finally(()=>pending.delete(task));
      });
      await navigate(win,statusUrl(item.sourceId));for(let i=0;i<12;i++){await wait(500);await Promise.all([...pending]);if(tweets.length)break;}
      await readyAccount(win,expected);
      // A standalone article entity captured anywhere in the responses merges
      // back into the tweet it belongs to before parsing.
      const parseAll=()=>tweets.map(raw=>{
        const entity=twitterArticleEntity(raw);
        if(entity){const artId=numericId(entity.rest_id);const found=artId?articles.get(artId):undefined;if(found&&!readTwitterArticle(entity).complete)return readTwitterTweet({...raw,article:{...(raw.article??{}),article_results:{result:found}}},item.sourceId);}
        return readTwitterTweet(raw,item.sourceId);
      }).filter((x):x is NonNullable<typeof x>=>x!==null);
      const choose=()=>{const parsed=parseAll();return parsed.find(t=>t.detail.bodyComplete&&t.detail.mediaManifestComplete)??parsed[0];};
      let result=choose();
      // E4.12: when the permalink payload only carries the article summary, the
      // article view itself is opened once so X's own request returns the body.
      const summaryOnly=(raw:Json)=>{const entity=twitterArticleEntity(raw);return!!entity&&!readTwitterArticle(entity).complete;};
      if(result&&!result.detail.bodyComplete&&tweets.some(summaryOnly)){
        const raw=tweets.find(summaryOnly)!,entity=twitterArticleEntity(raw)!,artId=numericId(entity.rest_id);
        const author=raw.core?.user_results?.result,screen=String(author?.legacy?.screen_name??author?.core?.screen_name??'');
        const articleUrl=artId?`https://x.com/i/article/${artId}`:/^[A-Za-z0-9_]{1,50}$/.test(screen)?`https://x.com/${screen}/article/${item.sourceId}`:null;
        if(articleUrl&&allowedPage(articleUrl)){
          articlePhase=true;
          try{await navigate(win,articleUrl);for(let i=0;i<16;i++){await wait(500);await Promise.all([...pending]);const again=choose();if(again)result=again;if(again&&again.detail.bodyComplete)break;}}
          catch{/* 文章页不可用时保留已有的摘要结果 */}
          finally{articlePhase=false;}
          await readyAccount(win,expected);
        }
      }
      if(result)return result.detail;
      if(cached)return structuredClone(cached);
      throw Error('X 内容详情未取得可验证的正文与媒体，请在原页面确认访问状态后重试');
    }catch(error){updateError(error);throw Error(safeError(error));}finally{if(!win.isDestroyed()){try{win.webContents.debugger.detach();}catch{}win.close();}}
  }
  async function login(platform:Platform=PLATFORM):Promise<void>{if(platform!==PLATFORM)throw Error('X 采集器只管理 X 登录');if(loginWindow&&!loginWindow.isDestroyed()){loginWindow.show();loginWindow.focus();return;}const win=makeWindow(true);loginWindow=win;await navigate(win,BOOKMARKS);let checking=false;const timer=setInterval(()=>{if(win.isDestroyed()){clearInterval(timer);timers.delete(timer);return;}if(checking)return;checking=true;void account(win).catch(()=>{}).finally(()=>{checking=false;});},2000);timer.unref();timers.add(timer);}
  if(options.probeOnStart){const win=makeWindow();void navigate(win,HOME).then(()=>readyAccount(win)).catch(updateError).finally(()=>{if(!win.isDestroyed())win.close();});}
  return{adapters:[{platform:PLATFORM,collect,detail,verifyAccount}],login,connections:()=>[{...connection}],dispose(){disposed=true;accounts.dispose();for(const timer of timers)clearInterval(timer);for(const win of windows)if(!win.isDestroyed())win.close();timers.clear();windows.clear();details.clear();}};
}
