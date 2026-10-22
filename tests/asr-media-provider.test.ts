import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ASR_PREPARATION_CONFIG, DEFAULT_FFMPEG_PATH, AsrMediaError, asrFileSha256, inspectPreparedWav, prepareMediaChunks, probeMedia, runAsrProcess, type PreparedAsrChunk } from '../src/main/asr-media.js';
import { ASR_PROVIDER_CONFIG, AsrProviderError, SiliconFlowAsrProvider } from '../src/main/asr-provider.js';

// These are mechanism fixtures: a synthetic PCM tone and injected HTTP responses, never speech quality evidence.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, '.acceptance-data/editor-e2', `unit-media-${Date.now()}-${process.pid}`);
const ffprobePath = path.join(project, '.runtime/qa/package/ffprobe');
function pcm(frames = 20_800): Buffer {
  const bytes = Buffer.alloc(44 + frames * 2); bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI * 2 * 440 / 16000)), 44 + i * 2);
  return bytes;
}
async function fixture(name: string) {
  const dir = path.join(root, name); await mkdir(dir, { recursive: true }); const file = path.join(dir, 'synthetic-tone.wav'), bytes = pcm(); await writeFile(file, bytes);
  return { dir, file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function uploadChunk(name: string): Promise<PreparedAsrChunk> {
  const f = await fixture(name), wav = await inspectPreparedWav(f.file);
  return { order: 0, localPath: f.file, sha256: f.sha256, bytes: f.bytes.length, mime: 'audio/wav', format: 'wav', startMs: 0, endMs: wav.durationMs, durationMs: wav.durationMs, inputRange: { startMs: 0, endMs: wav.durationMs }, startSampleFrame: 0, endSampleFrame: wav.sampleFrames, rangePrecision: 'rounded-ms-from-pcm-frames', sampleFrames: wav.sampleFrames, sampleRate: 16000, channels: 1, audioTrackIndex: 0, originalSha256: f.sha256, configSha256: 'a'.repeat(64), preparationVersion: DEFAULT_ASR_PREPARATION_CONFIG.version };
}
function response(body: unknown, status = 200, headers?: Record<string, string>): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }); }
async function code(promise: Promise<unknown>, expected: string, submitted?: boolean): Promise<void> {
  await assert.rejects(promise, error => (error instanceof AsrMediaError || error instanceof AsrProviderError) && error.code === expected && (submitted === undefined || error instanceof AsrProviderError && error.submitted === submitted));
}

test('ASR local real-tool preparation uses exact contiguous PCM ranges, original digest and actual inspected chunk samples; cache revalidates', async () => {
  const f = await fixture('prepare'), config = { ...DEFAULT_ASR_PREPARATION_CONFIG, chunkDurationMs: 400 };
  const probe = await probeMedia({ originalPath: f.file, expectedSha256: f.sha256, expectedBytes: f.bytes.length, ffmpegPath: DEFAULT_FFMPEG_PATH, ffprobePath });
  assert.equal(probe.mime, 'audio/wav'); assert.equal(probe.durationMs, 1300); assert.equal(probe.audioTrackIndex, 0); assert.match(probe.toolVersions.ffmpeg, /^ffmpeg version/); assert.match(probe.toolVersions.ffprobe, /^ffprobe version/);
  const outputDir = path.join(f.dir, 'prepared'), chunks = await prepareMediaChunks({ probe, outputDir, config });
  assert.ok(chunks.length >= 3); assert.equal(chunks[0].startMs, 0); assert.equal(chunks.at(-1)!.endMs, 1300); assert.equal(chunks.reduce((sum, chunk) => sum + chunk.sampleFrames, 0), 20_800);
  for (const [index, chunk] of chunks.entries()) { assert.equal(chunk.order, index); if (index) assert.equal(chunk.startMs, chunks[index - 1].endMs); assert.equal(chunk.endMs - chunk.startMs, chunk.durationMs); assert.equal(await asrFileSha256(chunk.localPath), chunk.sha256); assert.equal((await stat(chunk.localPath)).size, chunk.bytes); assert.deepEqual(chunk.inputRange, { startMs: chunk.startMs, endMs: chunk.endMs }); }
  assert.ok(chunks.some(chunk => chunk.durationMs !== 400), 'packet boundaries are measured, not labelled with nominal segment lengths');
  assert.deepEqual(await prepareMediaChunks({ probe, outputDir, config }), chunks);
  const changedConfig = await prepareMediaChunks({ probe, outputDir, config: { ...config, chunkDurationMs: 500 } });
  assert.notEqual(changedConfig[0].configSha256, chunks[0].configSha256); assert.notEqual(changedConfig[0].localPath, chunks[0].localPath); assert.equal(changedConfig.at(-1)!.endMs, 1300);
  assert.deepEqual(await readFile(f.file), f.bytes, 'original PCM bytes are unchanged');
  const altered = await readFile(chunks[0].localPath); altered[altered.length - 1] ^= 1; await writeFile(chunks[0].localPath, altered);
  await code(prepareMediaChunks({ probe, outputDir, config }), 'input-mismatch');
});

