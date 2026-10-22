import type { Platform } from '../shared/contracts.js';

/** How a batch lane reacts to one failed task. */
export type FailureKind = 'expired-url' | 'rate-limit' | 'auth' | 'account-changed' | 'transient' | 'permanent';
export type FailurePhase = 'collect' | 'detail' | 'media';

const authRecord = (error: unknown): boolean => {
  const record = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown } : undefined;
  return record?.code === 'LOGIN_REQUIRED' || Number(record?.code) === -101 || Number(record?.status) === 401 || Number(record?.statusCode) === 401;
};

/**
 * Pure classification of one collect/detail/media failure. Also recognises the
 * Chinese messages safeError() persists, so retried items classify identically.
 */
export function classifyFailure(error: unknown, phase: FailurePhase): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (authRecord(error) || /\bLOGIN_REQUIRED\b|\bHTTP\s*401\b|(?:^|[^\d])-101(?:[^\d]|$)|登录失效|重新登录/i.test(message)) return 'auth';
  if (/ACCOUNT_CHANGED/i.test(message)) return 'account-changed';
  // A signed media URL answers 403/404/410 once it expires; refreshing the
  // detail usually yields a fresh address, so media never counts as rate-limit.
  if (phase === 'media' && (/\bHTTP\s*(?:403|404|410)\b/i.test(message) || /过期|expired/i.test(message))) return 'expired-url';
  if (/\bHTTP\s*(?:429|412)\b|rate.?limit|限流|频繁|风控/i.test(message)) return 'rate-limit';
  if (/\bHTTP\s*403\b|访问受限/i.test(message)) return 'rate-limit';
  if (/失效|不可访问|不可用|不支持|unsupported|unavailable|deleted|已删除|不存在|not found/i.test(message)) return 'permanent';
  return 'transient';
}

/** Cooldown progression in minutes; a further rate-limit after level 3 hard-pauses. */
export const COOLDOWN_LEVEL_MINUTES = [2, 5, 15, 30] as const;
/** Per-item transient retry backoff in milliseconds (30s / 2min / 10min). */
export const TRANSIENT_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const MAX_TRANSIENT_ATTEMPTS = 3;
/** Consecutive transient failures that escalate one platform into cooldown. */
export const TRANSIENT_STREAK_LIMIT = 5;
export const MAX_EXPIRED_REFRESHES = 2;

export interface CooldownRecord { level: number; until: number; reason: string; lastFailureAt?: number }
/** The kept level is forgotten after this much quiet time with no failure. */
export const COOLDOWN_LEVEL_QUIET_MS = 2 * 60 * 60 * 1000;
export interface PauseRecord { kind: 'auth' | 'account-changed' | 'exhausted' | 'paused'; reason: string; at: number }
export const cooldownKey = (platform: Platform) => `batchCooldown:${platform}`;
export const pauseKey = (platform: Platform) => `batchPause:${platform}`;

export function readCooldown(value: string | undefined): CooldownRecord | undefined {
  if (!value) return undefined;
  try {
    const record = JSON.parse(value) as Partial<CooldownRecord>;
    if (typeof record.level === 'number' && typeof record.until === 'number') return { level: record.level, until: record.until, reason: String(record.reason ?? ''), ...(typeof record.lastFailureAt === 'number' ? { lastFailureAt: record.lastFailureAt } : {}) };
  } catch { /* malformed settings rows are ignored */ }
  return undefined;
}

export function readPause(value: string | undefined): PauseRecord | undefined {
  if (!value) return undefined;
  try {
    const record = JSON.parse(value) as Partial<PauseRecord>;
    if (record.kind === 'auth' || record.kind === 'account-changed' || record.kind === 'exhausted' || record.kind === 'paused') return { kind: record.kind, reason: String(record.reason ?? ''), at: Number(record.at) || 0 };
  } catch { /* malformed settings rows are ignored */ }
  return undefined;
}
