import type Database from 'better-sqlite3';
import type { ProcessingUsage } from '../shared/contracts.js';
import { shanghaiMonthStart } from '../shared/shanghai-time.js';

type Row = Record<string, any>;

/** E4.13 用量账本：asr_calls 与 generation_calls 的 submitted=1 行是唯一覆盖
 * 所有付费提交路径的权威记录（批量与单条消化共用同一 runner）。batch_digest_
 * submissions 只是批次预留，不计入，避免重复。
 * 转录分钟取已提交调用对应分片的 prepared duration；未提交调用与缓存命中不计。 */
export function processingUsage(db: Database.Database, now: number): ProcessingUsage {
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const start = shanghaiMonthStart(now);
  const usage: ProcessingUsage = {
    month: { asrMinutes: 0, asrCount: 0, generationCount: 0 },
    total: { asrMinutes: 0, asrCount: 0, generationCount: 0 },
  };
  if (has('asr_calls') && has('asr_chunks')) {
    const total = db.prepare("SELECT count(*) n,coalesce(sum(json_extract(c.prepared_json,'$.durationMs')),0) ms FROM asr_calls a LEFT JOIN asr_chunks c ON c.id=a.chunk_id WHERE a.submitted=1").get() as Row;
    const month = db.prepare("SELECT count(*) n,coalesce(sum(json_extract(c.prepared_json,'$.durationMs')),0) ms FROM asr_calls a LEFT JOIN asr_chunks c ON c.id=a.chunk_id WHERE a.submitted=1 AND a.started_at>=?").get(start) as Row;
    usage.total.asrCount = Number(total.n); usage.total.asrMinutes = Number(total.ms) / 60_000;
    usage.month.asrCount = Number(month.n); usage.month.asrMinutes = Number(month.ms) / 60_000;
  }
  if (has('generation_calls')) {
    usage.total.generationCount = Number((db.prepare('SELECT count(*) n FROM generation_calls WHERE submitted=1').get() as Row).n);
    usage.month.generationCount = Number((db.prepare('SELECT count(*) n FROM generation_calls WHERE submitted=1 AND started_at>=?').get(start) as Row).n);
  }
  return usage;
}
