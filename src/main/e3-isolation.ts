import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { E1Paths } from './e1-isolation.js';
/** A compiled E3 entry must fail closed even when launched without its shell wrapper. */
export function e3BuildMode(buildRoot:string,environment:Record<string,string|undefined>):boolean {
  const isolatedBuild=path.basename(buildRoot)==='editor-e3';
  if(isolatedBuild){
    if(!environment.RLW_E3_DIR||['RLW_E2_DIR','RLW_E112_DIR','RLW_E111_DIR','RLW_E11_DIR','RLW_E1_DIR','RLW_E1_ISOLATED','RLW_DATA_DIR','RLW_USER_DATA_DIR','RLW_SOURCE_MODE','RLW_BRIDGE_PROFILE','RLW_LOGIN','RLW_RETRY_CONTENT','RLW_ENABLE_EDITOR'].some(key=>environment[key]!==undefined))throw new Error('E3构建仅允许明确的新隔离根，不可回退正式或旧版本目录');
    return true;
  }
  if(environment.RLW_E3_DIR!==undefined)throw new Error('E3运行根只能由独立E3构建打开');
  return false;
}
const entry = (file:string) => { try { return lstatSync(file); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error; } };
function canonical(file:string):void { let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep)){current=path.join(current,part);if(entry(current)?.isSymbolicLink())throw new Error('E3拒绝符号链接');}if(entry(file)&&realpathSync(file)!==file)throw new Error('E3拒绝路径别名'); }
/** E3 never aliases a formal, E1, or sealed E11 profile. */
export function resolveE3Paths(value:string|undefined,options:{mustExist?:boolean;projectRoot?:string}={}):E1Paths {
  const allowed=path.resolve(options.projectRoot??process.cwd(),'.acceptance-data/editor-e3');
  if(!value||!path.isAbsolute(value)||path.normalize(value)!==value||value.endsWith(path.sep)||path.dirname(value)!==allowed||!/^[-a-zA-Z0-9_]+$/.test(path.basename(value)))throw new Error('E3需要明确的新RLW_E3_DIR隔离根');
  const paths={root:value,dataDir:path.join(value,'data'),userDataDir:path.join(value,'userData'),assetsDir:path.join(value,'editor-assets'),exportsDir:path.join(value,'exports'),evidenceDir:path.join(value,'evidence')};
  for(const file of [...Object.values(paths),path.join(value,'e3-isolated.json'),path.join(paths.dataDir,'workbench.sqlite'),path.join(paths.dataDir,'media'),path.join(paths.dataDir,'digest-inputs'),path.join(paths.dataDir,'ocr-results'),path.join(paths.dataDir,'asr-results'),path.join(paths.dataDir,'asr-prepared'),path.join(paths.dataDir,'asr-inputs'),path.join(paths.dataDir,'generation-results'),path.join(paths.dataDir,'generation-responses'),path.join(paths.userDataDir,'profile')])canonical(file);
  if(options.mustExist){for(const file of Object.values(paths))if(!entry(file)?.isDirectory())throw new Error('E3隔离目录尚未准备');if(!entry(path.join(paths.dataDir,'workbench.sqlite'))?.isFile())throw new Error('E3数据库尚未准备');const marker=JSON.parse(readFileSync(path.join(value,'e3-isolated.json'),'utf8'));if(marker.schema!==1||marker.databaseSchema!==9||marker.root!==value||marker.kind!=='read-later-workbench-editor-e3'||marker.networkBlockedRequired!==true)throw new Error('E3准备标记无效');}
  return paths;
}
export function createE3Paths(value:string|undefined,options:{projectRoot?:string}={}):E1Paths {const paths=resolveE3Paths(value,options);if(entry(paths.root))throw new Error('E3须使用全新运行根；已有结果保持');for(const directory of Object.values(paths))mkdirSync(directory,{recursive:true,mode:0o700});return paths;}
