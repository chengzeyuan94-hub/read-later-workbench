import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
const entry=file=>{try{return lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}};
/** Never follow a linked output directory or existing output file into a sealed build. */
export function assertOrdinaryOutput(root){
  let current=path.parse(root).root;
  for(const part of root.slice(current.length).split(path.sep)){current=path.join(current,part);if(entry(current)?.isSymbolicLink())throw new Error('E2构建拒绝符号链接输出');}
  const visit=file=>{const stat=entry(file);if(!stat)return;if(stat.isSymbolicLink())throw new Error('E2构建拒绝输出树中的符号链接');if(stat.isDirectory())for(const name of readdirSync(file))visit(path.join(file,name));};
  visit(root);
}
