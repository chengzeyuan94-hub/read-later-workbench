// E4.12: X long articles ("X Articles"). The permalink capture carries the full
// body as a Draft.js `content_state` (or a `plain_text` variant when the page
// requested it). This module renders that entity to Markdown without inventing
// content. Approach informed by pauljump/bookmark-eXport (MIT),
// jimliu/baoyu-skills and public-clis/twitter-cli payload shapes; no code was
// copied verbatim.

type Json = Record<string, any>;
const numericId = (value: unknown): string | null => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null;
export const TWITTER_ARTICLE_INCOMPLETE = 'X 长文章只有摘要，完整文章正文尚未取得';
const BODY_CAP = 400_000;

export interface TwitterArticleImage { url: string; key: string }
export interface TwitterArticleParse {
  title: string;
  markdown: string;
  images: TwitterArticleImage[];
  complete: boolean;
  reason?: string;
}

/** The article entity on a tweet result has appeared under several shapes. */
export function twitterArticleEntity(raw: Json | undefined | null): Json | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw.article?.article_results?.result
    ?? raw.article?.result
    ?? raw.article_results?.result
    ?? raw.legacy?.article?.article_results?.result
    ?? raw.legacy?.article?.result
    ?? raw.legacy?.article_results?.result;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

const entityMapResolver = (map: unknown): ((key: unknown) => Json | undefined) => {
  if (Array.isArray(map)) return key => {
    const direct = map[Number(key)];
    if (direct && typeof direct === 'object' && (direct.type || direct.data)) return direct as Json;
    const entry = map.find(e => e && typeof e === 'object' && String(e.key) === String(key));
    if (entry) return (entry.value && typeof entry.value === 'object' ? entry.value : entry) as Json;
    return undefined;
  };
  if (map && typeof map === 'object') {
    const table = map as Json;
    return key => {
      const entry = table[String(key)];
      return entry && typeof entry === 'object' ? entry : undefined;
    };
  }
  return () => undefined;
};

const httpUrl = (value: unknown): string | null => {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
};

/** Inline LINK entity ranges become Markdown links; other range types are ignored. */
const withInlineLinks = (text: string, block: Json, entityAt: (key: unknown) => Json | undefined): string => {
  const ranges = Array.isArray(block.entityRanges) ? block.entityRanges : [];
  const edits: { offset: number; length: number; url: string }[] = [];
  for (const range of ranges) {
    const entity = entityAt(range?.key);
    if (String(entity?.type) !== 'LINK') continue;
    const url = httpUrl(entity?.data?.url);
    if (!url || !Number.isInteger(range.offset) || !Number.isInteger(range.length) || range.length < 0) continue;
    edits.push({ offset: Number(range.offset), length: Number(range.length), url });
  }
  let out = String(text ?? '');
  for (const edit of edits.sort((a, b) => b.offset - a.offset)) {
    if (edit.offset < 0 || edit.offset > out.length) continue;
    const label = out.slice(edit.offset, edit.offset + edit.length);
    out = out.slice(0, edit.offset) + `[${label}](${edit.url})` + out.slice(edit.offset + edit.length);
  }
  return out;
};

const mediaItems = (entity: Json): Json[] => {
  const list = entity?.data?.mediaItems ?? entity?.data?.media_items;
  return Array.isArray(list) ? list : [];
};
const mediaTable = (article: Json): Json[] => {
  const list = article?.media_entities ?? article?.mediaItems ?? article?.media_items;
  return Array.isArray(list) ? list : [];
};
const mediaKey = (entry: Json): string | null => numericId(entry?.media_id) ?? numericId(entry?.mediaId) ?? numericId(entry?.id_str) ?? numericId(entry?.id);
const mediaImageUrl = (entry: Json | undefined): string | null => {
  if (!entry || typeof entry !== 'object') return null;
  return httpUrl(entry.media_info?.original_img_url) ?? httpUrl(entry.media_info?.img_url) ?? httpUrl(entry.media_url_https);
};