test('ASR preparation rejects URLs, changed fixed bytes, invalid configs and output outside the E2 namespace before publication', async () => {
  const f = await fixture('boundaries');
  await code(probeMedia({ originalPath: 'https://example.invalid/audio.wav', expectedSha256: f.sha256, expectedBytes: f.bytes.length, ffprobePath }), 'file-unavailable');
  await code(probeMedia({ originalPath: f.file, expectedSha256: 'b'.repeat(64), expectedBytes: f.bytes.length, ffprobePath }), 'input-mismatch');
  const probe = await probeMedia({ originalPath: f.file, expectedSha256: f.sha256, expectedBytes: f.bytes.length, ffprobePath });
  await code(prepareMediaChunks({ probe, outputDir: path.join(project, 'media-asr-must-not-create') }), 'permission-denied');
  await code(prepareMediaChunks({ probe, outputDir: path.join(f.dir, 'invalid'), config: { ...DEFAULT_ASR_PREPARATION_CONFIG, chunkDurationMs: 3_600_000 } }), 'invalid-config');
  await writeFile(f.file, Buffer.concat([f.bytes, Buffer.from('changed')]));
  await code(prepareMediaChunks({ probe, outputDir: path.join(f.dir, 'changed') }), 'input-mismatch');
});

test('ASR fractional-millisecond PCM tails retain exact sample coverage while coarse media-part references stay integer milliseconds', async () => {
  const f = await fixture('fractional-frames'), bytes = pcm(20_801); await writeFile(f.file, bytes);
  const probe = await probeMedia({ originalPath: f.file, expectedSha256: createHash('sha256').update(bytes).digest('hex'), expectedBytes: bytes.length, ffprobePath });
  const chunks = await prepareMediaChunks({ probe, outputDir: path.join(f.dir, 'prepared'), config: { ...DEFAULT_ASR_PREPARATION_CONFIG, chunkDurationMs: 400 } });
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.sampleFrames, 0), 20_801); assert.equal(chunks.at(-1)!.endSampleFrame, 20_801); assert.equal(chunks.at(-1)!.endMs, 1300);
  for (const [index, chunk] of chunks.entries()) { assert.ok(Number.isInteger(chunk.startMs) && Number.isInteger(chunk.endMs)); assert.equal(chunk.rangePrecision, 'rounded-ms-from-pcm-frames'); assert.equal(chunk.endSampleFrame - chunk.startSampleFrame, chunk.sampleFrames); if (index) assert.equal(chunk.startSampleFrame, chunks[index - 1].endSampleFrame); }
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0), 1300.0625);
});

