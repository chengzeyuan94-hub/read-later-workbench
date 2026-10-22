import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { SourceAccountVerificationCache } from '../src/main/source-account-cache.js';

test('media checks reuse only the same platform and account before the ten minute deadline', async () => {
  let now = 1000;
  let calls = 0;
  const cache = new SourceAccountVerificationCache(() => now);
  const inspect = async () => { calls++; return 'account-a'; };
  await cache.verify('xiaohongshu', 'account-a', inspect);
  now = 600_999;
  await cache.verify('xiaohongshu', 'account-a', inspect);
  assert.equal(calls, 1);
  await cache.verify('bilibili', 'account-a', inspect);
  assert.equal(calls, 2, 'a second platform must verify independently');
  now = 601_000;
  await cache.verify('xiaohongshu', 'account-a', inspect);
  assert.equal(calls, 3, 'the exact expiry boundary must recheck');
  await assert.rejects(cache.verify('xiaohongshu', 'account-b', inspect), /ACCOUNT_CHANGED/);
  assert.equal(calls, 4, 'a different expected account cannot reuse account-a');
  await cache.verify('xiaohongshu', 'account-a', inspect);
  assert.equal(calls, 5, 'an account mismatch also removes prior success');
});

test('ordinary cookie churn keeps the cache; only explicit removal invalidates; cookie data is never read', async () => {
  const xhsCookies = new EventEmitter();
  const biliCookies = new EventEmitter();
  const cache = new SourceAccountVerificationCache(() => 1000);
  cache.watch('xiaohongshu', xhsCookies);
  cache.watch('bilibili', biliCookies);
  let calls = 0;
  const inspect = async () => { calls++; return 'a'; };
  await cache.verify('xiaohongshu', 'a', inspect);
  await cache.verify('bilibili', 'a', inspect);
  const unreadable = new Proxy({}, { get() { throw new Error('cookie data must not be read'); } });
  // Page loads constantly set, overwrite and expire cookies; none may invalidate.
  xhsCookies.emit('changed', unreadable, unreadable, 'overwrite', false);
  xhsCookies.emit('changed', unreadable, unreadable, 'explicit', false);
  xhsCookies.emit('changed', unreadable, unreadable, 'expired', true);
  await cache.verify('xiaohongshu', 'a', inspect);
  assert.equal(calls, 2, 'cookie churn from page loads must not invalidate the gate');
  xhsCookies.emit('changed', unreadable, unreadable, 'explicit', true);
  await cache.verify('bilibili', 'a', inspect);
  assert.equal(calls, 2, 'an explicit removal invalidates only its own platform');
  await cache.verify('xiaohongshu', 'a', inspect);
  assert.equal(calls, 3);
  cache.invalidate('xiaohongshu'); // The application login entry point uses this.
  await cache.verify('xiaohongshu', 'a', inspect);
  assert.equal(calls, 4);
});

test('session replacement unbinds the former emitter, invalidates success, and dispose unbinds all listeners', async () => {
  const oldCookies = new EventEmitter();
  const newCookies = new EventEmitter();
  const cache = new SourceAccountVerificationCache(() => 1000);
  cache.watch('xiaohongshu', oldCookies);
  cache.watch('xiaohongshu', oldCookies);
  assert.equal(oldCookies.listenerCount('changed'), 1);
  let calls = 0;
  const inspect = async () => { calls++; return 'a'; };
  await cache.verify('xiaohongshu', 'a', inspect);
  cache.watch('xiaohongshu', newCookies);
  assert.equal(oldCookies.listenerCount('changed'), 0);
  assert.equal(newCookies.listenerCount('changed'), 1);
  await cache.verify('xiaohongshu', 'a', inspect);
  assert.equal(calls, 2);
  oldCookies.emit('changed', {}, {}, 'explicit', true);
  await cache.verify('xiaohongshu', 'a', inspect);
  assert.equal(calls, 2, 'a detached session cannot invalidate the current session');
  cache.dispose();
  assert.equal(newCookies.listenerCount('changed'), 0);
  await assert.rejects(cache.verify('xiaohongshu', 'a', inspect), /采集会话已关闭/);
});

test('an explicit cookie removal while the account read is pending prevents stale cache refill', async () => {
  const cookies = new EventEmitter();
  const cache = new SourceAccountVerificationCache(() => 1000);
  cache.watch('xiaohongshu', cookies);
  let finish!: (id: string) => void;
  const pending = cache.verify('xiaohongshu', 'a', () => new Promise(resolve => { finish = resolve; }));
  cookies.emit('changed', {}, {}, 'explicit', true);
  finish('a');
  await pending;
  let nextChecks = 0;
  await cache.verify('xiaohongshu', 'a', async () => { nextChecks++; return 'a'; });
  assert.equal(nextChecks, 1);
});

test('page-load cookie churn in flight no longer blocks caching after a real account observation', async () => {
  const cookies = new EventEmitter();
  const cache = new SourceAccountVerificationCache(() => 1000);
  cache.watch('xiaohongshu', cookies);
  let calls = 0;
  await cache.verify('xiaohongshu', 'a', async beginInspection => {
    cookies.emit('changed', {}, {}, 'overwrite', false);
    beginInspection();
    calls++;
    return 'a';
  });
  await cache.verify('xiaohongshu', 'a', async () => { calls++; return 'a'; });
  assert.equal(calls, 1);
});

test('failed probes, backwards clocks and dispose during a probe never authorize a cached download', async () => {
  let now = 1000;
  const cache = new SourceAccountVerificationCache(() => now);
  await assert.rejects(cache.verify('bilibili', 'a', async () => { throw new Error('LOGIN_REQUIRED'); }), /LOGIN_REQUIRED/);
  let calls = 0;
  const inspect = async () => { calls++; return 'a'; };
  await cache.verify('bilibili', 'a', inspect);
  now = 999;
  await cache.verify('bilibili', 'a', inspect);
  assert.equal(calls, 2);
  cache.invalidate('bilibili');
  let finish!: (id: string) => void;
  const pending = cache.verify('bilibili', 'a', () => new Promise(resolve => { finish = resolve; }));
  cache.dispose();
  finish('a');
  await assert.rejects(pending, /采集会话已关闭/);
});
