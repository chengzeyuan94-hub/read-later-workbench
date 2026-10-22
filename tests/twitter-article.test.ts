import test from 'node:test';
import assert from 'node:assert/strict';
import { readTwitterArticle, twitterArticleEntity, TWITTER_ARTICLE_INCOMPLETE } from '../src/main/twitter-article.js';
import { readTwitterTweet } from '../src/main/twitter-source.js';

function tweet(id: string, text = `正文 ${id}`): any {
  return { __typename: 'Tweet', rest_id: id, core: { user_results: { result: { legacy: { name: '作者', screen_name: 'author' } } } }, legacy: { id_str: id, full_text: text, truncated: false, created_at: 'Wed Oct 14 10:00:00 +0000 2026', entities: {} } };
}
/** Draft.js payload shaped like the twitter-cli / baoyu fixtures. */
function blocks() {
  return [
    { key: 'a', type: 'unstyled', text: '开头段落，链接在此。', entityRanges: [{ offset: 5, length: 2, key: 0 }], inlineStyleRanges: [] },
    { key: 'b', type: 'header-two', text: '第一节', entityRanges: [], inlineStyleRanges: [] },
    { key: 'c', type: 'unordered-list-item', text: '要点一', entityRanges: [], inlineStyleRanges: [] },
    { key: 'd', type: 'unordered-list-item', text: '要点二', entityRanges: [], inlineStyleRanges: [] },
    { key: 'e', type: 'ordered-list-item', text: '第一步', entityRanges: [], inlineStyleRanges: [] },
    { key: 'f', type: 'ordered-list-item', text: '第二步', entityRanges: [], inlineStyleRanges: [] },
    { key: 'g', type: 'unstyled', text: '中间段落', entityRanges: [], inlineStyleRanges: [] },
    { key: 'h', type: 'ordered-list-item', text: '新的第一步', entityRanges: [], inlineStyleRanges: [] },
    { key: 'i', type: 'blockquote', text: '引用一句', entityRanges: [], inlineStyleRanges: [] },
    { key: 'j', type: 'code-block', text: 'const a=1;', entityRanges: [], inlineStyleRanges: [] },
    { key: 'k', type: 'code-block', text: 'const b=2;', entityRanges: [], inlineStyleRanges: [] },
    { key: 'l', type: 'atomic', text: '', entityRanges: [{ offset: 0, length: 1, key: 1 }], inlineStyleRanges: [] },
    { key: 'm', type: 'atomic', text: '', entityRanges: [{ offset: 0, length: 1, key: 2 }], inlineStyleRanges: [] },
    { key: 'n', type: 'atomic', text: '', entityRanges: [{ offset: 0, length: 1, key: 3 }], inlineStyleRanges: [] },
    { key: 'o', type: 'atomic', text: '分隔', entityRanges: [{ offset: 0, length: 1, key: 4 }], inlineStyleRanges: [] },
    { key: 'p', type: 'atomic', text: '', entityRanges: [{ offset: 0, length: 1, key: 5 }], inlineStyleRanges: [] },
  ];
}
function entries() {
  return {
    0: { type: 'LINK', mutability: 'MUTABLE', data: { url: 'https://example.com/a' } },
    1: { type: 'MARKDOWN', mutability: 'IMMUTABLE', data: { markdown: '```ts\nexport {};\n```' } },
    2: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: '777' }, { mediaId: '888' }] } },
    3: { type: 'TWEET', mutability: 'IMMUTABLE', data: { tweetId: '424242' } },
    4: { type: 'LINK', mutability: 'IMMUTABLE', data: { url: 'https://example.com/b' } },
    5: { type: 'DIVIDER', mutability: 'IMMUTABLE', data: {} },
  };
}
function article(entityMap: unknown): any {
  return {
    rest_id: '31415926', title: '一篇长文章',
    content_state: { blocks: blocks(), entityMap },
    media_entities: [
      { media_id: '777', media_info: { original_img_url: 'https://pbs.twimg.com/media/art1.png' } },
      { media_id: '888', media_url_https: 'https://pbs.twimg.com/media/art2.png' },
    ],
    cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/media/cover.png' } },
  };
}
const expected = [
  '# 一篇长文章', '',
  '开头段落，[链接](https://example.com/a)在此。', '',
  '## 第一节', '',
  '- 要点一', '- 要点二', '',
  '1. 第一步', '2. 第二步', '',
  '中间段落', '',
  '1. 新的第一步', '',
  '> 引用一句', '',
  '```\nconst a=1;\nconst b=2;\n```', '',
  '```ts\nexport {};\n```', '',
  '［图 2］\n［图 3］', '',
  '（嵌入帖子：https://x.com/i/web/status/424242）', '',
  '[分隔](https://example.com/b)', '',
  '---',
].join('\n');

