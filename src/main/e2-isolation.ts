import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isCanonicalPath } from './fs-paths.js';
import type { E1Paths } from './e1-isolation.js';
/** A compiled E2 entry must fail closed even when launched without its shell wrapper. */
export function e2BuildMode(buildRoot:string,environment:Record<string,string|undefined>):boolean {
  const isolatedBuild=['editor-e2','editor-e2-fix'].includes(path.basename(buildRoot));
  if(isolatedBuild){
    if(!environment.RLW_E2_DIR||['RLW_E112_DIR','RLW_E111_DIR','RLW_E11_DIR','RLW_E1_DIR','RLW_E1_ISOLATED','RLW_DATA_DIR','RLW_USER_DATA_DIR','RLW_SOURCE_MODE','RLW_BRIDGE_PROFILE','RLW_LOGIN','RLW_RETRY_CONTENT','RLW_ENABLE_EDITOR'].some(key=>environment[key]!==undefined))throw new Error('E2构建仅允许明确的新隔离根，不可回退正式或旧版本目录');
    return true;
  }
  if(environment.RLW_E2_DIR!==undefined)throw new Error('E2运行根只能由独立E2构建打开');
  return false;
}
const entry = (file:string) => { try { return lstatSync(file); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error; } };
function canonical(file:string):void { let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep)){current=path.join(current,part);if(entry(current)?.isSymbolicLink())throw new Error('E2拒绝符号链接');}if(entry(file)&&!isCanonicalPath(file))throw new Error('E2拒绝路径别名'); }
/** E2 never aliases a formal, E1, or sealed E11 profile. */
export function resolveE2Paths(value:string|undefined,options:{mustExist?:boolean;projectRoot?:string}={}):E1Paths {
  const allowed=path.resolve(options.projectRoot??process.cwd(),'.acceptance-data/editor-e2');
  if(!value||!path.isAbsolute(value)||path.normalize(value)!==value||value.endsWith(path.sep)||path.dirname(value)!==allowed||!/^[-a-zA-Z0-9_]+$/.test(path.basename(value)))throw new Error('E2需要明确的新RLW_E2_DIR隔离根');
  const paths={root:value,dataDir:path.join(value,'data'),userDataDir:path.join(value,'userData'),assetsDir:path.join(value,'editor-assets'),exportsDir:path.join(value,'exports'),evidenceDir:path.join(value,'evidence')};
  for(const file of [...Object.values(paths),path.join(value,'e2-isolated.json'),path.join(paths.dataDir,'workbench.sqlite'),path.join(paths.dataDir,'media'),path.join(paths.dataDir,'digest-inputs'),path.join(paths.dataDir,'ocr-results'),path.join(paths.dataDir,'asr-results'),path.join(paths.dataDir,'asr-prepared'),path.join(paths.dataDir,'asr-inputs'),path.join(paths.userDataDir,'profile')])canonical(file);
  if(options.mustExist){for(const file of Object.values(paths))if(!entry(file)?.isDirectory())throw new Error('E2隔离目录尚未准备');const marker=JSON.parse(readFileSync(path.join(value,'e2-isolated.json'),'utf8'));if(marker.schema!==1||marker.root!==value||marker.kind!=='read-later-workbench-editor-e2'||marker.networkBlockedRequired!==true)throw new Error('E2准备标记无效');}
  return paths;
}
export function createE2Paths(value:string|undefined,options:{projectRoot?:string}={}):E1Paths {const paths=resolveE2Paths(value,options);if(entry(paths.root))throw new Error('E2须使用全新运行根；已有结果保持');for(const directory of Object.values(paths))mkdirSync(directory,{recursive:true,mode:0o700});return paths;}