test('ASR local real-tool probe distinguishes a synthetic video without an audio stream and corrupt prepared PCM from empty provider text', async () => {
  const f = await fixture('no-audio'), video = path.join(f.dir, 'synthetic-video-no-audio.mp4');
  await runAsrProcess(DEFAULT_FFMPEG_PATH, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1', '-t', '1', '-c:v', 'mpeg4', '-an', '-f', 'mp4', video], { timeoutMs: 10_000 });
  const bytes = await readFile(video);
  await code(probeMedia({ originalPath: video, expectedSha256: createHash('sha256').update(bytes).digest('hex'), expectedBytes: bytes.length, ffprobePath }), 'no-audio');
  const broken = Buffer.from(f.bytes); broken.writeUInt32LE(broken.length + 100, 4); await writeFile(f.file, broken);
  await code(inspectPreparedWav(f.file), 'decode-failed');
});

test('ASR native process resource boundaries terminate timeout, cancellation and excessive output without shell execution', async () => {
  await code(runAsrProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }), 'tool-timeout');
  const controller = new AbortController(), pending = runAsrProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 5000, signal: controller.signal });
  controller.abort(); await code(pending, 'cancelled');
  await code(runAsrProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024*1024))'], { timeoutMs: 5000, maxOutputBytes: 1024 }), 'tool-output-limit');
  const output = await runAsrProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(touch SHOULD-NOT-EXECUTE);literal'], { timeoutMs: 5000 });
  assert.equal(output.stdout.toString(), '$(touch SHOULD-NOT-EXECUTE);literal');
});

test('ASR provider defaults blocked; missing configuration and a mutated upload produce zero fetches and no submission callback', async () => {
  const chunk = await uploadChunk('provider-gates'); let calls = 0, submissions = 0;
  const fetchImpl = (async () => { calls++; return response({ text: '明确的合成供应商响应' }); }) as typeof fetch, onUploadStart = () => { submissions++; };
  await code(new SiliconFlowAsrProvider({ apiKey: () => 'test-key', fetchImpl }).transcribe({ chunk, onUploadStart }), 'waiting-network', false);
  const missing = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => undefined, fetchImpl }); assert.equal(missing.configured(), false);
  await code(missing.transcribe({ chunk, onUploadStart }), 'waiting-config', false);
  const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => 'test-key', fetchImpl }); assert.equal(provider.configured(), true); assert.equal(calls, 0);
  await code(provider.transcribe({ chunk: { ...chunk, sha256: 'b'.repeat(64) }, onUploadStart }), 'invalid-audio', false);
  assert.equal(calls, 0); assert.equal(submissions, 0);
});

test('ASR provider sends exactly fixed file/model multipart fields to the fixed origin after the durable submission callback', async () => {
  const chunk = await uploadChunk('provider-shape'), order: string[] = [];
  const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => 'unit-secret-only', fetchImpl: (async (url, options) => {
    order.push('fetch'); assert.equal(url, 'https://api.siliconflow.cn/v1/audio/transcriptions'); assert.equal(options!.redirect, 'error'); assert.equal(options!.credentials, 'omit'); assert.equal(options!.method, 'POST');
    assert.deepEqual(Object.keys(options!.headers!), ['Authorization']); assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer unit-secret-only');
    const fields = options!.body as FormData; assert.deepEqual([...fields.keys()], ['file', 'model']); assert.equal(fields.get('model'), 'TeleAI/TeleSpeechASR'); assert.equal((fields.get('file') as File).name, 'audio.wav'); assert.equal((fields.get('file') as File).size, chunk.bytes);
    return response({ text: '合成原稿，不含逐句时间码。' }, 200, { 'x-request-id': 'trace-unit-01' });
  }) as typeof fetch });
  const result = await provider.transcribe({ chunk, onUploadStart: async () => { order.push('durable'); } });
  assert.deepEqual(order, ['durable', 'fetch']); assert.equal(result.text, '合成原稿，不含逐句时间码。'); assert.deepEqual(result.rawResponse, { text: result.text }); assert.equal(result.traceId, 'trace-unit-01'); assert.equal(result.model, ASR_PROVIDER_CONFIG.model); assert.equal(result.responseContract, 'siliconflow-text-only-v1');
});

test('ASR provider respects a failed durable submission fence and refuses credential echoes in otherwise successful provider responses', async () => {
  const chunk = await uploadChunk('provider-fence'); let calls = 0;
  const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => 'unit-secret-only', fetchImpl: (async () => { calls++; return response({ text: 'a response that echoed unit-secret-only' }); }) as typeof fetch });
  await code(provider.transcribe({ chunk, onUploadStart: () => { throw new Error('stale/cancelled request fence'); } }), 'network-error', false); assert.equal(calls, 0);
  await code(provider.transcribe({ chunk, onUploadStart: () => {} }), 'invalid-response', true); assert.equal(calls, 1);
});

