import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { asrFileSha256, inspectPreparedWav, type PreparedAsrChunk } from './asr-media.js';

const endpoint = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const responseContract = 'siliconflow-text-only-v1' as const;
/** These values and the actual preparation digest participate in the cache identity. */
export const ASR_PROVIDER_CONFIG = Object.freeze({
  provider: 'siliconflow' as const, model: 'TeleAI/TeleSpeechASR' as const,
  responseContract,
  configSha256: createHash('sha256').update(JSON.stringify({ provider: 'siliconflow', endpoint, model: 'TeleAI/TeleSpeechASR', responseContract, multipart: ['file', 'model'], timing: 'unknown-not-provided', maxResponseBytes: 2 * 1024 ** 2 })).digest('hex'),
});
export type AsrProviderErrorCode = 'waiting-config' | 'waiting-network' | 'invalid-audio' | 'cancelled' |
  'unauthorized' | 'rate-limited' | 'service-unavailable' | 'timeout' | 'network-error' | 'redirect-refused' |
  'invalid-response' | 'response-limit' | 'empty-text' | 'request-rejected';
const descriptions: Record<AsrProviderErrorCode, string> = {
  'waiting-config': '等待转录配置：请在主进程配置 SILICONFLOW_API_KEY；尚未上传。',
  'waiting-network': '转录网络已禁用；等待明确恢复联网。', 'invalid-audio': '固定音频的格式、大小或摘要校验失败；尚未上传。',
  cancelled: '转录已取消；已发出的远端调用不保证撤销。',
  unauthorized: '转录服务拒绝凭据，请检查主进程的转录配置。',
  'rate-limited': '转录服务限流，请稍后明确重试。', 'service-unavailable': '转录服务暂时不可用；结果可能未知，请检查后明确重试。',
  timeout: '转录请求超时，结果未知；重新上传可能产生重复调用或计费。',
  'network-error': '转录连接中断，结果未知；重新上传可能产生重复调用或计费。',
  'redirect-refused': '转录服务发生非预期跳转，请求已停止；不会向其他域名发送凭据。',
  'invalid-response': '转录服务响应格式不符合文字原稿契约，未采用该响应。',
  'response-limit': '转录服务响应超过安全上限，未采用该响应。',
  'empty-text': '转录服务返回空文字，不能据此确认没有语音；请检查音频并明确重试。',
  'request-rejected': '转录服务拒绝本次请求，请检查模型是否可用以及音频要求。',
};
export class AsrProviderError extends Error {
  constructor(readonly code: AsrProviderErrorCode, readonly submitted = false, readonly status?: number, readonly traceId?: string, readonly retryAfterMs?: number) {
    super(descriptions[code]); this.name = 'AsrProviderError';
  }
}
export interface AsrProviderResult {
  text: string;
  /** Original parsed provider JSON is immutable source material, not a corrected manuscript. */
  rawResponse: Record<string, unknown>;
  traceId?: string;
  provider: typeof ASR_PROVIDER_CONFIG.provider;
  model: typeof ASR_PROVIDER_CONFIG.model;
  configSha256: string;
  responseContract: typeof responseContract;
}
export interface SiliconFlowAsrProviderOptions {
  /** Main-process policy. Chromium's session network interception does not control Node fetch. */
  networkAllowed?: boolean | (() => boolean);
  apiKey?: () => string | undefined;
  /** Mechanism test injection; production omits this and uses the built-in HTTPS fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
function safeTrace(response: Response): string | undefined {
  const value = response.headers.get('x-request-id') ?? response.headers.get('x-siliconcloud-trace-id') ?? response.headers.get('request-id');
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) ? Math.min(60 * 60_000, Math.max(1000, ms)) : undefined;
}
function containsCredential(value: unknown, credential: string): boolean {
  // Inspect parsed strings and property names as well as the raw UTF-8 body: JSON
  // Unicode escapes must not turn a rejected credential echo into saved text.
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { if (item.includes(credential)) return true; }
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (key.includes(credential)) return true;
      pending.push(child);
    }
  }
  return false;
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const max = 2 * 1024 ** 2, advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > max) { await response.body?.cancel().catch(() => {}); throw new AsrProviderError('response-limit', true); }
  if (!response.body) throw new AsrProviderError('invalid-response', true);
  const reader = response.body.getReader(), bytes: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > max) { await reader.cancel().catch(() => {}); throw new AsrProviderError('response-limit', true); }
      bytes.push(item.value);
    }
    // UTF-8 corruption is a contract error, not text to silently repair.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes)); } catch { throw new AsrProviderError('invalid-response', true); }
  } finally { reader.releaseLock(); }
}
export class SiliconFlowAsrProvider {
  private networkAllowed: boolean | (() => boolean);
  private readonly key: () => string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: SiliconFlowAsrProviderOptions = {}) {
    this.networkAllowed = options.networkAllowed ?? false;
    this.key = options.apiKey ?? (() => process.env.SILICONFLOW_API_KEY);
    this.fetcher = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15 * 60_000) throw new Error('invalid ASR request timeout');
  }
  configured(): boolean { try { const key = this.key(); return typeof key === 'string' && key.trim().length > 0 && !/[\r\n\0]/.test(key); } catch { return false; } }
  setNetworkAllowed(value: boolean): void { this.networkAllowed = value; }
  isNetworkAllowed(): boolean { return typeof this.networkAllowed === 'function' ? this.networkAllowed() : this.networkAllowed; }
  setOnline(value: boolean): void { this.setNetworkAllowed(value); }
  status(): { configured: boolean; online: boolean } { return { configured: this.configured(), online: this.isNetworkAllowed() }; }
  async transcribe(input: { chunk: PreparedAsrChunk; signal?: AbortSignal; onUploadStart: () => void | Promise<void> }): Promise<AsrProviderResult> {
    let submitted = false, timedOut = false;
    const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) throw new AsrProviderError('cancelled');
    input.signal?.addEventListener('abort', abort, { once: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.isNetworkAllowed()) throw new AsrProviderError('waiting-network');
      let key: string | undefined;
      try { key = this.key()?.trim(); } catch { throw new AsrProviderError('waiting-config'); }
      if (!key) throw new AsrProviderError('waiting-config');
      if (/[\r\n\0]/.test(key)) throw new AsrProviderError('waiting-config');
      const chunk = input.chunk;
      let audio: Buffer;
      try {
        if (chunk.mime !== 'audio/wav' || chunk.format !== 'wav' || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 44 || chunk.bytes > 49_000_000 || !Number.isFinite(chunk.durationMs) || chunk.durationMs <= 0 || chunk.durationMs > 50 * 60_000 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error();
        if ((await stat(chunk.localPath)).size !== chunk.bytes || await asrFileSha256(chunk.localPath, controller.signal) !== chunk.sha256) throw new Error();
        const wav = await inspectPreparedWav(chunk.localPath);
        if (wav.durationMs !== chunk.durationMs || wav.sampleFrames !== chunk.sampleFrames) throw new Error();
        audio = await readFile(chunk.localPath);
        if (audio.length !== chunk.bytes || createHash('sha256').update(audio).digest('hex') !== chunk.sha256) throw new Error();
      } catch { if (controller.signal.aborted) throw new AsrProviderError('cancelled'); throw new AsrProviderError('invalid-audio'); }
      if (controller.signal.aborted) throw new AsrProviderError('cancelled');
      if (!this.isNetworkAllowed()) throw new AsrProviderError('waiting-network');
      const body = new FormData();
      body.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
      body.set('model', ASR_PROVIDER_CONFIG.model);
      // Durable caller fencing must succeed before even a potentially submitted HTTP request.
      await input.onUploadStart();
      if (controller.signal.aborted) throw new AsrProviderError('cancelled');
      if (!this.isNetworkAllowed()) throw new AsrProviderError('waiting-network');
      submitted = true;
      deadline = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs); deadline.unref();
      const response = await this.fetcher(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      const candidateTrace = safeTrace(response), traceId = candidateTrace?.includes(key) ? undefined : candidateTrace;
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new AsrProviderError('redirect-refused', true, response.status, traceId); }
      if (!response.ok) {
        // Error bodies can echo private text or credentials; never log, persist or display them.
        await response.body?.cancel().catch(() => {});
        const code: AsrProviderErrorCode = [401, 403].includes(response.status) ? 'unauthorized' : response.status === 429 ? 'rate-limited' : response.status >= 500 ? 'service-unavailable' : 'request-rejected';
        throw new AsrProviderError(code, true, response.status, traceId, retryAfter(response));
      }
      if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') { await response.body?.cancel().catch(() => {}); throw new AsrProviderError('invalid-response', true, response.status, traceId); }
      const raw = await boundedBody(response, controller.signal);
      if (raw.includes(key)) throw new AsrProviderError('invalid-response', true, response.status, traceId);
      let rawResponse: Record<string, unknown>;
      try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.text !== 'string') throw new Error(); rawResponse = parsed; } catch { throw new AsrProviderError('invalid-response', true, response.status, traceId); }
      if (containsCredential(rawResponse, key)) throw new AsrProviderError('invalid-response', true, response.status, traceId);
      if (!String(rawResponse.text).trim()) throw new AsrProviderError('empty-text', true, response.status, traceId);
      if (controller.signal.aborted) throw new AsrProviderError(input.signal?.aborted ? 'cancelled' : 'timeout', true);
      return { text: String(rawResponse.text), rawResponse, ...(traceId ? { traceId } : {}), ...ASR_PROVIDER_CONFIG };
    } catch (error) {
      if (error instanceof AsrProviderError) throw error;
      if (controller.signal.aborted) throw new AsrProviderError(input.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network-error', submitted);
      const cause = (error as { cause?: { message?: unknown; code?: unknown } })?.cause;
      if (cause?.code === 'UND_ERR_REDIRECT' || cause?.message === 'unexpected redirect') throw new AsrProviderError('redirect-refused', submitted);
      // Do not expose errors supplied by Node/network libraries: URLs, request headers or key values may be embedded.
      throw new AsrProviderError('network-error', submitted);
    } finally { if (deadline) clearTimeout(deadline); input.signal?.removeEventListener('abort', abort); }
  }
}
