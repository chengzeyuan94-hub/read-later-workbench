import type { DigestStageRecord } from './digest-contracts.js';

export type BatchProcessingKind = 'ocr' | 'asr' | 'generation';
export type BatchItemState = 'waiting-download' | 'queued' | 'processing' | 'complete' | 'candidate' | 'failed' | 'result-unknown' | 'cancelled';
/** E4.13: usage only, never a limit. Values are the calls charged while items
 * were owned by this batch; the app-wide month/total ledger lives in
 * WorkbenchState.usage. */
export interface BatchBudget {
  asrMinutes: number; asrPosts: number; generationPosts: number;
}
export interface BatchDigestItem {
  contentId: number; title: string; platform: string; requestId: string | null;
  state: BatchItemState; reason?: string; retryCount: number;
  selectedAt: number; startedAt: number | null; finishedAt: number | null;
  stages: DigestStageRecord[];
}
export interface BatchDigestState {
  id: string; state: 'running' | 'paused' | 'complete' | 'attention';
  createdAt: number; updatedAt: number; reason?: string;
  items: BatchDigestItem[]; budget: BatchBudget;
  counts: Record<BatchItemState, number>;
}
export interface BatchDigestAPI {
  create(contentIds: number[]): Promise<BatchDigestState>;
  list(): Promise<BatchDigestState[]>;
  status(batchId: string): Promise<BatchDigestState>;
  pause(batchId: string): Promise<BatchDigestState>;
  resume(batchId: string): Promise<BatchDigestState>;
  retry(batchId: string, contentId: number): Promise<BatchDigestState>;
  retryItem?(batchId: string, contentId: number): Promise<BatchDigestState>;
  cancelItem(batchId: string, contentId: number): Promise<BatchDigestState>;
}
export type BatchAPI = BatchDigestAPI;
export type BatchState = BatchDigestState;

/** Main process only. A submission reservation and the store's submitted marker
 * are committed in the same SQLite transaction before the provider starts I/O. */
export interface BatchRunnerHooks {
  allowRequest(requestId: string): boolean;
  allowPublication?(requestId: string): boolean;
  submit(input: {requestId: string; runId: string; durationMs?: number}, commit: () => void): void;
  settled?(requestId: string, errorCode?: string): void;
}