test('ASR provider refuses JSON-escaped dummy credential echoes in decoded text, nested metadata and property names', async () => {
  const chunk = await uploadChunk('provider-escaped-echo'), dummyKey = 'unit-secret-escape-only';
  for (const payload of [{ text: dummyKey }, { text: '合成正常文字', metadata: [{ nested: dummyKey }] }, { text: '合成正常文字', [dummyKey]: 'metadata' }]) {
    const encoded = JSON.stringify(payload).replaceAll(dummyKey, '\\u0075' + dummyKey.slice(1));
    assert.equal(encoded.includes(dummyKey), false, 'the raw-byte guard alone cannot catch this fixture');
    const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => dummyKey, fetchImpl: (async () => new Response(encoded, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
    await assert.rejects(provider.transcribe({ chunk, onUploadStart: () => {} }), error => { assert.ok(error instanceof AsrProviderError); assert.equal(error.code, 'invalid-response'); assert.equal(error.submitted, true); assert.equal(error.message.includes(dummyKey), false); return true; });
  }
});

test('ASR provider classifies injected HTTP failures without retaining private bodies; never automatically retries', async () => {
  const chunk = await uploadChunk('provider-errors');
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate-limited'], [500, 'service-unavailable'], [400, 'request-rejected'], [302, 'redirect-refused']] as const) {
    let calls = 0, submitted = 0;
    const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => 'unit-secret-only', fetchImpl: (async () => { calls++; return response({ private: 'unit-secret-only /private/path private transcript' }, status, { 'retry-after': '2', 'x-request-id': 'trace-unit-02' }); }) as typeof fetch });
    await assert.rejects(provider.transcribe({ chunk, onUploadStart: () => { submitted++; } }), error => { assert.ok(error instanceof AsrProviderError); assert.equal(error.code, expected); assert.equal(error.submitted, true); assert.equal(error.status, status); assert.equal(error.traceId, 'trace-unit-02'); if (status === 429) assert.equal(error.retryAfterMs, 2000); assert.doesNotMatch(error.message, /unit-secret|private/); return true; });
    assert.equal(calls, 1); assert.equal(submitted, 1);
  }
});

test('ASR empty, malformed and oversized responses remain explicit failed/unknown results rather than no-speech successes', async () => {
  const chunk = await uploadChunk('provider-bad-response');
  for (const [factory, expected] of [[() => response({ text: '  \n' }), 'empty-text'], [() => response({ transcript: 'wrong field' }), 'invalid-response'], [() => new Response('not-json', { headers: { 'content-type': 'application/json' } }), 'invalid-response'], [() => response({ text: 'x' }, 200, { 'content-length': String(3 * 1024 ** 2) }), 'response-limit']] as const) {
    const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => 'unit-only', fetchImpl: (async () => factory()) as typeof fetch });
    await code(provider.transcribe({ chunk, onUploadStart: () => {} }), expected, true);
  }
});

test('ASR provider timeout/cancel after submission is result-unknown; cancellation before submission does not fetch', async () => {
  const chunk = await uploadChunk('provider-timeout'); let calls = 0;
  const fetchImpl = (async (_url, options) => { calls++; return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('private detail must be hidden')), { once: true })); }) as typeof fetch;
  const provider = new SiliconFlowAsrProvider({ networkAllowed: true, apiKey: () => 'unit-key', timeoutMs: 30, fetchImpl });
  await code(provider.transcribe({ chunk, onUploadStart: () => {} }), 'timeout', true); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await code(provider.transcribe({ chunk, signal: controller.signal, onUploadStart: () => {} }), 'cancelled', false); assert.equal(calls, 1);
  const late = new AbortController(); await code(provider.transcribe({ chunk, signal: late.signal, onUploadStart: () => { late.abort(); } }), 'cancelled', false); assert.equal(calls, 1);
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });
