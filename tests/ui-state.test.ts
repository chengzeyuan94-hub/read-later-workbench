import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentRecord, MediaRecord } from '../src/shared/contracts.js';
import { contentSaveState, currentMedia, digestBlockReasons, digestReady, hasSaveFailure, mediaLabel, safeError } from '../src/renderer/content-state.js';

const media = (id: number, overrides: Partial<MediaRecord> = {}): MediaRecord => ({ id, contentId: 1, kind: 'video', state: 'succeeded', localPath: `${id}.mp4`, mime: 'video/mp4', bytes: 123, error: null, current: true, ...overrides });
const content = (overrides: Partial<ContentRecord> = {}): ContentRecord => ({ id: 1, platform: 'bilibili', accountId: 'fixture', sourceId: 'v1', title: 'fixture', author: 'fixture', url: 'https://www.bilibili.com/', kind: 'video', folderIds: [], firstDiscoveredAt: 0, discovery: 'historical', body: '来源正文', bodyComplete: true, subtitle: '', detailState: 'succeeded', detailError: null, digestedAt: null, lastReviewedAt: null, offline: false, mediaManifestComplete: true, media: [media(1)], ...overrides });

test('save feedback distinguishes queue, manifest absence, body absence, download failure and inaccessible content', () => {
  assert.equal(contentSaveState(content({ detailState: 'queued' })).text, '正文排队获取');
  assert.equal(contentSaveState(content({ detailState: 'running' })).text, '正在获取正文与清单');
  assert.equal(contentSaveState(content({ bodyComplete: false })).text, '正文尚未完整');
  assert.equal(contentSaveState(content({ media: [media(1, { kind: 'image' })] })).text, '视频清单未取得');
  assert.equal(contentSaveState(content({ media: [media(1, { state: 'queued' })] })).text, '资源排队下载');
  assert.equal(contentSaveState(content({ media: [media(1, { state: 'running' })] })).text, '资源下载中');
  assert.deepEqual(contentSaveState(content({ media: [media(1, { state: 'failed', error: 'timeout' })] })), { text: '资源下载失败 · 可重试', failed: true });
  assert.equal(contentSaveState(content({ availability: 'unavailable' })).text, '内容失效 / 无法访问');
  assert.equal(contentSaveState(content({ availability: 'unsupported' })).text, '当前格式不支持保存');
  assert.equal(contentSaveState(content({ offline: true })).text, '● 可离线');
});

test('renderer uses current required media in source order, retaining real part titles', () => {
  const item = content({ offline: true, media: [media(9, { order: 1, title: 'P2 后半程' }), media(10, { order: 0, title: 'P1 开场' }), media(1, { current: false, state: 'failed' })] });
  assert.deepEqual(currentMedia(item).map(m => m.id), [10, 9]);
  assert.deepEqual(currentMedia(item).map(mediaLabel), ['P1 开场', 'P2 后半程']);
  assert.equal(contentSaveState(item).text, '● 可离线');
});

test('user-visible media errors omit signed URLs and common credential values', () => {
  const result = safeError('下载失败 https://cdn.example/v.mp4?token=secret&trid=secret Cookie=secret SESSDATA=secret signature:secret');
  assert.match(result, /下载失败/);
  assert.doesNotMatch(result, /secret|cdn\.example|https?:/);
});

test('batch retry visibility counts real failure or missing manifest, excluding active waiting tasks', () => {
  assert.equal(hasSaveFailure(content({ detailState: 'queued', mediaManifestComplete: false })), false);
  assert.equal(hasSaveFailure(content({ detailState: 'running', mediaManifestComplete: false })), false);
  assert.equal(hasSaveFailure(content({ detailState: 'failed' })), true);
  assert.equal(hasSaveFailure(content({ repairState: 'failed' })), true);
  assert.equal(hasSaveFailure(content({ mediaManifestComplete: false })), true);
  assert.equal(hasSaveFailure(content({ media: [media(1, { state: 'failed' })] })), true);
  assert.equal(hasSaveFailure(content({ offline: true })), false);
});

test('digest blocked state maps real reasons and the ready gate matches the batch lane', () => {
  assert.equal(digestReady(content({ offline: true })), true);
  assert.equal(digestReady(content({ offline: false })), false);
  assert.equal(digestReady(content({ offline: true, bodyComplete: false })), false);
  assert.equal(digestReady(content({ offline: true, media: [media(1, { state: 'queued' })] })), false);
  assert.deepEqual(digestBlockReasons(content({ bodyComplete: false, manifestError: 'X 长文章只有摘要，完整文章正文尚未取得', mediaManifestComplete: false })), ['X 长文章只有摘要，完整正文还没取得']);
  assert.deepEqual(digestBlockReasons(content({ bodyComplete: false })), ['正文未完整取得']);
  assert.deepEqual(digestBlockReasons(content({ bodyComplete: false, manifestError: '转发包装内容需取得原帖完整正文' })), ['这是转发包装，原帖正文还没取得']);
  assert.match(digestBlockReasons(content({ bodyComplete: true, mediaManifestComplete: false, manifestError: '引用帖未完整取得' }))[0], /媒体清单尚未完整取得/);
  assert.deepEqual(digestBlockReasons(content({ offline: true, media: [media(1, { state: 'failed' })] })), ['有资源下载失败，重试后可消化']);
  assert.deepEqual(digestBlockReasons(content({ offline: true, media: [media(1, { state: 'queued' })] })), ['本地资源还没下载完']);
  assert.deepEqual(digestBlockReasons(content({ availability: 'unavailable', bodyComplete: false })), ['平台内容已失效或当前账号无法访问', '正文未完整取得']);
});
