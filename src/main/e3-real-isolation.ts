import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isCanonicalPath } from './fs-paths.js';
import type { E1Paths } from './e1-isolation.js';

export function isE3RealBuildName(name: string): boolean {
  return /^editor-e3-real(?:-[A-Za-z0-9_][A-Za-z0-9_-]*)?$/.test(name);
}

/** A mode selects one reviewed local harness, never an arbitrary import path. */
export function e3RealQaScript(mode: string): string {
  if (/^usability-generate-(image|video)(-retry)?$/.test(mode)) return 'scripts/editor-e3-usability-generate.cjs';
  if (/^quality-generate-(image|video)(-retry)?$/.test(mode)) return 'scripts/editor-e3-quality-fix-generate.cjs';
  if (/^(generate|reopen)-[a-z0-9-]+$/.test(mode)) return 'scripts/editor-e3-real-generate.cjs';
  if (/^editor-(first|reopen)$/.test(mode)) return 'scripts/editor-e3-real-editor.cjs';
  throw new Error('未知E3真实验收模式');
}

/** A real-acceptance build has no fallback to formal or older acceptance data. */
export function e3RealBuildMode(buildRoot: string, environment: Record<string, string | undefined>): boolean {
  if (isE3RealBuildName(path.basename(buildRoot))) {
    const incompatible = ['RLW_E3_FIX_DIR', 'RLW_E3_DIR', 'RLW_E2_DIR', 'RLW_E112_DIR', 'RLW_E111_DIR', 'RLW_E11_DIR', 'RLW_E1_DIR', 'RLW_E1_ISOLATED', 'RLW_DATA_DIR', 'RLW_USER_DATA_DIR', 'RLW_SOURCE_MODE', 'RLW_BRIDGE_PROFILE', 'RLW_LOGIN', 'RLW_RETRY_CONTENT', 'RLW_ENABLE_EDITOR'];
    if (!environment.RLW_E3_REAL_DIR || incompatible.some(key => environment[key] !== undefined)) {
      throw new Error('E3真实验收构建仅允许明确的新隔离根，不可回退正式或旧版本目录');
    }
    return true;
  }
  if (environment.RLW_E3_REAL_DIR !== undefined) throw new Error('E3真实验收运行根只能由独立E3真实验收构建打开');
  return false;
}

const entry = (file: string) => {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
};
function canonical(file: string): void {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (entry(current)?.isSymbolicLink()) throw new Error('E3真实验收拒绝符号链接');
  }
  if (entry(file) && !isCanonicalPath(file)) throw new Error('E3真实验收拒绝路径别名');
}

/** Only an explicit direct child of the new namespace can contain a writable copy. */
export function resolveE3RealPaths(value: string | undefined, options: { mustExist?: boolean; projectRoot?: string } = {}): E1Paths {
  const allowed = path.resolve(options.projectRoot ?? process.cwd(), '.acceptance-data/editor-e3-real');
  if (!value || !path.isAbsolute(value) || path.normalize(value) !== value || value.endsWith(path.sep) || path.dirname(value) !== allowed || !/^[-a-zA-Z0-9_]+$/.test(path.basename(value))) {
    throw new Error('E3真实验收需要明确的新RLW_E3_REAL_DIR隔离根');
  }
  const paths = { root: value, dataDir: path.join(value, 'data'), userDataDir: path.join(value, 'userData'), assetsDir: path.join(value, 'editor-assets'), exportsDir: path.join(value, 'exports'), evidenceDir: path.join(value, 'evidence') };
  for (const file of [...Object.values(paths), path.join(value, 'e3-real-isolated.json'), path.join(paths.dataDir, 'workbench.sqlite'), path.join(paths.dataDir, 'media'), path.join(paths.dataDir, 'digest-inputs'), path.join(paths.dataDir, 'ocr-results'), path.join(paths.dataDir, 'asr-results'), path.join(paths.dataDir, 'asr-prepared'), path.join(paths.dataDir, 'asr-inputs'), path.join(paths.dataDir, 'generation-results'), path.join(paths.dataDir, 'generation-responses'), path.join(paths.userDataDir, 'profile')]) canonical(file);
  if (options.mustExist) {
    for (const file of Object.values(paths)) if (!entry(file)?.isDirectory()) throw new Error('E3真实验收隔离目录尚未准备');
    if (!entry(path.join(paths.dataDir, 'workbench.sqlite'))?.isFile()) throw new Error('E3真实验收数据库尚未准备');
    const marker = JSON.parse(readFileSync(path.join(value, 'e3-real-isolated.json'), 'utf8'));
    if (marker.schema !== 1 || (marker.databaseSchema!==9&&marker.databaseSchema!==10) || marker.root !== value || marker.kind !== 'read-later-workbench-editor-e3-real' || marker.networkBlockedRequired !== true || marker.profileCopied !== false || marker.credentialsCopied !== false) throw new Error('E3真实验收准备标记无效');
  }
  return paths;
}

export function createE3RealPaths(value: string | undefined, options: { projectRoot?: string } = {}): E1Paths {
  const paths = resolveE3RealPaths(value, options);
  if (entry(paths.root)) throw new Error('E3真实验收须使用全新运行根；已有结果保持');
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return paths;
}
