import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleTwitterBookmarks, parseTwitterBookmarkPage, readTwitterTweet, twitterAccountId, twitterBookmarkRequest, twitterCollectionSnapshot, type TwitterCapture } from '../src/main/twitter-source.js';

const account='123456789';
function tweet(id:string,text=`正文 ${id}`):any{return{__typename:'Tweet',rest_id:id,core:{user_results:{result:{legacy:{name:'作者',screen_name:'author'}}}},legacy:{id_str:id,full_text:text,truncated:false,created_at:'Wed Oct 14 10:00:00 +0000 2026',entities:{}}};}
function page(cursor:string,ids:string[],next:string|null,order=0):TwitterCapture{return{requestId:`request-${order}`,order,accountId:account,cursor,status:200,payload:{data:{bookmark_timeline_v2:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[...ids.map(id=>({entryId:`tweet-${id}`,content:{itemContent:{tweet_results:{result:tweet(id)}}}})),...(next?[{entryId:'cursor-bottom-1',content:{cursorType:'Bottom',value:next}}]:[])]},...(next===null?[{type:'TimelineTerminateTimeline',direction:'Bottom'}]:[])]}}}}};}

test('X account uses actual numeric twid identity, not a post author or arbitrary cookie value',()=>{
  assert.equal(twitterAccountId('u%3D123456789'),account);assert.equal(twitterAccountId('u=123456789'),account);
  for(const value of ['guest','auth-token','u=author','123456789','u%3D123%0A','%',null,123])assert.equal(twitterAccountId(value),null);
});

test('capture only accepts the actual read-only Bookmarks request and never guesses a query ID',()=>{
  const url='https://x.com/i/api/graphql/observed-query-id/Bookmarks?variables='+encodeURIComponent(JSON.stringify({count:20}));
  assert.deepEqual(twitterBookmarkRequest('a',1,account,{method:'GET',url}),{requestId:'a',order:1,accountId:account,cursor:''});
  assert.equal(twitterBookmarkRequest('a',1,account,{method:'POST',url}),null);
  assert.equal(twitterBookmarkRequest('a',1,account,{method:'GET',url:url.replace('/Bookmarks','/CreateBookmark')}),null);
  assert.equal(twitterBookmarkRequest('a',1,account,{method:'GET',url:url.replace('x.com','x.com.attacker.invalid')}),null);
  assert.equal(twitterBookmarkRequest('a',1,account,{method:'GET',url:'https://x.com/i/api/graphql/id/Bookmarks'}),null);
  assert.equal(twitterBookmarkRequest('a',1,account,{method:'GET',url:'https://x.com/i/api/graphql/id/Bookmarks?variables='+encodeURIComponent(JSON.stringify({userId:'987'}))}),null);
});

test('X bookmarks follow first-page and exact cursor chain despite out-of-order responses',()=>{
  const result=assembleTwitterBookmarks(account,[page('next',['3'],null,2),page('',['1','2'],'next',1)]);
  assert.equal(result.complete,true);assert.deepEqual(result.items.map(item=>item.sourceId),['1','2','3']);assert.equal(result.evidence.reliable,true);
  assert.deepEqual(result.items.map(item=>item.collectedAt),[null,null,null]);assert.equal(result.evidence.sort,'collection-order');
});

test('recent target completion does not display a missing-history-page warning or claim complete history',()=>{
  const ids=Array.from({length:100},(_,i)=>String(i+1));
  const result=assembleTwitterBookmarks(account,[page('',ids,'unread-tail')]);
  const snapshot=twitterCollectionSnapshot(account,'X account',result,100);
  assert.equal(snapshot.target?.complete,true);assert.equal(snapshot.complete,false);assert.equal(snapshot.warning,undefined);
  assert.match(snapshot.target!.reason,/最近 100 条收藏已取得/);assert.match(snapshot.target!.reason,/未同步完整历史/);
  assert.equal(snapshot.recent!.scopes[0].reason,snapshot.target!.reason);
  const partial=twitterCollectionSnapshot(account,'X account',assembleTwitterBookmarks(account,[page('',['1'],'unread-tail')]),100);
  assert.equal(partial.target?.complete,false);assert.equal(partial.warning,'X 收藏分页未连续取得');
  const all=twitterCollectionSnapshot(account,'X account',assembleTwitterBookmarks(account,[page('',['1'],null)]),100);
  assert.equal(all.complete,true);assert.equal(all.target?.complete,true);
});

