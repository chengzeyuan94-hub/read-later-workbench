import type { Platform } from './contracts.js';

export const PLATFORMS: Platform[] = ['xiaohongshu', 'bilibili', 'weibo', 'zhihu', 'twitter'];
export const PLATFORM_NAMES: Record<Platform, string> = { xiaohongshu: '小红书', bilibili: 'B站', weibo: '微博', zhihu: '知乎', twitter: 'X / 推特' };
export const PLATFORM_HOME: Record<Platform, string> = { xiaohongshu: 'https://www.xiaohongshu.com/explore', bilibili: 'https://www.bilibili.com/', weibo: 'https://weibo.com/', zhihu: 'https://www.zhihu.com/', twitter: 'https://x.com/i/flow/login' };
const DOMAINS: Record<Platform, string[]> = { xiaohongshu: ['xiaohongshu.com'], bilibili: ['bilibili.com'], weibo: ['weibo.com', 'weibo.cn', 'sina.com.cn'], zhihu: ['zhihu.com'], twitter: ['x.com', 'twitter.com'] };
export function isPlatform(value: unknown): value is Platform { return typeof value === 'string' && PLATFORMS.includes(value as Platform); }
export function allowedPlatformUrl(platform: Platform, value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && DOMAINS[platform].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)); }
  catch { return false; }
}