/** Renders a Draft.js content_state to plain Markdown plus collected images. */
export function readTwitterArticle(entity: Json): TwitterArticleParse {
  const title = typeof entity?.title === 'string' ? entity.title.trim() : '';
  const images: TwitterArticleImage[] = [];
  const incomplete = (reason: string): TwitterArticleParse => ({ title, markdown: '', images, complete: false, reason });
  if (!entity || typeof entity !== 'object') return incomplete(TWITTER_ARTICLE_INCOMPLETE);
  const cover = mediaImageUrl(entity.cover_media) ?? mediaImageUrl(entity.coverMedia);
  if (cover) images.push({ url: cover, key: 'cover' });
  const table = mediaTable(entity);
  const resolveMedia = (item: Json): TwitterArticleImage | null => {
    const key = mediaKey(item);
    const entry = key ? table.find(row => mediaKey(row) === key) : undefined;
    const url = mediaImageUrl(entry) ?? mediaImageUrl(item);
    return url ? { url, key: key ?? `${images.length}` } : null;
  };
  const state = entity.content_state ?? entity.contentState;
  const blocks = state && typeof state === 'object' && Array.isArray(state.blocks) ? state.blocks as Json[] : null;
  let markdown = '';
  if (blocks) {
    const entityAt = entityMapResolver(state.entityMap ?? state.entity_map);
    const parts: { text: string; tight: boolean }[] = [];
    let ordered = 0, listRun = '', codeRun: string[] = [];
    const flushCode = () => { if (codeRun.length) { parts.push({ text: '```\n' + codeRun.join('\n') + '\n```', tight: false }); codeRun = []; } };
    const push = (text: string, tight = false) => { const trimmed = text.replace(/\s+$/, ''); if (trimmed) parts.push({ text: trimmed, tight }); };
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const type = String(block.type ?? 'unstyled'), text = String(block.text ?? '');
      const list = type === 'unordered-list-item' || type === 'ordered-list-item';
      if (type !== 'ordered-list-item') ordered = 0;
      if (type !== 'code-block') flushCode();
      switch (type) {
        case 'unstyled': case 'paragraph': push(withInlineLinks(text, block, entityAt)); break;
        case 'header-one': push(`# ${text}`); break;
        case 'header-two': push(`## ${text}`); break;
        case 'header-three': push(`### ${text}`); break;
        case 'unordered-list-item': push(`- ${withInlineLinks(text, block, entityAt)}`, listRun === 'unordered-list-item'); break;
        case 'ordered-list-item': push(`${++ordered}. ${withInlineLinks(text, block, entityAt)}`, listRun === 'ordered-list-item'); break;
        case 'blockquote': push(`> ${withInlineLinks(text, block, entityAt)}`); break;
        case 'code-block': codeRun.push(text); break;
        case 'atomic': {
          const range = Array.isArray(block.entityRanges) ? block.entityRanges[0] : null;
          const atomicEntity = range ? entityAt(range.key) : undefined;
          const atomicType = String(atomicEntity?.type ?? '');
          const data = atomicEntity?.data ?? {};
          if (atomicType === 'MARKDOWN') { push(String(data.markdown ?? '')); }
          else if (atomicType === 'MEDIA') {
            const lines: string[] = [];
            for (const item of mediaItems(atomicEntity ?? {})) {
              const image = resolveMedia(item);
              lines.push(image ? `［图 ${images.length + 1}］` : '［图］');
              if (image) images.push(image);
            }
            if (!lines.length && text) lines.push(withInlineLinks(text, block, entityAt));
            push(lines.join('\n'));
          }
          else if (atomicType === 'TWEET') {
            const id = numericId(data.tweetId) ?? numericId(data.tweet_id) ?? numericId(data.id) ?? numericId(data.id_str);
            push(id ? `（嵌入帖子：https://x.com/i/web/status/${id}）` : '（嵌入帖子无法取得）');
          }
          else if (atomicType === 'LINK') {
            const url = httpUrl(data.url);
            push(url ? `[${text || url}](${url})` : text);
          }
          else if (atomicType === 'DIVIDER' || atomicType === 'horizontal-rule' || atomicType === 'divider') push('---');
          else push(withInlineLinks(text, block, entityAt));
          break;
        }
        default: push(withInlineLinks(text, block, entityAt));
      }
      listRun = list ? type : '';
    }
    flushCode();
    markdown = parts.reduce((out, part) => out === '' ? part.text : out + (part.tight ? '\n' : '\n\n') + part.text, '');
  }
  if (!markdown.trim()) {
    const plain = typeof entity.plain_text === 'string' ? entity.plain_text.trim() : '';
    if (plain) markdown = plain;
  }
  if (!markdown.trim()) return incomplete(TWITTER_ARTICLE_INCOMPLETE);
  markdown = (title ? `# ${title}\n\n` : '') + markdown;
  if (markdown.length > BODY_CAP) return { title, markdown: markdown.slice(0, BODY_CAP), images, complete: false, reason: 'X 长文章正文过长，未能完整取得' };
  return { title, markdown, images, complete: true };
}