test('missing head, failed tail, duplicate inconsistency and other account do not create false complete scope',()=>{
  assert.equal(assembleTwitterBookmarks(account,[page('next',['2'],null)]).evidence.reliable,false);
  const other=page('',['9'],null);other.accountId='999';assert.deepEqual(assembleTwitterBookmarks(account,[other]).items,[]);
  const failed=page('next',['3'],null,2);failed.status=429;const partial=assembleTwitterBookmarks(account,[page('',['1','2'],'next',1),failed]);assert.equal(partial.complete,false);assert.deepEqual(partial.items.map(item=>item.sourceId),['1','2']);
  assert.equal(assembleTwitterBookmarks(account,[page('',['1'],null),page('',['2'],null,1)]).evidence.reliable,false);
  assert.equal(assembleTwitterBookmarks(account,[page('',['1'],'next'),page('next',['1'],null,1)]).complete,false);
});

test('explicit end can terminate an empty timeline; missing cursors and unknown entries cannot invent completion',()=>{
  assert.equal(parseTwitterBookmarkPage(page('',[],null)).terminal,true);
  for(const ids of [[],['1']]){const noEnd=page('',ids,null);noEnd.payload!.data.bookmark_timeline_v2.timeline.instructions.pop();assert.equal(parseTwitterBookmarkPage(noEnd).parsed,false);}
  for(const content of [{itemContent:{itemType:'UnrecognizedContent'}},{cursorType:'Unsupported',value:'cursor'}]){const unknown=page('',[],null);unknown.payload!.data.bookmark_timeline_v2.timeline.instructions[0].entries.push({entryId:'unknown-thing',content});assert.equal(parseTwitterBookmarkPage(unknown).parsed,false);assert.equal(assembleTwitterBookmarks(account,[unknown]).evidence.reliable,false);}
  const broken=page('',['1'],null);broken.payload!.errors=[{message:'not logged in'}];assert.equal(parseTwitterBookmarkPage(broken).parsed,false);
  const absent=page('',['1'],null);absent.payload={data:{}};assert.equal(parseTwitterBookmarkPage(absent).parsed,false);
  const invalid=page('',['1'],null);invalid.payload!.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result={};assert.equal(parseTwitterBookmarkPage(invalid).parsed,false);
});

test('tweet detail prefers full note text; text-only source does not invent media or bookmark time',()=>{
  const raw=tweet('100','摘要');raw.legacy.truncated=true;raw.note_tweet={note_tweet_results:{result:{text:'长正文完整内容\n第二段'}}};
  const result=readTwitterTweet(raw)!;assert.equal(result.detail.body,'长正文完整内容\n第二段');assert.equal(result.detail.bodyComplete,true);assert.equal(result.detail.mediaManifestComplete,true);assert.deepEqual(result.detail.media,[]);assert.equal(result.item.kind,'text');assert.equal(result.item.author,'@author');assert.equal(result.item.url,'https://x.com/author/status/100');
});

test('photo and MP4 descriptors preserve media identity, use real variants and retain full known duration',()=>{
  const raw=tweet('101');raw.legacy.extended_entities={media:[{id_str:'801',type:'photo',media_url_https:'https://pbs.twimg.com/media/photo.jpg'},{id_str:'802',type:'video',media_url_https:'https://pbs.twimg.com/media/cover.jpg',video_info:{duration_millis:142500,variants:[{content_type:'application/x-mpegURL',url:'https://video.twimg.com/a.m3u8'},{content_type:'video/mp4',bitrate:256000,url:'https://video.twimg.com/vid/small.mp4'},{content_type:'video/mp4',bitrate:832000,url:'https://video.twimg.com/vid/large.mp4'}]}}]};
  const result=readTwitterTweet(raw)!;assert.equal(result.item.kind,'video');assert.equal(result.detail.mediaManifestComplete,true);assert.equal(result.detail.media.length,3);const video=result.detail.media.find(m=>m.kind==='video')!;assert.equal(video.remoteUrl,'https://video.twimg.com/vid/large.mp4');assert.equal(video.durationSeconds,142.5);assert.equal(video.sourceIdentity,'tweet:101:media:802');
});

