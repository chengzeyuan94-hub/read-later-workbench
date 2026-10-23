import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { samePath, toStoredPath } from './fs-paths.js';
import type { E1Paths } from './e1-isolation.js';

export const BATCH_LOGIN_PLATFORMS = ['xiaohongshu','bilibili','weibo','zhihu','twitter'] as const;
export interface BatchPaths extends E1Paths {
  sourceSessionDataDir: string;
  sourcePartitions: Record<typeof BATCH_LOGIN_PLATFORMS[number], string>;
  credentialUserDataDirs: { siliconflow: string; deepseek: string };
}
export interface BatchRuntimeSources {
  /** Historical markers may contain the former profile. It is never used by the current runtime. */
  sourceUserDataDir?: string;
  sessionMode?: 'isolated-five-platforms';
  credentialUserDataDirs: BatchPaths['credentialUserDataDirs'];
}
function entry(file: string) { try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } }
export function assertBatchOrdinaryPath(file: string): void {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.endsWith(path.sep)) throw Error('批量运行需要规范绝对路径');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) { current = path.join(current, part); if (entry(current)?.isSymbolicLink()) throw Error('批量运行拒绝符号链接'); }
  if (entry(file) && !samePath(realpathSync(file), file)) throw Error('批量运行拒绝路径别名');
}
export function batchBuildMode(buildRoot: string, environment: Record<string, string | undefined>): boolean {
  if (/^batch-e42-[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(path.basename(buildRoot))) {
    const incompatible = ['RLW_E3_REAL_DIR','RLW_E3_FIX_DIR','RLW_E3_DIR','RLW_E2_DIR','RLW_E112_DIR','RLW_E111_DIR','RLW_E11_DIR','RLW_E1_DIR','RLW_E1_ISOLATED','RLW_DATA_DIR','RLW_USER_DATA_DIR','RLW_SOURCE_MODE','RLW_BRIDGE_PROFILE','RLW_LOGIN','RLW_RETRY_CONTENT','RLW_ENABLE_EDITOR'];
    if (!environment.RLW_BATCH_DIR || incompatible.some(key => environment[key] !== undefined)) throw Error('批量构建只能使用明确的新批量资料根');
    return true;
  }
  if (environment.RLW_BATCH_DIR !== undefined) throw Error('批量资料根只能由独立批量构建打开');
  return false;
}
/** Credentials are referenced by directory only. Platform profiles are always new-root local. */
export function validateBatchRuntimeSources(value: BatchRuntimeSources, projectRoot: string, newUserDataDir: string): Pick<BatchPaths, 'sourceSessionDataDir' | 'sourcePartitions' | 'credentialUserDataDirs'> {
  assertBatchOrdinaryPath(newUserDataDir);
  const localRelative = toStoredPath(path.relative(path.resolve(projectRoot, '.acceptance-data/batch-sync'), newUserDataDir));
  if (!/^e42-[-a-zA-Z0-9_]+\/userData$/.test(localRelative)) throw Error('平台登录会话必须位于本轮独立资料根');
  const sourcePartitions = Object.fromEntries(BATCH_LOGIN_PLATFORMS.map(platform => [platform,path.join(newUserDataDir,`Partitions/rlw-${platform}`)])) as BatchPaths['sourcePartitions'];
  for (const directory of Object.values(sourcePartitions)) assertBatchOrdinaryPath(directory);
  for (const directory of Object.values(value.credentialUserDataDirs)) {
    assertBatchOrdinaryPath(directory);
    const relative = toStoredPath(path.relative(path.resolve(projectRoot, '.acceptance-data'), directory));
    if (!/^(editor-e2|editor-e3|editor-e3-fix|editor-e3-real)\/[-a-zA-Z0-9_]+\/userData$/.test(relative) || !entry(directory)?.isDirectory()) throw Error('处理凭据来源必须是明确的既有安全配置目录');
  }
  return { sourceSessionDataDir: newUserDataDir, sourcePartitions, credentialUserDataDirs: value.credentialUserDataDirs };
}
export function resolveBatchPaths(value: string | undefined, options: { mustExist?: boolean; projectRoot?: string; expectedSourceUserDataDir?: string } = {}): BatchPaths {
  const project = path.resolve(options.projectRoot ?? process.cwd()), allowed = path.join(project, '.acceptance-data/batch-sync');
  if (!value || path.dirname(value) !== allowed || !/^e42-[-a-zA-Z0-9_]+$/.test(path.basename(value))) throw Error('批量运行需要 .acceptance-data/batch-sync 下的明确新资料根');
  assertBatchOrdinaryPath(value);
  const ordinary = { root: value, dataDir: path.join(value, 'data'), userDataDir: path.join(value, 'userData'), assetsDir: path.join(value, 'editor-assets'), exportsDir: path.join(value, 'exports'), evidenceDir: path.join(value, 'evidence') };
  for (const file of [...Object.values(ordinary), path.join(value, 'batch-isolated.json'), path.join(ordinary.dataDir, 'workbench.sqlite'), ...['media','digest-inputs','ocr-results','asr-results','asr-prepared','asr-inputs','generation-results','generation-responses'].map(name => path.join(ordinary.dataDir, name))]) assertBatchOrdinaryPath(file);
  const sourcePartitions = Object.fromEntries(BATCH_LOGIN_PLATFORMS.map(platform => [platform,path.join(ordinary.userDataDir,`Partitions/rlw-${platform}`)])) as BatchPaths['sourcePartitions'];
  for(const directory of Object.values(sourcePartitions))assertBatchOrdinaryPath(directory);
  if (!options.mustExist) return { ...ordinary, sourceSessionDataDir: ordinary.userDataDir, sourcePartitions, credentialUserDataDirs: { siliconflow: '', deepseek: '' } };
  for (const file of Object.values(ordinary)) if (!entry(file)?.isDirectory()) throw Error('批量运行目录尚未准备');
  if (!entry(path.join(ordinary.dataDir, 'workbench.sqlite'))?.isFile()) throw Error('批量运行数据库尚未准备');
  const marker = JSON.parse(readFileSync(path.join(value, 'batch-isolated.json'), 'utf8'));
  if (marker.schema !== 1 || marker.kind !== 'read-later-workbench-batch-e42' || marker.root !== value || marker.profileCopied !== false || marker.credentialsCopied !== false || marker.oldProcessingPaused !== true) throw Error('批量运行准备标记无效');
  if (marker.databaseSchema === 9) throw Error('该资料根仍是 E4.2 schema 9，应用不会就地迁移；请运行 npm run batch:prepare 重新准备一份 schema 10 副本');
  if (marker.databaseSchema !== 10) throw Error('批量运行准备标记无效');
  // Older marker sourceUserDataDir is historical metadata only. Never stat or open it.
  const sources = validateBatchRuntimeSources(marker.runtimeSources, project, ordinary.userDataDir);
  return { ...ordinary, ...sources };
}
export function createBatchPaths(value: string | undefined, options: { projectRoot?: string } = {}): BatchPaths {
  const paths = resolveBatchPaths(value, options);
  if (entry(paths.root)) throw Error('批量准备须使用全新目录，已有结果保留');
  for (const directory of [paths.root,paths.dataDir,paths.userDataDir,paths.assetsDir,paths.exportsDir,paths.evidenceDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return paths;
}
/** Inspect only this run's session root, including default-session files and all five partitions. */
export function batchSourceHolders(partitions: BatchPaths['sourcePartitions']): number[] {
  if (process.platform === 'win32') throw Error('平台会话独占检查依赖 lsof，仅支持 macOS/Linux 批量开发');
  const pids = new Set<number>();
  const roots = new Set(Object.values(partitions).map(directory => path.dirname(path.dirname(directory))));
  if (roots.size !== 1) throw Error('平台会话必须共享本轮独立存储根');
  for (const directory of roots) {
    assertBatchOrdinaryPath(directory);
    if (!/[\\/]\.acceptance-data[\\/]batch-sync[\\/]e42-[-a-zA-Z0-9_]+[\\/]userData$/.test(directory)) throw Error('平台会话独占检查拒绝旧或正式目录');
    let output = '';
    try { output = execFileSync('/usr/sbin/lsof', ['-nP','-t','+D',directory], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 30_000 }); }
    catch (error) { const result = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }; if (result.status !== 1 || String(result.stderr ?? '').trim()) throw Error('无法确认本轮平台会话的独占状态，未打开会话'); output = String(result.stdout ?? ''); }
    for (const line of output.split(/\s+/)) if (/^[0-9]+$/.test(line) && Number(line) !== process.pid) pids.add(Number(line));
  }
  return [...pids].sort((a,b) => a-b);
}
/** The lease closes races between batch runtimes; lsof also rejects older non-lease consumers. */
export function acquireBatchSourceLease(paths: BatchPaths, options: { holders?: () => number[] } = {}): () => void {
  const holderList = options.holders ?? (() => batchSourceHolders(paths.sourcePartitions));
  const key = createHash('sha256').update(JSON.stringify(paths.sourcePartitions)).digest('hex').slice(0,24);
  const file = path.join(path.dirname(paths.root), `.source-lease-${key}.json`), token = randomUUID();
  assertBatchOrdinaryPath(file);
  const active = holderList(); if (active.length) throw Error(`平台会话正在由进程 ${active.join(',')} 使用，请完成安全交接`);
  if (entry(file)) {
    const lease = JSON.parse(readFileSync(file,'utf8'));
    if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw Error('平台会话锁记录无效，拒绝自动移除');
    let alive = true; try { process.kill(lease.pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw Error('平台会话已有批量运行持有，拒绝重复打开');
    // A dead PID alone is not sufficient: previous helper processes must also be gone.
    if (holderList().length) throw Error('平台会话仍有后台进程持有，拒绝恢复陈旧锁');
    rmSync(file);
  }
  const fd = openSync(file,'wx',0o600);
  try { writeFileSync(fd, JSON.stringify({schema:1,pid:process.pid,token,root:paths.root,startedAt:new Date().toISOString()})+'\n'); } finally { closeSync(fd); }
  const release = () => { try { if (JSON.parse(readFileSync(file,'utf8')).token === token) rmSync(file); } catch { /* Never delete a different owner's lease. */ } };
  try { if (holderList().length) throw Error('平台会话在交接时已被占用，拒绝打开'); } catch (error) { release(); throw error; }
  return release;
}
