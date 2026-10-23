import type { BatchDigestAPI } from './batch-contracts.js';
import type { OcrAPI } from './ocr-contracts.js';
import type { AsrAPI } from './asr-contracts.js';
import type { GenerationAPI } from './generation-contracts.js';
import type { EditorAPI } from './editor-contracts.js';
import type { DigestAPI, DigestContentState } from './digest-contracts.js';
export type Platform = 'xiaohongshu' | 'bilibili' | 'weibo' | 'zhihu' | 'twitter';
export type ContentKind = 'image' | 'video' | 'audio' | 'text';
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed';
export interface CollectionItem {
  sourceId: string; title: string; author: string; url: string; kind: ContentKind;
  publishedAt?: number | null; collectedAt?: number | null; folderIds: string[];
}
export interface CollectionSnapshot {
  platform: Platform; accountId: string; accountName: string;
  folders: { id: string; title: string }[]; items: CollectionItem[];
  complete: boolean; warning?: string;
  recent?: { scopes: RecentScopeEvidence[] };
  /** A bounded recent import can be complete without reaching historical end. */
  target?: { limit: number; complete: boolean; reliable: boolean; reason: string };
  /** E4.7: the platform rate-limited mid-collection; items already read are
   * kept as a partial result and the platform enters cooldown. */
  limited?: string;
}
export interface CollectionOptions {
  recentLimit?: number;
  /** Read the platform's full favourite history (mutually exclusive with recentLimit). */
  fullHistory?: true;
  expectedAccountId?: string;
}
export type SyncRange = '10' | '30' | '100' | 'all';
export interface RecentSyncScope {
  platform: Platform; accountId: string; targetIds: string[]; observedIds: string[];
  targetComplete: boolean; historyComplete: boolean; reliable: boolean; reason: string;
  startedAt: number; updatedAt: number;
}
export interface RecentSyncLane {
  platform: Platform; mode: 'running' | 'idle' | 'cooldown' | 'paused' | 'login' | 'done';
  until?: number; reason?: string;
  active: { details: number; images: number; videos: number };
  queued: { details: number; media: number };
}
export interface RecentSyncState {
  batchId: string; limit: number; scopes: RecentSyncScope[];
  pausedContentDownloads?: { contentId: number; reason: string; pausedAt: number }[];
  /** E4.5 per-platform lane status for the sync popover. */
  lanes?: RecentSyncLane[];
}
export interface RecentScopeEvidence {
  scopeId: string; reliable: boolean; orderedIds: string[];
  sort: 'collection-order' | 'unknown'; reason: string;
  pages: { cursor: string; nextCursor: string | null; ids: string[]; parsed: boolean }[];
}
export interface MediaDescriptor {
  remoteUrl: string; kind: 'image' | 'video' | 'audio'; mime?: string; referer?: string;
  resourceKey?: string; role?: string; order?: number; title?: string;
  sourceIdentity?: string; version?: string;
  durationSeconds?: number;
}
export interface DetailResult {
  body: string; bodyComplete: boolean; subtitle?: string; publishedAt?: number | null;
  bodyStatus?: 'valid' | 'unavailable'; subtitleStatus?: 'valid' | 'unavailable';
  mediaManifestComplete?: boolean; manifestError?: string; adapterVersion?: number;
  availability?: 'available' | 'unavailable' | 'unsupported';
  media: MediaDescriptor[];
}
export interface SourceAdapter {
  platform: Platform;
  collect(options?: CollectionOptions): Promise<CollectionSnapshot>;
  detail(item: CollectionItem, options?: { expectedAccountId?: string }): Promise<DetailResult>;
  verifyAccount?(expectedAccountId: string): Promise<void>;
}
export interface MediaRecord {
  id: number; contentId: number; kind: string; state: TaskState; localPath: string | null;
  mime: string; error: string | null; bytes: number; remoteUrl?: string;
  resourceKey?: string; role?: string; order?: number; title?: string; current?: boolean;
  durationSeconds?: number;
}
export interface ContentRecord extends CollectionItem {
  id: number; platform: Platform; accountId: string; firstDiscoveredAt: number;
  discovery: 'historical' | 'new' | 'unknown'; body: string; bodyComplete: boolean;
  subtitle: string; detailState: TaskState; detailError: string | null;
  digestedAt: number | null; lastReviewedAt: number | null; offline: boolean;
  media: MediaRecord[];
  mediaManifestComplete?: boolean; manifestError?: string; adapterVersion?: number;
  availability?: 'available' | 'unavailable' | 'unsupported';
  repairState?: string; repairAttempts?: number;
  /** E4.8: persisted platform favourite-order rank; higher = favourited more
   * recently within its platform+account. Absent before the first rank pass. */
  favoriteRank?: number;
}
export interface SyncRecord {
  id: number; platform: Platform; startedAt: number; finishedAt: number | null;
  state: 'running' | 'succeeded' | 'partial' | 'failed';
  discovered: number; deduplicated: number; saved: number; failed: number; message: string;
  incrementalStatus?: 'baseline' | 'confirmed' | 'unknown'; incrementalNew?: number; incrementalReason?: string;
  trigger?: 'manual' | 'timer' | 'resume';
}
export interface Connection {
  platform: Platform; state: 'disconnected' | 'connected' | 'expired' | 'error';
  accountName?: string; message: string; method: string;
  verifiedAt?: number;
}
export interface ProcessingConfiguration {
  asrConfigured: boolean; asrNetworkAllowed: boolean;
  generationConfigured?: boolean; generationNetworkAllowed?: boolean;
}
/** E4.13 用量：只显示，不设上限。按 Asia/Shanghai 自然月与累计统计已提交的转录/整理调用。 */
export interface ProcessingUsage {
  month: { asrMinutes: number; asrCount: number; generationCount: number };
  total: { asrMinutes: number; asrCount: number; generationCount: number };
}
export interface WorkbenchState {
  usage?: ProcessingUsage;
  recentSync?: RecentSyncState;
  downloadsPaused?: boolean;
  downloadsPauseReason?: string;
  /** No credential bytes or credential filesystem locations are exposed. */
  processingConfiguration?: ProcessingConfiguration;
  editorEnabled?: boolean; isolationMode?: boolean;
  digestStates?: DigestContentState[];
  contents: ContentRecord[]; continueItems: ContentRecord[]; recent: ContentRecord[]; reviews: ContentRecord[];
  syncs: SyncRecord[]; connections: Connection[]; autoSync: boolean; online: boolean;
  /** E4.7 同步范围：每次同步检查各平台最近 N 条收藏；'all' 读取全部历史。 */
  syncRange?: SyncRange;
  dataDir: string; mediaDir: string; timezone: string; busy: Platform[];
  scheduler?: { lastCheckAt: number | null; nextCheckAt: number | null; paused: boolean; pending: Platform[] };
  progress?: { contents: number; offline: number; bodyPending: number; manifestMissing: number; mediaQueued: number; mediaRunning: number; mediaFailed: number; mediaSaved: number };
  /** E4.6 tombstones: locally deleted collections kept as the sync baseline. */
  deleted?: DeletedContent[];
  deletionBlocked?: { contentId: number; reason: string }[];
}
export interface DeletedContent { contentId: number; title: string; platform: string; accountId: string; sourceId: string; deletedAt: number; bytesFreed: number }
export interface DeleteResult { deleted: number[]; blocked: { id: number; reason: string }[]; bytesFreed: number }
export interface DeletePreview { bytes: number; blocked: { id: number; reason: string }[] }
export type CredentialProviderId = 'siliconflow' | 'deepseek';
export interface CredentialPromptRequest { provider: CredentialProviderId; label: string; purpose: string }
export interface CredentialModalAPI {
  set(provider: CredentialProviderId, value: string): Promise<{ configured: boolean }>;
  cancel(provider: CredentialProviderId): Promise<{ cancelled: boolean }>;
  onOpen(handler: (request: CredentialPromptRequest) => void): () => void;
}

