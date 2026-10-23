import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { renameRetry } from './fs-paths.js';
import { resolveMediaTool } from './media-tools.js';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Local tools only: env override → bundled installer → repo QA package → PATH; never downloads. */
export const DEFAULT_FFMPEG_PATH = resolveMediaTool('ffmpeg', process.env.RLW_FFMPEG);
export const DEFAULT_FFPROBE_PATH = resolveMediaTool('ffprobe', process.env.RLW_FFPROBE);
export interface AsrPreparationConfig {
  version: 'pcm16-mono-16k-contiguous-v1';
  sampleRate: 16000;
  channels: 1;
  chunkDurationMs: number;
  maxInputBytes: number;
  maxDurationMs: number;
  maxChunks: number;
  maxChunkBytes: number;
  maxPreparedBytes: number;
  probeTimeoutMs: number;
  preparationTimeoutMs: number;
}
export const DEFAULT_ASR_PREPARATION_CONFIG: Readonly<AsrPreparationConfig> = Object.freeze({
  version: 'pcm16-mono-16k-contiguous-v1', sampleRate: 16000, channels: 1,
  chunkDurationMs: 10 * 60_000, maxInputBytes: 8 * 1024 ** 3, maxDurationMs: 8 * 60 * 60_000,
  maxChunks: 128, maxChunkBytes: 40_000_000, maxPreparedBytes: 1024 ** 3,
  probeTimeoutMs: 30_000, preparationTimeoutMs: 30 * 60_000,
});
export interface AsrToolVersions { ffmpeg: string; ffprobe: string; ffmpegPath: string; ffprobePath: string }
export interface AsrMediaProbe {
  originalPath: string; sha256: string; bytes: number; mime: string;
  /** Container/audio duration is diagnostic. Final ranges use actual decoded PCM frame counts. */
  durationMs: number; audioStartMs: number; audioTrackIndex: number; audioCodec: string;
  formatName: string; toolVersions: AsrToolVersions;
}
export interface PreparedAsrChunk {
  order: number; localPath: string; sha256: string; bytes: number; mime: 'audio/wav'; format: 'wav';
  startMs: number; endMs: number; durationMs: number;
  inputRange: { startMs: number; endMs: number };
  /** Integer-ms public coarse bounds; exact decoded boundaries remain separately inspectable. */
  startSampleFrame: number; endSampleFrame: number; rangePrecision: 'rounded-ms-from-pcm-frames';
  sampleFrames: number; sampleRate: 16000; channels: 1; audioTrackIndex: number;
  originalSha256: string; configSha256: string; preparationVersion: AsrPreparationConfig['version'];
}
export type AsrMediaErrorCode = 'dependency-unavailable' | 'cancelled' | 'tool-timeout' | 'tool-output-limit' |
  'file-unavailable' | 'input-mismatch' | 'unsupported-media' | 'no-audio' | 'decode-failed' |
  'duration-limit' | 'size-limit' | 'invalid-config' | 'disk-full' | 'permission-denied';