test('Draft.js content_state renders every block type; entityMap works as object map and as key/value array', () => {
  for (const entityMap of [entries(), Object.entries(entries()).map(([key, value]) => ({ key, value }))]) {
    const parsed = readTwitterArticle(article(entityMap));
    assert.equal(parsed.complete, true);
    assert.equal(parsed.title, '一篇长文章');
    assert.equal(parsed.markdown, expected);
    assert.deepEqual(parsed.images, [
      { url: 'https://pbs.twimg.com/media/cover.png', key: 'cover' },
      { url: 'https://pbs.twimg.com/media/art1.png', key: '777' },
      { url: 'https://pbs.twimg.com/media/art2.png', key: '888' },
    ]);
  }
});

test('plain_text is the fallback body; preview-only stays honestly incomplete', () => {
  const plain = readTwitterArticle({ rest_id: '9', title: 'T', plain_text: '纯文字正文\n第二段' });
  assert.equal(plain.complete, true);
  assert.equal(plain.markdown, '# T\n\n纯文字正文\n第二段');
  const preview = readTwitterArticle({ rest_id: '9', title: 'only headline', preview_text: 'summary' });
  assert.equal(preview.complete, false);
  assert.equal(preview.reason, TWITTER_ARTICLE_INCOMPLETE);
});

test('the article entity is found under every observed payload path', () => {
  const entity = { rest_id: '5', title: 'E', plain_text: 'x' };
  for (const raw of [
    { article: { article_results: { result: entity } } },
    { article: { result: entity } },
    { article_results: { result: entity } },
    { legacy: { article: { article_results: { result: entity } } } },
    { legacy: { article_results: { result: entity } } },
  ]) assert.equal(twitterArticleEntity(raw), entity);
  assert.equal(twitterArticleEntity({}), null);
  assert.equal(twitterArticleEntity({ article: { article_results: {} } }), null);
});

test('a complete article keeps the tweet digestible; t.co-only own text is dropped, real comments are kept', () => {
  const linkOnly = tweet('500', 'https://t.co/AbCdEfG');
  linkOnly.article = { article_results: { result: article(entries()) } };
  const parsed = readTwitterTweet(linkOnly)!;
  assert.equal(parsed.detail.bodyComplete, true);
  assert.equal(parsed.detail.body, expected);
  assert.equal(parsed.detail.mediaManifestComplete, true);
  assert.equal(parsed.item.title, '一篇长文章');
  assert.equal(parsed.item.kind, 'image');
  const images = parsed.detail.media.filter(m => m.role === 'article');
  assert.deepEqual(images.map(m => m.remoteUrl), ['https://pbs.twimg.com/media/cover.png', 'https://pbs.twimg.com/media/art1.png', 'https://pbs.twimg.com/media/art2.png']);
  assert.deepEqual(images.map(m => m.resourceKey), ['twitter:500:tweet:500:article:cover:image', 'twitter:500:tweet:500:article:777:image', 'twitter:500:tweet:500:article:888:image']);

  const commented = tweet('501', '我自己的评论');
  commented.article = { article_results: { result: article(entries()) } };
  const withComment = readTwitterTweet(commented)!;
  assert.ok(withComment.detail.body.startsWith('我自己的评论\n\n# 一篇长文章'));
  assert.equal(withComment.detail.bodyComplete, true);
});

test('summary-only articles stay incomplete; article images on disallowed hosts are rejected without losing the body', () => {
  const summary = tweet('502', '链接');
  summary.article = { article_results: { result: { title: 'only headline' } } };
  const incomplete = readTwitterTweet(summary)!;
  assert.equal(incomplete.detail.bodyComplete, false);
  assert.match(incomplete.detail.manifestError!, /X 长文章只有摘要/);

  const badHost = article(entries());
  badHost.media_entities[0]!.media_info.original_img_url = 'https://pbs.twimg.com.attacker.invalid/art1.png';
  badHost.media_entities[1]!.media_url_https = 'javascript:alert(1)';
  const raw = tweet('503', '');
  raw.article = { article_results: { result: badHost } };
  const parsed = readTwitterTweet(raw)!;
  assert.equal(parsed.detail.bodyComplete, true);
  assert.deepEqual(parsed.detail.media.filter(m => m.role === 'article').map(m => m.remoteUrl), ['https://pbs.twimg.com/media/cover.png']);
  assert.match(parsed.detail.manifestError!, /文章图片 .* 来源不支持保存/);
});

test('the body cap marks oversized articles incomplete with its own reason', () => {
  const giant = readTwitterArticle({ title: 'G', plain_text: '字'.repeat(400_000) });
  assert.equal(giant.complete, false);
  assert.match(giant.reason!, /正文过长/);
  assert.ok(giant.markdown.length <= 400_000);
});
