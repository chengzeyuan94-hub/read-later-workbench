import test from 'node:test';
import assert from 'node:assert/strict';
import { mapBilibiliFavorite, mapXhsFavorite, mergeFavorite, progressiveMp4, signWbi, sanitizeSourceError, connectionAfterDetailFailure, currentXhsDomVideo } from '../src/main/source-core.js';

test('B站同一内容跨夹合并，失效条目仍沿用AV主键并保留收藏时间', () => {
  const first = mapBilibiliFavorite({ id: 42, bvid: 'BV1test', title: '内容', upper: { name: '作者' }, pubtime: 100, fav_time: 200 }, 'folder-a')!;
  const second = mapBilibiliFavorite({ id: 42, title: '内容已失效', fav_time: 300 }, 'folder-b')!;
  const index = new Map();
  mergeFavorite(index, first);
  mergeFavorite(index, second);
  assert.equal(index.size, 1);
  assert.deepEqual(index.get('av42').folderIds, ['folder-a', 'folder-b']);
  assert.equal(index.get('av42').collectedAt, 300000);
  assert.equal(index.get('av42').publishedAt, 100000);
  assert.equal(index.get('av42').title, '内容');
});

test('小红书只接受稳定ID及签名来源，不把发布时间当收藏时间', () => {
  const item = mapXhsFavorite({ id: '0123456789abcdef01234567', xsec_token: 'fixture-only-signature', note_card: { title: '夹具', type: 'normal', time: 1700000000, user: { nickname: '夹具作者' } } })!;
  assert.equal(item.collectedAt, null);
  assert.equal(item.publishedAt, 1700000000000);
  assert.equal(item.kind, 'image');
  assert.ok(new URL(item.url).searchParams.has('xsec_token'));
  assert.equal(mapXhsFavorite({ id: '0123456789abcdef01234567' }), null);
  assert.equal(mapXhsFavorite({ id: 'invalid', xsec_token: 'fixture' }), null);
});

test('完整视频判定拒绝DASH视频段、试看流、多段与非MP4', () => {
  assert.equal(progressiveMp4({ dash: { video: [{ baseUrl: 'https://fixture.invalid/v.m4s' }] } }), null);
  assert.equal(progressiveMp4({ format: 'mp4', durl: [{ url: 'https://fixture.invalid/v.m4s' }] }), null);
  assert.equal(progressiveMp4({ format: 'mp4', is_preview: 1, durl: [{ url: 'https://fixture.invalid/v.mp4' }] }), null);
  assert.equal(progressiveMp4({ format: 'mp4', durl: [{ url: 'https://fixture.invalid/a.mp4' }, { url: 'https://fixture.invalid/b.mp4' }] }), null);
  assert.equal(progressiveMp4({ format: 'mp4', timelength: 30000, durl: [{ url: 'https://fixture.invalid/v.mp4' }] }, 180), null);
  assert.equal(progressiveMp4({ format: 'mp4', timelength: 180000, durl: [{ url: 'https://fixture.invalid/v.mp4' }] }, 180), 'https://fixture.invalid/v.mp4');
  assert.equal(progressiveMp4({ format: 'flv', durl: [{ url: 'https://fixture.invalid/v.flv' }] }), null);
  assert.equal(progressiveMp4({ format: 'mp4', durl: [{ url: 'https://fixture.invalid/v.mp4?expires=1' }] }), 'https://fixture.invalid/v.mp4?expires=1');
});

test('WBI签名依赖已取得的平台键，查询稳定且空格按%20编码', () => {
  assert.throws(() => signWbi({ a: 1 }, '', ''), /签名信息未取得/);
  const signed = signWbi({ keyword: "a b!'()*", z: 1 }, '12345678901234567890123456789012', 'abcdefghijklmnopqrstuvwxyzabcdef', 1700000000000);
  assert.equal(signed.get('keyword'), 'a b');
  assert.equal(signed.get('wts'), '1700000000');
  assert.equal(signed.get('w_rid'), '3c1213683e158af4f6cece251e013964');
});

test('连接错误隐藏来源签名URL及独立凭证字段', () => {
  const result = sanitizeSourceError(new Error('loadURL https://www.xiaohongshu.com/explore/id?xsec_token=fixturesecret token=anothersecret'));
  assert.ok(!result.includes('fixturesecret'));
  assert.ok(!result.includes('anothersecret'));
  assert.ok(result.includes('loadURL'));
});


test('单内容失效或媒体受限保留已连接账号；只有明确登录失效才能变为expired', () => {
  const connected = { platform: 'bilibili' as const, state: 'connected' as const, accountName: '夹具账号', method: '应用内', message: '登录有效' };
  for (const error of ['内容已失效', '无法取得完整视频流', 'B站读取失败（-404）', 'platform login page image not found']) {
    assert.deepEqual(connectionAfterDetailFailure(connected, new Error(error)), connected);
  }
  const expired = connectionAfterDetailFailure(connected, new Error('LOGIN_REQUIRED：登录已失效 https://fixture.invalid/?token=secret'));
  assert.equal(expired.state, 'expired');
  assert.equal(expired.accountName, '夹具账号');
  assert.equal(expired.method, '应用内');
  assert.ok(!expired.message.includes('secret'));
});


test('小红书DOM视频只接受当前笔记播放器内唯一CDN MP4，拒绝blob/清单/错页/歧义来源', () => {
  const id = '0123456789abcdef01234567';
  const page = `https://www.xiaohongshu.com/explore/${id}?xsec_token=fixture`;
  const direct = 'https://sns-video-bd.xhscdn.com/stream/current.mp4?fixture=1';
  assert.equal(currentXhsDomVideo(id, page, [{ currentSrc: direct }]), direct);
  assert.equal(currentXhsDomVideo(id, page, [{ currentSrc: 'blob:https://www.xiaohongshu.com/fixture', sources: [direct] }]), direct);
  assert.equal(currentXhsDomVideo(id, page, [{ src: direct }, { currentSrc: direct }]), direct);
  assert.equal(currentXhsDomVideo(id, page, [{ currentSrc: 'blob:https://www.xiaohongshu.com/fixture' }]), null);
  assert.equal(currentXhsDomVideo(id, page, [{ src: 'https://sns-video-bd.xhscdn.com/stream/current.m3u8' }]), null);
  assert.equal(currentXhsDomVideo(id, page, [{ src: 'https://sns-video-bd.xhscdn.com/stream/current.m4s' }]), null);
  assert.equal(currentXhsDomVideo(id, page, [{ src: 'https://sns-video-bd.xhscdn.com.attacker.invalid/current.mp4' }]), null);
  assert.equal(currentXhsDomVideo(id, 'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01', [{ src: direct }]), null);
  assert.equal(currentXhsDomVideo(id, page, [{ src: direct }, { src: 'https://sns-video-bd.xhscdn.com/stream/other.mp4' }]), null);
  assert.equal(currentXhsDomVideo(id, page, [{ sources: [direct, 'https://sns-video-bd.xhscdn.com/stream/other.mp4'] }]), null);
});
