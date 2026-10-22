import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function resolveBatchBuild(value){
  if(!value||!path.isAbsolute(value)||value!==path.normalize(value)||path.dirname(value)!==path.resolve('dist')||!/^batch-e42-[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(path.basename(value)))throw Error('需要 dist 下明确的新 batch-e42-* 构建');
  let current=value;while(current!==path.dirname(current)){if(existsSync(current)&&(lstatSync(current).isSymbolicLink()||realpathSync(current)!==current))throw Error('批量构建拒绝链接或路径别名');current=path.dirname(current);}return value;
}
export function checkBatchBuild(build,root){
  build=resolveBatchBuild(build);const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex'),manifest=JSON.parse(readFileSync(path.join(build,'build-inputs.json'),'utf8'));
  if(manifest.sessionMode!=='isolated-five-platforms')throw Error('此构建使用旧登录会话模式，请构建新的五平台独立登录版本');
  if(manifest.kind!=='read-later-workbench-batch-build'||manifest.schema!==1||manifest.root!==root||hash(path.join(root,'batch-isolated.json'))!==manifest.rootMarkerSha256)throw Error('批量构建与固定资料根不匹配');
  // Verify frozen output bytes, not the mutable current checkout. Later fixes do not break old launchers.
  for(const [relative,sha]of Object.entries(manifest.outputs)){
    if(path.isAbsolute(relative)||relative.split(path.sep).includes('..'))throw Error('构建清单路径无效');
    const file=path.join(build,relative);if(lstatSync(file).isSymbolicLink()||realpathSync(file)!==file||hash(file)!==sha)throw Error('批量构建文件已改变');
  }
  const app=path.join(build,'ReadLaterE42.app'),plist=path.join(app,'Contents/Info.plist');
  for(const relative of ['','Contents','Contents/MacOS','Contents/MacOS/Electron','Contents/Info.plist'])if(lstatSync(path.join(app,relative)).isSymbolicLink())throw Error('批量应用入口拒绝链接');
  if(manifest.app.bundleId!=='local.readlater.workbench.e42'||hash(path.join(app,'Contents/MacOS/Electron'))!==manifest.app.executableSha256||hash(plist)!==manifest.app.plistSha256)throw Error('批量应用身份或签名不匹配');
  if(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',plist],{encoding:'utf8'}).trim()!==manifest.app.bundleId)throw Error('批量应用身份不匹配');
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});return {build,root,app};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){checkBatchBuild(process.env.RLW_BATCH_BUILD,process.env.RLW_BATCH_DIR);console.log('批量构建固定资料根与输出校验通过');}