test('HLS-only, untrusted media hosts, articles and truncated text are explicitly incomplete',()=>{
  const raw=tweet('102');raw.legacy.extended_entities={media:[{type:'video',id_str:'8',media_url_https:'https://pbs.twimg.com/media/cover.jpg',video_info:{variants:[{content_type:'application/x-mpegURL',url:'https://video.twimg.com/a.m3u8'}]}}]};const hls=readTwitterTweet(raw)!;assert.equal(hls.detail.mediaManifestComplete,false);assert.equal(hls.detail.availability,'unsupported');assert.equal(hls.detail.media.filter(m=>m.kind==='video').length,0);
  const image=tweet('103');image.legacy.extended_entities={media:[{type:'photo',media_url_https:'https://pbs.twimg.com.attacker.invalid/image.jpg'}]};assert.equal(readTwitterTweet(image)!.detail.mediaManifestComplete,false);
  const article=tweet('104');article.article={article_results:{result:{title:'only headline'}}};assert.equal(readTwitterTweet(article)!.detail.bodyComplete,false);
  const shortened=tweet('105');shortened.legacy.truncated=true;assert.equal(readTwitterTweet(shortened)!.detail.bodyComplete,false);
});

test('known unavailable entries retain the source ID and cannot count as complete content',()=>{
  const raw=page('',[],null);raw.payload!.data.bookmark_timeline_v2.timeline.instructions[0].entries=[{entryId:'tweet-999',content:{itemContent:{tweet_results:{result:{__typename:'TweetTombstone'}}}}}];
  const result=parseTwitterBookmarkPage(raw);assert.equal(result.parsed,true);assert.equal(result.items[0].item.sourceId,'999');assert.equal(result.items[0].detail.availability,'unavailable');assert.equal(result.items[0].detail.bodyComplete,false);
});

test('quoted content is associated with its own source and an unreadable quote never blocks the own body',()=>{
  const raw=tweet('201','我的评论');raw.legacy.is_quote_status=true;raw.legacy.quoted_status_id_str='202';raw.quoted_status_result={result:tweet('202','被引用原文')};const result=readTwitterTweet(raw)!;assert.equal(result.detail.bodyComplete,true);assert.match(result.detail.body,/被引用原文/);assert.match(result.detail.body,/status\/202/);
  // Tombstone / deleted / protected quote: own body stays complete, the missing
  // quote becomes a note plus a manifest warning — it no longer blanks the body.
  raw.quoted_status_result={result:{__typename:'TweetUnavailable',rest_id:'202'}};
  const blocked=readTwitterTweet(raw)!;assert.equal(blocked.detail.bodyComplete,true);assert.equal(blocked.detail.bodyStatus,'valid');assert.equal(blocked.detail.mediaManifestComplete,true);
  assert.match(blocked.detail.body,/我的评论/);assert.match(blocked.detail.body,/引用的帖子无法取得/);assert.match(blocked.detail.body,/status\/202/);
  assert.match(blocked.detail.manifestError!,/引用帖未完整取得/);
  // is_quote_status without any result: same honest note, own body complete.
  const noResult=tweet('203','只评论');noResult.legacy.is_quote_status=true;noResult.legacy.quoted_status_id_str='204';
  const missing=readTwitterTweet(noResult)!;assert.equal(missing.detail.bodyComplete,true);assert.match(missing.detail.body,/引用的帖子无法取得/);assert.match(missing.detail.manifestError!,/引用帖未完整取得/);
  // A quote nested past the depth limit also leaves the own body complete.
  const inner=tweet('301','内层');inner.legacy.is_quote_status=true;inner.legacy.quoted_status_id_str='302';inner.quoted_status_result={result:{__typename:'TweetUnavailable',rest_id:'302'}};
  const outer=tweet('300','外层');outer.legacy.is_quote_status=true;outer.legacy.quoted_status_id_str='301';outer.quoted_status_result={result:inner};
  const nested=readTwitterTweet(outer)!;assert.equal(nested.detail.bodyComplete,true);assert.match(nested.detail.body,/内层/);assert.match(nested.detail.body,/引用的帖子无法取得/);
});
