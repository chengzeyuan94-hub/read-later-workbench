import test from 'node:test';
import assert from 'node:assert/strict';
import { biliVideoDescriptor, selectXhsPlayableStream, readBiliDetail, readXhsDetailResult, SourceContentUnavailableError, xhsDetailExtractScript, xhsImageDescriptor, xhsVideoDescriptor } from '../src/main/source-detail.js';
import type { CollectionItem } from '../src/shared/contracts.js';
const item: CollectionItem = { sourceId: 'av42', title: '测试夹具', author: '', url: 'https://www.bilibili.com/video/BVfixture', kind: 'video', folderIds: ['folder'] };
const view = { bvid: 'BVfixture', cid: 1, desc: '真实接口夹具正文', pages: [{ cid: 2, page: 2, part: '第二部分', duration: 10 }, { cid: 1, page: 1, part: '第一部分', duration: 10 }] };
function api(failSubtitle = false) {
  return async (path: string, params: Record<string, string | number>) => {
    if (path.endsWith('/view')) return view;
    if (path.endsWith('/playurl')) return { quality: 16, format: 'mp4', timelength: 10000, durl: [{ url: `https://cdn.fixture.invalid/cid${params.cid}.mp4?trid=fixture` }] };
    if (failSubtitle) throw new Error('字幕临时失败');
    return { subtitle: { subtitles: [] } };
  };
}
test('稳定B站cid/角色/清晰度身份不随CDN签名变化，真实清晰度变化区分版本', () => {
  const a = biliVideoDescriptor('av42', { cid: 1, page: 1, part: '标题' }, { quality: 16 }, 'https://one.invalid/a.mp4?trid=a', item.url);
  const b = biliVideoDescriptor('av42', { cid: 1, page: 1, part: '标题' }, { quality: 16 }, 'https://two.invalid/b.mp4?trid=b', item.url);
  assert.equal(a.resourceKey, b.resourceKey); assert.equal(a.order, 1); assert.equal(a.title, 'P1 标题');
  assert.notEqual(a.resourceKey, biliVideoDescriptor('av42', { cid: 1, page: 1 }, { quality: 32 }, 'https://one.invalid/a.mp4', item.url).resourceKey);
});
test('稳定XHS媒体身份复用签名/CDN位置，不同源文件/编码/序号不能误合并', () => {
  const id = '0123456789abcdef01234567';
  const a = xhsVideoDescriptor(id, 'https://one.xhscdn.com/path/asset.mp4?trid=1', item.url, { width: 720, height: 1280 });
  const b = xhsVideoDescriptor(id, 'https://two.xhscdn.com/path/asset.mp4?trid=2', item.url, { width: 720, height: 1280 });
  assert.equal(a.resourceKey, b.resourceKey);
  assert.notEqual(a.resourceKey, xhsVideoDescriptor(id, 'https://two.xhscdn.com/path/other.mp4?trid=2', item.url, { width: 720, height: 1280 }).resourceKey);
  const imageA = xhsImageDescriptor(id, { url: 'https://one.xhscdn.com/asset.jpg?token=1', identity: 'fileID' }, 0, item.url);
  const imageB = xhsImageDescriptor(id, { url: 'https://two.xhscdn.com/asset.jpg?token=2', identity: 'fileID' }, 0, item.url);
  assert.equal(imageA.resourceKey, imageB.resourceKey);
  assert.notEqual(imageA.resourceKey, xhsImageDescriptor(id, 'https://two.xhscdn.com/asset.jpg', 1, item.url).resourceKey);
});
test('B站所有分P按实际P序和标题返回，正文完整与媒体完整分开', async () => {
  const result = await readBiliDetail(item, api(), async () => ({}));
  assert.deepEqual(result.media.map(media => media.title), ['P1 第一部分', 'P2 第二部分']);
  assert.deepEqual(result.media.map(media => media.order), [1, 2]);
  assert.equal(result.bodyComplete, true); assert.equal(result.mediaManifestComplete, true); assert.equal(result.adapterVersion, 2);
  const failP1 = async (path: string, params: Record<string, string | number>) => { if (path.endsWith('/playurl') && params.cid === '1') throw new Error('timeout https://fixture.invalid/?token=secret'); return api()(path, params); };
  const partial = await readBiliDetail(item, failP1, async () => ({}));
  assert.equal(partial.bodyComplete, true); assert.equal(partial.mediaManifestComplete, false);
  assert.deepEqual(partial.media.map(media => media.title), ['P2 第二部分']); assert.ok(!partial.manifestError!.includes('secret'));
});
test('字幕请求失败或结构损坏标为unavailable，不能以空字符串抹去旧字幕', async () => {
  const failed = await readBiliDetail(item, api(true), async () => ({}));
  assert.equal(failed.subtitleStatus, 'unavailable'); assert.equal(failed.subtitle, undefined);
  const validEmpty = await readBiliDetail(item, api(), async () => ({}));
  assert.equal(validEmpty.subtitleStatus, 'valid'); assert.equal(validEmpty.subtitle, '');
});
test('B站code62002精确标内容不可访问，普通网络失败不伪造不可访问终态', async () => {
  const result = await readBiliDetail(item, async () => { throw new SourceContentUnavailableError(62002); }, async () => ({}));
  assert.equal(result.availability, 'unavailable'); assert.equal(result.bodyStatus, 'unavailable'); assert.match(result.manifestError!, /62002/);
  await assert.rejects(readBiliDetail(item, async () => { throw new Error('network failed'); }, async () => ({})), /network failed/);
});
test('XHS取得正文却没有视频时明确缺清单，保留正文且封面不能冒充完整视频', () => {
  const xhs = { ...item, sourceId: '0123456789abcdef01234567', url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=fixture' };
  const result = readXhsDetailResult(xhs, { hasNote: true, hasSourceBody: true, body: '真实正文', type: 'video', images: ['https://one.xhscdn.com/cover.jpg'], imageComplete: true });
  assert.equal(result.bodyComplete, true); assert.equal(result.mediaManifestComplete, false); assert.match(result.manifestError!, /视频清单/);
  const unavailable = readXhsDetailResult(xhs, { unavailable: true, unavailableCode: 62002 });
  assert.equal(unavailable.availability, 'unavailable'); assert.match(unavailable.manifestError!, /62002/);
});


test('XHS可靠fileId复用路径内签名，保留顺序并区分真实图像变体', () => {
  const id = '0123456789abcdef01234567';
  const first = xhsImageDescriptor(id, { identity: 'platform-file-id', url: 'https://one.xhscdn.com/202610171000/signature-one/asset!webp', width: 1080, height: 1440, scene: 'default', format: 'webp' }, 0, item.url);
  const refreshed = xhsImageDescriptor(id, { identity: 'platform-file-id', url: 'https://two.xhscdn.com/202610171100/signature-two/asset!webp', width: 1080, height: 1440, scene: 'default', format: 'webp' }, 2, item.url);
  assert.equal(first.resourceKey, refreshed.resourceKey);
  assert.equal(refreshed.order, 2);
  const resized = xhsImageDescriptor(id, { identity: 'platform-file-id', url: 'https://two.xhscdn.com/another-signed-path/asset', width: 720, height: 960, scene: 'preview', format: 'jpeg' }, 0, item.url);
  assert.notEqual(first.resourceKey, resized.resourceKey);
});

test('B站缺P或总P数不一致不能把成功取得的P2标成完整清单', async () => {
  for (const brokenView of [
    { ...view, videos: 2, pages: [{ cid: 2, page: 2, duration: 10 }] },
    { ...view, videos: 3, pages: [{ cid: 1, page: 1, duration: 10 }, { cid: 2, page: 2, duration: 10 }] },
    { ...view, pages: [{ cid: 1, page: 1, duration: 10 }, { cid: 3, page: 3, duration: 10 }] },
  ]) {
    let playRequests = 0;
    const brokenApi = async (path: string, params: Record<string, string | number>) => {
      if (path.endsWith('/view')) return brokenView;
      playRequests++; return api()(path, params);
    };
    await assert.rejects(readBiliDetail(item, brokenApi, async () => ({})), /分P清单缺页或总数不一致/);
    assert.equal(playRequests, 0);
  }
});


test('XHS不依据EF别名猜codec，按当前note条目明确格式/音轨/时长选择完整MP4', () => {
  const stream = { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac', duration: 136200, videoDuration: 136200, audioDuration: 136180, videoBitrate: 800000, masterUrl: 'https://sns-video-bd.xhscdn.com/current-note/video.mp4?signature=fixture', width: 720, height: 1280 };
  assert.equal(selectXhsPlayableStream({ EF5: [stream], EF7: [{ ...stream, videoCodec: 'h265', videoBitrate: 900000 }] }, 136.2), stream);
  assert.equal(selectXhsPlayableStream({ arbitraryAlias: [stream] }, 136.2), stream);
  for (const malformed of [
    { ...stream, audioCodec: undefined }, { ...stream, audioDuration: 0 }, { ...stream, format: 'dash' },
    { ...stream, masterUrl: 'blob:https://www.xiaohongshu.com/fixture' },
    { ...stream, masterUrl: 'https://sns-video-bd.xhscdn.com/current-note/video.m3u8' },
    { ...stream, masterUrl: 'https://xhscdn.com.attacker.invalid/current-note/video.mp4' },
    { ...stream, duration: 30000, audioDuration: 30000 }, { ...stream, audioDuration: 2000 },
  ]) assert.equal(selectXhsPlayableStream({ EF5: [malformed] }, 136.2), null);
});


test('XHS提取脚本在当前note别名流工作，诊断不包含下载URL且不混入其他note', async () => {
  const { runInNewContext } = await import('node:vm');
  const sourceId = '0123456789abcdef01234567';
  const xhs = { ...item, sourceId, url: `https://www.xiaohongshu.com/explore/${sourceId}?xsec_token=fixture` };
  const url = 'https://sns-video-bd.xhscdn.com/current-note/full.mp4?signature=fixture-secret';
  const current = { desc: '真实来源结构夹具', type: 'video', imageList: [], video: { media: { videoId: 'fixture-video-id', stream: { EF5: [{ format: 'mp4', videoCodec: 'h264', audioCodec: 'aac', duration: 136200, videoDuration: 136200, audioDuration: 136200, masterUrl: url }] } } } };
  const result = runInNewContext(xhsDetailExtractScript(xhs), { URL, location: { href: xhs.url }, window: { __INITIAL_STATE__: { note: { noteDetailMap: { [sourceId]: { note: current }, anotherNote: { note: { video: { url: 'https://sns-video-bd.xhscdn.com/unrelated.mp4' } } } } } } }, document: { body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] } });
  assert.equal(result.videoUrl, url);
  assert.equal(result.videoMetadata.videoId, 'fixture-video-id');
  assert.ok(!JSON.stringify(result.diagnostics).includes('fixture-secret'));
  assert.equal(result.diagnostics.streamSummary[0].videoCodec, 'h264');
  assert.equal(result.diagnostics.streamSummary[0].masterUrl.extension, 'mp4');
});


test('XHS保留EF4为来源不透明codec，完整MP4可取得；fmp4无音轨或DRM不可取得', () => {
  const full = { format: 'mp4', videoCodec: 'EF4', audioCodec: 'aac', duration: 136200, videoDuration: 136200, audioDuration: 136180, masterUrl: 'http://sns-video-bd.xhscdn.com/current-note/full.mp4', videoBitrate: 800000 };
  const segment = { ...full, format: 'fmp4', videoCodec: 'EF5', audioDuration: 0, masterUrl: 'https://sns-video-bd.xhscdn.com/current-note/segment.m4s' };
  assert.equal(selectXhsPlayableStream({ EF4: [full], EF5: [segment] }, 136.2, 0), full);
  assert.equal(selectXhsPlayableStream({ EF5: [segment] }, 136.2, 0), null);
  assert.equal(selectXhsPlayableStream({ EF4: [full] }, 136.2, 1), null);
  assert.equal(selectXhsPlayableStream({ EF4: [{ ...full, drmType: 1 }] }, 136.2, 0), null);
  const descriptor = xhsVideoDescriptor('0123456789abcdef01234567', full.masterUrl, item.url, full);
  assert.ok(descriptor.version!.startsWith('source-declared:EF4:'));
  assert.ok(!descriptor.version!.toLowerCase().includes('h264'));
});


test('XHS可靠videoId复用路径签名/CDN位置，真实videoId/codec/清晰度变化分版本', () => {
  const id = '0123456789abcdef01234567';
  const metadata = { videoId: 'platform-video-id', videoCodec: 'EF4', width: 540, height: 960, videoBitrate: 800000, qualityType: 'HD', format: 'mp4', fps: 30 };
  const first = xhsVideoDescriptor(id, 'https://one.xhscdn.com/202610171000/signature-one/full.mp4', item.url, metadata);
  const refreshed = xhsVideoDescriptor(id, 'https://two.xhscdn.com/202610171100/signature-two/full.mp4', item.url, metadata);
  assert.equal(first.resourceKey, refreshed.resourceKey); assert.equal(first.sourceIdentity, refreshed.sourceIdentity);
  for (const change of [{ videoId: 'different-video-id' }, { videoCodec: 'EF5' }, { width: 1080, height: 1920, qualityType: 'FHD' }, { videoBitrate: 1600000 }]) {
    assert.notEqual(first.resourceKey, xhsVideoDescriptor(id, first.remoteUrl, item.url, { ...metadata, ...change }).resourceKey);
  }
  const withoutId = { ...metadata, videoId: undefined };
  assert.notEqual(xhsVideoDescriptor(id, first.remoteUrl, item.url, withoutId).resourceKey, xhsVideoDescriptor(id, refreshed.remoteUrl, item.url, withoutId).resourceKey);
});