const messages: Record<AsrMediaErrorCode, string> = {
  'dependency-unavailable': '本地 FFmpeg／FFprobe 不可用，请检查工具路径；不会自动下载工具。',
  cancelled: '已取消本地音频准备。', 'tool-timeout': '本地媒体处理超时，可检查原件后重试。',
  'tool-output-limit': '媒体工具输出超过安全上限，处理已停止。', 'file-unavailable': '本地原件或准备目录暂时无法读取。',
  'input-mismatch': '固定原件的大小或摘要已变化，请按当前资料重新消化。',
  'unsupported-media': '本地文件不是受支持的音视频原件。', 'no-audio': '原件中没有可处理的音轨。',
  'decode-failed': '本地音轨无法完整解码；未将部分抽音当作完整资料。',
  'duration-limit': '本地音轨时长超过本轮处理上限。', 'size-limit': '原件或准备音频超过本轮安全上限。',
  'invalid-config': '音频准备配置无效，尚未上传。', 'disk-full': '本地磁盘空间不足，请释放空间后重试。',
  'permission-denied': '音频准备目录没有读写权限，请恢复权限后重试。',
};
export class AsrMediaError extends Error {
  constructor(readonly code: AsrMediaErrorCode) { super(messages[code]); this.name = 'AsrMediaError'; }
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function checkedConfig(input: Readonly<AsrPreparationConfig> = DEFAULT_ASR_PREPARATION_CONFIG): AsrPreparationConfig {
  const c = { ...input };
  if (c.version !== 'pcm16-mono-16k-contiguous-v1' || c.sampleRate !== 16000 || c.channels !== 1 ||
    Object.keys(c).length !== Object.keys(DEFAULT_ASR_PREPARATION_CONFIG).length ||
    Object.entries(c).some(([key, value]) => key !== 'version' && (!Number.isSafeInteger(value) || Number(value) <= 0)) ||
    c.chunkDurationMs < 50 || c.chunkDurationMs > 50 * 60_000 || c.maxChunkBytes > 49_000_000 ||
    c.chunkDurationMs / 1000 * 32000 + 100_000 > c.maxChunkBytes || c.maxDurationMs > 24 * 60 * 60_000 ||
    c.maxChunks > 1024 || c.maxInputBytes > 16 * 1024 ** 3 || c.maxPreparedBytes > 4 * 1024 ** 3 ||
    c.probeTimeoutMs > 120_000 || c.preparationTimeoutMs > 60 * 60_000) throw new AsrMediaError('invalid-config');
  return c;
}
export function asrPreparationConfigSha256(config: Readonly<AsrPreparationConfig>, tools: AsrToolVersions): string {
  const c = checkedConfig(config);
  return hash(JSON.stringify({ config: c, toolVersions: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }, selection: 'first-audio-stream-in-container-order', range: 'decoded-pcm-frame-count-rounded-ms-no-overlap-v1' }));
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new AsrMediaError('cancelled'); }
function mediaError(error: unknown): AsrMediaError {
  if (error instanceof AsrMediaError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new AsrMediaError(code === 'ENOSPC' || code === 'EDQUOT' ? 'disk-full' : ['EACCES', 'EPERM', 'EROFS'].includes(code ?? '') ? 'permission-denied' : 'file-unavailable');
}
async function localFile(file: string): Promise<string> {
  if (!path.isAbsolute(file) || file !== path.normalize(file) || /[\0\r\n]/.test(file)) throw new AsrMediaError('file-unavailable');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new AsrMediaError('file-unavailable');
  // Mode checks remain meaningful when a development process has elevated privileges.
  if (!(info.mode & 0o444)) throw new AsrMediaError('permission-denied');
  await access(file, constants.R_OK);
  return file;
}
export async function asrFileSha256(file: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  try {
    await localFile(file); checkAbort(signal);
    for await (const bytes of createReadStream(file, { signal })) digest.update(bytes);
    checkAbort(signal); return digest.digest('hex');
  } catch (error) { checkAbort(signal); throw mediaError(error); }
}

/** No shell, no inherited stdin, bounded captured output, cancellation and hard termination. */
export function runAsrProcess(file: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number; cwd?: string; onTick?: () => Promise<void> }): Promise<{ stdout: Buffer; stderr: Buffer }> {
  checkAbort(options.signal);
  return new Promise((resolve, reject) => {
    let settled = false, error: unknown, total = 0, checking = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}), env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    let hard: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: AsrMediaError) => { if (!error) error = reason; child.kill('SIGTERM'); if (!hard) { hard = setTimeout(() => child.kill('SIGKILL'), 500); hard.unref(); } };
    const abort = () => terminate(new AsrMediaError('cancelled'));
    const deadline = setTimeout(() => terminate(new AsrMediaError('tool-timeout')), options.timeoutMs); deadline.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const tick = options.onTick ? setInterval(() => {
      if (checking || settled) return; checking = true;
      void options.onTick!().catch(reason => terminate(mediaError(reason))).finally(() => { checking = false; });
    }, 250) : undefined;
    tick?.unref();
    const collect = (target: Buffer[]) => (bytes: Buffer) => {
      total += bytes.length;
      if (total > (options.maxOutputBytes ?? 1024 ** 2)) { terminate(new AsrMediaError('tool-output-limit')); return; }
      target.push(bytes);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', () => { error ??= new AsrMediaError('dependency-unavailable'); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(deadline); if (hard) clearTimeout(hard); if (tick) clearInterval(tick);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString('utf8');
        reject(new AsrMediaError(/No space left on device|Disk quota exceeded/.test(diagnostic) ? 'disk-full' : /Permission denied|Read-only file system/.test(diagnostic) ? 'permission-denied' : 'decode-failed'));
      }
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}
async function tool(file: string, signal?: AbortSignal): Promise<{ file: string; version: string }> {
  try {
    if (!path.isAbsolute(file) || file !== path.normalize(file)) throw new Error();
    // Explicit, user-installed tool symlinks are resolved and recorded; input/output symlinks are rejected.
    const resolved = await realpath(file), info = await stat(resolved);
    if (!info.isFile()) throw new Error(); await access(resolved, constants.X_OK);
    const output = await runAsrProcess(resolved, ['-version'], { signal, timeoutMs: 10_000, maxOutputBytes: 64_000 });
    const version = output.stdout.toString('utf8').split(/\r?\n/, 1)[0];
    if (!/^(ffmpeg|ffprobe) version [^\r\n]{1,200}$/.test(version)) throw new Error();
    return { file: resolved, version };
  } catch (error) { checkAbort(signal); if (error instanceof AsrMediaError && ['tool-timeout', 'tool-output-limit'].includes(error.code)) throw error; throw new AsrMediaError('dependency-unavailable'); }
}
function sniffMime(header: Buffer, format: string, audioOnly: boolean): string {
  if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (header.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (header.subarray(0, 4).toString() === 'OggS') return audioOnly ? 'audio/ogg' : 'video/ogg';
  if (header.subarray(4, 8).toString() === 'ftyp') return audioOnly ? 'audio/mp4' : 'video/mp4';
  if (header.subarray(0, 3).toString() === 'FLV') return 'video/x-flv';
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return audioOnly ? 'audio/webm' : 'video/webm';
  if (header.subarray(0, 3).toString() === 'ID3' || header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return /aac/.test(format) ? 'audio/aac' : 'audio/mpeg';
  throw new AsrMediaError('unsupported-media');
}
async function readHeader(file: string): Promise<Buffer> {
  const fd = await open(file, 'r'), header = Buffer.alloc(64);
  try { await fd.read(header, 0, header.length, 0); return header; } finally { await fd.close(); }
}
export async function probeMedia(input: { originalPath: string; expectedSha256: string; expectedBytes: number; ffmpegPath?: string; ffprobePath?: string; config?: Readonly<AsrPreparationConfig>; signal?: AbortSignal }): Promise<AsrMediaProbe> {
  try {
    const config = checkedConfig(input.config); checkAbort(input.signal);
    const originalPath = await localFile(input.originalPath), info = await stat(originalPath);
    if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0 || info.size !== input.expectedBytes) throw new AsrMediaError('input-mismatch');
    if (info.size > config.maxInputBytes) throw new AsrMediaError('size-limit');
    const sha256 = await asrFileSha256(originalPath, input.signal);
    if (sha256 !== input.expectedSha256) throw new AsrMediaError('input-mismatch');
    // Reject playlists/scripts before any demuxer can follow referenced files. A PNG is permitted
    // for the explicit no-audio diagnosis, never decoded into an upload.
    const header = await readHeader(originalPath), png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (png) throw new AsrMediaError('no-audio');
    sniffMime(header, '', false);
    const [ffmpeg, ffprobe] = await Promise.all([tool(input.ffmpegPath ?? DEFAULT_FFMPEG_PATH, input.signal), tool(input.ffprobePath ?? DEFAULT_FFPROBE_PATH, input.signal)]);
    const response = await runAsrProcess(ffprobe.file, ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-print_format', 'json', originalPath], { signal: input.signal, timeoutMs: config.probeTimeoutMs, maxOutputBytes: 1024 ** 2 });
    let json: any; try { json = JSON.parse(response.stdout.toString('utf8')); } catch { throw new AsrMediaError('decode-failed'); }
    if (!Array.isArray(json.streams) || !json.format || typeof json.format.format_name !== 'string') throw new AsrMediaError('decode-failed');
    const stream = json.streams.find((candidate: any) => candidate.codec_type === 'audio');
    if (!stream) throw new AsrMediaError('no-audio');
    if (!Number.isSafeInteger(stream.index) || stream.index < 0 || typeof stream.codec_name !== 'string') throw new AsrMediaError('decode-failed');
    const formatStart = Number(json.format.start_time ?? 0), audioStart = Number(stream.start_time ?? formatStart);
    const audioStartMs = Math.max(0, Math.round((audioStart - formatStart) * 1000));
    const durationMs = Math.round(Number(stream.duration ?? (Number(json.format.duration) - audioStartMs / 1000)) * 1000);
    if (!Number.isFinite(audioStartMs) || !Number.isFinite(durationMs) || durationMs <= 0) throw new AsrMediaError('decode-failed');
    if (durationMs > config.maxDurationMs) throw new AsrMediaError('duration-limit');
    const mime = sniffMime(header, json.format.format_name, !json.streams.some((candidate: any) => candidate.codec_type === 'video'));
    if (await asrFileSha256(originalPath, input.signal) !== sha256) throw new AsrMediaError('input-mismatch');
    return { originalPath, sha256, bytes: info.size, mime, durationMs, audioStartMs, audioTrackIndex: stream.index, audioCodec: stream.codec_name, formatName: json.format.format_name, toolVersions: { ffmpeg: ffmpeg.version, ffprobe: ffprobe.version, ffmpegPath: ffmpeg.file, ffprobePath: ffprobe.file } };
  } catch (error) { checkAbort(input.signal); throw mediaError(error); }
}

interface WavInfo { sampleFrames: number; sampleRate: 16000; channels: 1; durationMs: number }
/** Exact PCM frame count, not a guessed container duration; the upload boundary is a real input range. */
export async function inspectPreparedWav(file: string): Promise<WavInfo> {
  await localFile(file); const info = await stat(file); const fd = await open(file, 'r');
  try {
    const head = Buffer.alloc(12); if ((await fd.read(head, 0, 12, 0)).bytesRead !== 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE' || head.readUInt32LE(4) + 8 !== info.size) throw new AsrMediaError('decode-failed');
    let cursor = 12, fmt: Buffer | undefined, dataBytes: number | undefined;
    for (let chunks = 0; cursor + 8 <= info.size && chunks < 128; chunks++) {
      const block = Buffer.alloc(8); await fd.read(block, 0, 8, cursor);
      const name = block.toString('ascii', 0, 4), size = block.readUInt32LE(4); cursor += 8;
      if (cursor + size > info.size) throw new AsrMediaError('decode-failed');
      if (name === 'fmt ') { if (size < 16 || size > 128) throw new AsrMediaError('decode-failed'); fmt = Buffer.alloc(size); await fd.read(fmt, 0, size, cursor); }
      if (name === 'data') { if (dataBytes !== undefined) throw new AsrMediaError('decode-failed'); dataBytes = size; }
      cursor += size + (size & 1);
    }
    if (cursor !== info.size || !fmt || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== 16000 || fmt.readUInt32LE(8) !== 32000 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16 || !dataBytes || dataBytes % 2) throw new AsrMediaError('decode-failed');
    const sampleFrames = dataBytes / 2;
    return { sampleFrames, sampleRate: 16000, channels: 1, durationMs: sampleFrames / 16 };
  } finally { await fd.close(); }
}
/** Lexical check only; outputDirectory also validates every actual ancestor before writing. */
export function isAsrPreparationNamespacePath(dir: string): boolean {
  const parts = path.normalize(dir).split(path.sep), namespace = parts.lastIndexOf('.acceptance-data');
  return path.isAbsolute(dir) && dir === path.normalize(dir) && namespace >= 0 && (['editor-e2', 'editor-e3', 'editor-e3-fix', 'editor-e3-real'].includes(parts[namespace + 1]) && !!parts[namespace + 2] || parts[namespace + 1] === 'batch-sync' && /^e42-[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(parts[namespace + 2] ?? '')) && !/[\0\r\n]/.test(dir);
}
async function outputDirectory(dir: string): Promise<string> {
  if (!isAsrPreparationNamespacePath(dir)) throw new AsrMediaError('permission-denied');
  const parts = dir.split(path.sep);
  // Check each ancestor before creating anything, preventing writes through a link.
  let cursor = path.parse(dir).root;
  for (const part of parts.filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new AsrMediaError('permission-denied'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(cursor, { mode: 0o700 }); }
  }
  if (await realpath(dir) !== dir || !((await stat(dir)).mode & 0o222)) throw new AsrMediaError('permission-denied');
  return dir;
}
function validateProbe(probe: AsrMediaProbe, config: AsrPreparationConfig): void {
  if (!probe || !/^[a-f0-9]{64}$/.test(probe.sha256) || !Number.isSafeInteger(probe.bytes) || probe.bytes <= 0 || probe.bytes > config.maxInputBytes ||
    !Number.isSafeInteger(probe.audioTrackIndex) || probe.audioTrackIndex < 0 || !Number.isFinite(probe.audioStartMs) || probe.audioStartMs < 0 ||
    !Number.isFinite(probe.durationMs) || probe.durationMs <= 0 || probe.durationMs > config.maxDurationMs || !probe.toolVersions ||
    typeof probe.toolVersions.ffmpeg !== 'string' || typeof probe.toolVersions.ffprobe !== 'string') throw new AsrMediaError('input-mismatch');
}
async function syncFile(file: string): Promise<void> { const fd = await open(file, 'r+'); try { await fd.sync(); } finally { await fd.close(); } }
async function syncDirectory(dir: string): Promise<void> { const fd = await open(dir, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
export async function prepareMediaChunks(input: { probe: AsrMediaProbe; outputDir: string; config?: Readonly<AsrPreparationConfig>; signal?: AbortSignal }): Promise<PreparedAsrChunk[]> {
  let staging: string | undefined;
  try {
    const config = checkedConfig(input.config), { probe } = input; checkAbort(input.signal); validateProbe(probe, config);
    await localFile(probe.originalPath);
    if ((await stat(probe.originalPath)).size !== probe.bytes || await asrFileSha256(probe.originalPath, input.signal) !== probe.sha256) throw new AsrMediaError('input-mismatch');
    const ffmpeg = await tool(probe.toolVersions.ffmpegPath, input.signal);
    if (ffmpeg.version !== probe.toolVersions.ffmpeg) throw new AsrMediaError('dependency-unavailable');
    const configSha256 = asrPreparationConfigSha256(config, probe.toolVersions), identity = hash(JSON.stringify({ originalSha256: probe.sha256, originalBytes: probe.bytes, audioTrackIndex: probe.audioTrackIndex, audioStartMs: probe.audioStartMs, configSha256 }));
    const outputDir = await outputDirectory(input.outputDir), published = path.join(outputDir, `prepared-${identity}`);
    try {
      if ((await lstat(published)).isSymbolicLink() || await realpath(published) !== published) throw new AsrMediaError('input-mismatch');
      const manifestPath = await localFile(path.join(published, 'manifest.json'));
      if ((await stat(manifestPath)).size > 1024 ** 2) throw new AsrMediaError('input-mismatch');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.schemaVersion !== 1 || manifest.identity !== identity || manifest.originalSha256 !== probe.sha256 || manifest.configSha256 !== configSha256 || JSON.stringify(manifest.config) !== JSON.stringify(config) || JSON.stringify(manifest.toolVersions) !== JSON.stringify(probe.toolVersions) || manifest.coverage !== 'complete-decoded-audio-track' || manifest.overlap !== false || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > config.maxChunks) throw new AsrMediaError('input-mismatch');
      const cached: PreparedAsrChunk[] = []; let totalFrames = 0, totalBytes = 0;
      for (const item of manifest.chunks) {
        const localPath = path.join(published, item.file);
        if (item.file !== `chunk-${String(item.order).padStart(6, '0')}.wav` || item.order !== cached.length || item.configSha256 !== configSha256 || item.originalSha256 !== probe.sha256 || item.preparationVersion !== config.version || item.mime !== 'audio/wav' || item.format !== 'wav' || item.sampleRate !== 16000 || item.channels !== 1 || item.audioTrackIndex !== probe.audioTrackIndex || !Number.isSafeInteger(item.bytes) || item.bytes > config.maxChunkBytes || (await stat(localPath)).size !== item.bytes || await asrFileSha256(localPath, input.signal) !== item.sha256) throw new AsrMediaError('input-mismatch');
        const wav = await inspectPreparedWav(localPath);
        const startSampleFrame = totalFrames, startMs = probe.audioStartMs + Math.round(totalFrames / 16); totalFrames += wav.sampleFrames; const endMs = probe.audioStartMs + Math.round(totalFrames / 16); totalBytes += item.bytes;
        if (wav.sampleFrames !== item.sampleFrames || wav.durationMs !== item.durationMs || item.startSampleFrame !== startSampleFrame || item.endSampleFrame !== totalFrames || item.rangePrecision !== 'rounded-ms-from-pcm-frames' || item.startMs !== startMs || item.endMs !== endMs || item.inputRange?.startMs !== startMs || item.inputRange?.endMs !== endMs || wav.durationMs > 50 * 60_000) throw new AsrMediaError('input-mismatch');
        const { file: _file, ...chunk } = item; cached.push({ ...chunk, localPath });
      }
      if (manifest.actualDecodedDurationMs !== totalFrames / 16 || manifest.containerDurationMs !== probe.durationMs || totalFrames / 16 > config.maxDurationMs || totalBytes > config.maxPreparedBytes) throw new AsrMediaError('input-mismatch');
      return cached;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    staging = path.join(outputDir, `.prepare-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
    const limits = async () => {
      const files = (await readdir(staging!)).filter(file => /^chunk-\d{6}\.wav$/.test(file));
      if (files.length > config.maxChunks) throw new AsrMediaError('size-limit');
      let bytes = 0; for (const file of files) { const count = (await stat(path.join(staging!, file))).size; if (count > config.maxChunkBytes) throw new AsrMediaError('size-limit'); bytes += count; }
      if (bytes > config.maxPreparedBytes) throw new AsrMediaError('size-limit');
    };
    await runAsrProcess(ffmpeg.file, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-err_detect', 'explode', '-i', probe.originalPath, '-map', `0:${probe.audioTrackIndex}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-t', String(config.maxDurationMs / 1000 + .1), '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-f', 'segment', '-segment_time', String(config.chunkDurationMs / 1000), '-reset_timestamps', '1', '-segment_format', 'wav', path.join(staging, 'chunk-%06d.wav')], { signal: input.signal, timeoutMs: config.preparationTimeoutMs, maxOutputBytes: 128_000, onTick: limits });
    await limits(); checkAbort(input.signal);
    const files = (await readdir(staging)).filter(file => /^chunk-\d{6}\.wav$/.test(file)).sort();
    if (!files.length) throw new AsrMediaError('decode-failed');
    const chunks: PreparedAsrChunk[] = []; let totalFrames = 0;
    for (const [order, file] of files.entries()) {
      const localPath = path.join(staging, file), wav = await inspectPreparedWav(localPath), bytes = (await stat(localPath)).size;
      const startSampleFrame = totalFrames, startMs = probe.audioStartMs + Math.round(totalFrames / 16); totalFrames += wav.sampleFrames; const endMs = probe.audioStartMs + Math.round(totalFrames / 16);
      if (bytes > config.maxChunkBytes) throw new AsrMediaError('size-limit');
      if (wav.durationMs > 50 * 60_000 || totalFrames / 16 > config.maxDurationMs) throw new AsrMediaError('duration-limit');
      if (file !== `chunk-${String(order).padStart(6, '0')}.wav`) throw new AsrMediaError('decode-failed');
      chunks.push({ order, localPath: path.join(published, file), sha256: await asrFileSha256(localPath, input.signal), bytes, mime: 'audio/wav', format: 'wav', startMs, endMs, durationMs: wav.durationMs, inputRange: { startMs, endMs }, startSampleFrame, endSampleFrame: totalFrames, rangePrecision: 'rounded-ms-from-pcm-frames', sampleFrames: wav.sampleFrames, sampleRate: 16000, channels: 1, audioTrackIndex: probe.audioTrackIndex, originalSha256: probe.sha256, configSha256, preparationVersion: config.version });
      await syncFile(localPath);
    }
    // A short successful decode cannot silently claim an entire known audio track.
    if (Math.abs(totalFrames / 16 - probe.durationMs) > Math.max(250, probe.durationMs * .002)) throw new AsrMediaError('decode-failed');
    if ((await stat(probe.originalPath)).size !== probe.bytes || await asrFileSha256(probe.originalPath, input.signal) !== probe.sha256) throw new AsrMediaError('input-mismatch');
    const manifest = { schemaVersion: 1, identity, originalSha256: probe.sha256, configSha256, config, toolVersions: probe.toolVersions, containerDurationMs: probe.durationMs, actualDecodedDurationMs: totalFrames / 16, coverage: 'complete-decoded-audio-track', overlap: false, chunks: chunks.map(({ localPath, ...chunk }) => ({ ...chunk, file: path.basename(localPath) })) };
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }); await syncFile(path.join(staging, 'manifest.json')); await syncDirectory(staging); checkAbort(input.signal);
    await renameRetry(staging, published); staging = undefined; await syncDirectory(outputDir);
    return chunks;
  } catch (error) { checkAbort(input.signal); throw mediaError(error); }
  finally { if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {}); }
}
