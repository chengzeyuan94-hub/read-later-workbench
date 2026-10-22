import type { Platform } from '../shared/contracts.js';
import { requireSourceAccount } from './source-collection.js';

interface CookieChanges {
  on(event: 'changed', listener: (event: unknown, cookie: unknown, cause: string, removed: boolean) => void): unknown;
  removeListener(event: 'changed', listener: (event: unknown, cookie: unknown, cause: string, removed: boolean) => void): unknown;
}

/** A short-lived media gate; collection and detail checks must remain uncached. */
export class SourceAccountVerificationCache {
  private readonly successes = new Map<Platform, { accountId: string; checkedAt: number }>();
  private readonly generations = new Map<Platform, number>();
  private readonly bindings = new Map<Platform, { cookies: CookieChanges; changed: (event: unknown, cookie: unknown, cause: string, removed: boolean) => void }>();
  private disposed = false;

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 600_000) {}

  watch(platform: Platform, cookies: CookieChanges): void {
    if (this.disposed) throw new Error('采集会话已关闭');
    const prior = this.bindings.get(platform);
    if (prior?.cookies === cookies) return;
    if (prior) prior.cookies.removeListener('changed', prior.changed);
    this.invalidate(platform);
    // Cookie names and values are never read or logged. Only an explicit removal
    // (logout or deliberate clearing) invalidates; ordinary page-load set/overwrite
    // and expiry churn must not, or every media download reopens the account check.
    const changed = (_event: unknown, _cookie: unknown, cause: string, removed: boolean) => { if (removed === true && cause === 'explicit') this.invalidate(platform); };
    cookies.on('changed', changed);
    this.bindings.set(platform, { cookies, changed });
  }

  invalidate(platform: Platform): void {
    this.successes.delete(platform);
    this.generations.set(platform, (this.generations.get(platform) ?? 0) + 1);
  }

  async verify(platform: Platform, expectedAccountId: string, inspect: (beginInspection: () => void) => Promise<string>): Promise<void> {
    if (this.disposed) throw new Error('采集会话已关闭');
    const cached = this.successes.get(platform);
    const startedAt = this.now();
    const age = cached ? startedAt - cached.checkedAt : Infinity;
    if (cached?.accountId === expectedAccountId && age >= 0 && age < this.ttlMs) return;
    this.invalidate(platform);
    let generation = this.generations.get(platform) ?? 0;
    try {
      const actualAccountId = await inspect(() => {
        // Optional preparation (such as opening a page) precedes the actual
        // account read. Cookies changed during preparation are checked afresh.
        generation = this.generations.get(platform) ?? 0;
      });
      if (this.disposed) throw new Error('采集会话已关闭');
      requireSourceAccount(actualAccountId, expectedAccountId);
      // Navigation may itself change cookies. Such an in-flight observation can
      // satisfy this real check, but must not restore a cache invalidated meanwhile.
      if (generation === (this.generations.get(platform) ?? 0)) {
        this.successes.set(platform, { accountId: actualAccountId, checkedAt: startedAt });
      }
    } catch (error) {
      this.invalidate(platform);
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const [platform, binding] of this.bindings) {
      binding.cookies.removeListener('changed', binding.changed);
      this.invalidate(platform);
    }
    this.bindings.clear();
    this.successes.clear();
  }
}