export interface WorkbenchAPI {
  /** In-app credential entry; the key never crosses back to the renderer. */
  credentials?: CredentialModalAPI;
  batch?: BatchDigestAPI;
  pauseDownloads?(): Promise<void>;
  resumeDownloads?(): Promise<void>;
  resumePlatform?(platform: Platform): Promise<void>;
  generation?: GenerationAPI;
  /** Absent until the explicitly enabled editor migration has completed. */
  editor?: EditorAPI;
  digestPipeline?: DigestAPI;
  /** Present only with explicit OCR opt-in and schema migration. */
  ocr?: OcrAPI;
  /** Present only in the isolated E2 build. Credentials never cross this API. */
  asr?: AsrAPI;
  onBeforeClose?(handler: () => Promise<boolean>): () => void;
  state(): Promise<WorkbenchState>;
  sync(platform?: Platform): Promise<void>;
  login(platform: Platform): Promise<void>;
  digest(id: number, value: boolean): Promise<void>;
  review(id: number): Promise<void>;
  retry(id: number, mediaId?: number): Promise<void>;
  retryFailures(): Promise<void>;
  autoSync(value: boolean): Promise<void>;
  setSyncRange?(value: SyncRange): Promise<void>;
  openOriginal(id: number): Promise<void>;
  mediaUrl(id: number): string;
  deletePreview?(ids: number[]): Promise<DeletePreview>;
  deleteContents?(ids: number[]): Promise<DeleteResult>;
  deletedContents?(): Promise<DeletedContent[]>;
  restoreDeleted?(id: number): Promise<void>;
}
