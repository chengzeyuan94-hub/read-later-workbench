// Shared fake adapters/fetch/clock for E4.10 service-level stability rounds.
import type { CollectionItem, CollectionSnapshot, DetailResult, Platform, SourceAdapter, ServiceOptions } from '../../src/shared/contracts.js';
import type { WorkbenchService } from '../../src/main/service.js';

export const sleep = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const until = async (fn: () => boolean, rounds = 400, step = 20) => { for (let i = 0; i < rounds && !fn(); i++) await sleep(step); if (!fn()) throw new Error('等待超时'); };
export const rng = (seed = 1) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000; };

export const fakeItem = (platform: Platform, id: string, collectedAt = 100): CollectionItem => ({
  sourceId: id, title: `${platform}-${id}`, author: 'fixture',
  url: `https://fixture.invalid/${platform}/${id}`, kind: 'text',
  folderIds: ['saved'], collectedAt,
});

export const fakeSnapshot = (platform: Platform, ids: string[], over: Partial<CollectionSnapshot> = {}): CollectionSnapshot => ({
  platform, accountId: 'fixture', accountName: 'fixture',
  folders: [{ id: 'saved', title: 'saved' }],
  items: ids.map((id, index) => fakeItem(platform, id, 1000 - index)),
  complete: false,
  target: { limit: 100, complete: true, reliable: true, reason: 'fixture head' },
  ...over,
});

export const fakeImage = (key: string, kind: 'image' | 'video' = 'image') => ({
  kind, remoteUrl: `https://fixture.invalid/media/${key}`, mime: kind === 'image' ? 'image/png' : 'video/mp4', resourceKey: key,
});

export const fakeDetail = (key: string, kind: 'image' | 'video' = 'image'): DetailResult => ({
  body: `fixture body ${key}`, bodyComplete: true, bodyStatus: 'valid',
  mediaManifestComplete: true, media: [fakeImage(key, kind)],
});

export interface FakeAdapterSpec {
  platform: Platform; ids: string[];
  collect?: (options?: import('../../src/shared/contracts.js').CollectionOptions) => Promise<CollectionSnapshot>;
  detail?: (item: CollectionItem) => Promise<DetailResult>;
  onCollect?: () => void; onDetail?: () => void;
  detailDelay?: number; kind?: 'image' | 'video';
}
export const fakeAdapter = (spec: FakeAdapterSpec): SourceAdapter => ({
  platform: spec.platform,
  collect: async options => { spec.onCollect?.(); return spec.collect ? spec.collect(options) : fakeSnapshot(spec.platform, spec.ids); },
  detail: async item => { spec.onDetail?.(); if (spec.detailDelay) await sleep(spec.detailDelay); return spec.detail ? spec.detail(item) : fakeDetail(item.sourceId, spec.kind); },
  verifyAccount: async () => {},
});

/** A Response whose body streams `bytes` bytes in chunks with a delay between
 * chunks; `stall` aborts mid-body; `truncate` ends the body early. */
export const streamingResponse = ({ bytes = 4096, chunk = 1024, delay = 0, truncate = 0, stallAt, stallMs = 0 }: { bytes?: number; chunk?: number; delay?: number; truncate?: number; stallAt?: number; stallMs?: number }): Response => {
  const total = Math.max(0, bytes - truncate);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0;
      while (sent < total) {
        if (stallAt !== undefined && sent >= stallAt) { if (stallMs) await sleep(stallMs); controller.error(new Error('ECONNRESET mid-body')); return; }
        const size = Math.min(chunk, total - sent);
        controller.enqueue(new Uint8Array(size).fill(65));
        sent += size;
        if (delay) await sleep(delay);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'image/png', 'content-length': String(bytes) } });
};

export type FetchFault = '403' | '404' | '410' | '412' | '429' | '500' | '503' | 'reset' | 'header-timeout' | 'idle-stall' | 'empty' | 'wrong-type' | 'truncated';
export interface FetchPlan { calls: { url: string; at: number }[]; perCall: (url: string, platform: Platform | undefined, index: number) => Promise<Response> }
export const fakeFetch = (handler: (url: string, platform: Platform | undefined, index: number) => Promise<Response>): FetchPlan => {
  const plan: FetchPlan = {
    calls: [],
    perCall: async (url, _init, platform) => { plan.calls.push({ url, at: Date.now() }); return handler(url, platform, plan.calls.length - 1); },
  };
  return plan;
};

export const faultResponse = (fault: FetchFault): Promise<Response> => {
  if (['403', '404', '410', '412', '429', '500', '503'].includes(fault)) return Promise.resolve(new Response('fault', { status: Number(fault) }));
  if (fault === 'reset') return Promise.reject(new Error('ECONNRESET: socket hang up'));
  if (fault === 'header-timeout') return new Promise((_, reject) => setTimeout(() => reject(new Error('fetch header timeout')), 300));
  if (fault === 'idle-stall') return Promise.resolve(streamingResponse({ bytes: 4096, stallAt: 1024, stallMs: 0 }));
  if (fault === 'empty') return Promise.resolve(new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: { 'content-type': 'image/png', 'content-length': '4096' } }));
  if (fault === 'wrong-type') return Promise.resolve(new Response('not-image', { headers: { 'content-type': 'text/html' } }));
  return Promise.resolve(streamingResponse({ bytes: 4096, truncate: 2048 }));
};

export const baseOptions = (over: Partial<ServiceOptions> = {}): ServiceOptions => ({
  connections: () => [], recentImport: { batchId: 'stab-batch', limit: 100 },
  detailTimeoutMs: 5000, collectTimeoutMs: 5000, downloadIdleMs: 2000,
  evidence: () => {}, ...over,
});

export const queueSettled = (service: WorkbenchService) => {
  const state = service.state();
  const busyContents = state.contents.filter(content => ['queued', 'running'].includes(content.detailState)
    || content.media.some(media => ['queued', 'running'].includes(media.state)));
  return busyContents.length === 0 && laneTasksSize(service) === 0;
};

export const laneTasksSize = (service: WorkbenchService) => (service as unknown as { laneTasks: Map<unknown, unknown> }).laneTasks.size;
