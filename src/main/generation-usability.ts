import { clone, getDraftAssetRefs, validateDraft } from '../editor-core/model.js';
import type { GenerationArtifact, GenerationChunk, GenerationCoordinateAudit, GenerationFrozenInput, GenerationStage } from '../shared/generation-contracts.js';
import { generationSha256, GenerationValidationError, validateGenerationChunk, validateGenerationInput } from './generation-validation.js';

export const GENERATION_USABILITY_PROMPT_VERSION = 'read-create-usability-v3' as const;
export const GENERATION_USABILITY_SOURCE_POLICY = 'source-association-usability-v1' as const;
function fail(code:string,path:string):never{throw new GenerationValidationError(code,path);}
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** No text is rewritten here. The original response is kept by the repository.
 * A model location is either verified, derived by exact unique excerpt in the
 * same frozen source, or replaced by an explicitly coarse authorized unit/slice.
 * Coverage becomes a local association index, never a semantic retention claim.
 */
export function normalizeGenerationUsabilitySources(input:GenerationFrozenInput,stage:GenerationStage,original:unknown,chunk?:GenerationChunk):{value:unknown;audit:GenerationCoordinateAudit}{
 validateGenerationInput(input);if(chunk)validateGenerationChunk(input,chunk);
 if(Buffer.byteLength(JSON.stringify(original)??'')>8*1024**2)fail('response-limit','/');
 const value=structuredClone(original),associations:NonNullable<GenerationCoordinateAudit['associations']>=[];
 if(!record(value))fail('object-required','/');
 const slices=chunk?.slices??input.units.map(unit=>({unitId:unit.id,start:0,end:Array.from(unit.text).length}));
 let count=0,searchPoints=0,expandedBytes=0;
 const array=(value:unknown,path:string):any[]=>{if(!Array.isArray(value)||value.length>8000)fail('citation-array',path);return value;};
 function citation(item:unknown,path:string):void{
  if(++count>20000)fail('reference-limit',path);
  if(!record(item)||typeof item.unitId!=='string')fail('unknown-source-unit',path);
  const unit=input.units.find(unit=>unit.id===item.unitId),allowed=slices.filter(slice=>slice.unitId===item.unitId);
  if(!unit||!allowed.length)fail('unknown-source-unit',path);
  // Unknown protocol fields still fail. Untrusted positions are never clamped.
  if(Object.keys(item).some(key=>!['unitId','start','end','excerpt','granularity'].includes(key)))fail('unknown-citation-field',path);
  const points=Array.from(unit.text),excerpt=typeof item.excerpt==='string'?item.excerpt:'',length=Array.from(excerpt).length;
  let start:number|undefined,end:number|undefined,reason='';
  if(excerpt&&Number.isSafeInteger(item.start)&&Number.isSafeInteger(item.end)&&item.end>item.start&&allowed.some(slice=>item.start>=slice.start&&item.end<=slice.end)&&points.slice(item.start,item.end).join('')===excerpt){start=item.start;end=item.end;reason='verified-exact-excerpt';}
  else if(excerpt){
   const matches=new Map<string,{start:number;end:number}>();
   for(const slice of allowed){searchPoints+=slice.end-slice.start+length;if(searchPoints>16000000)fail('search-limit',path);const text=points.slice(slice.start,slice.end).join('');let offset=0;while(offset<=text.length){const at=text.indexOf(excerpt,offset);if(at<0)break;const foundStart=slice.start+Array.from(text.slice(0,at)).length,foundEnd=foundStart+length;if(points.slice(foundStart,foundEnd).join('')===excerpt)matches.set(`${foundStart}:${foundEnd}`,{start:foundStart,end:foundEnd});offset=at+1;if(matches.size>1)break;}if(matches.size>1)break;}
   if(matches.size===1){({start,end}=matches.values().next().value!);reason='unique-exact-excerpt';}
  }
  delete item.granularity;
  if(start===undefined||end===undefined){
   // A known unit is a reliable coarse locator. Multiple disjoint authorized
   // slices do not identify which piece was intended, so do not guess among them.
   if(allowed.length!==1)fail('ambiguous-source-slice',path);
   start=allowed[0].start;end=allowed[0].end;
   item.granularity=start===0&&end===points.length?'source-unit':'frozen-slice';reason='coarse-known-source';
  }
  const actualExcerpt=points.slice(start,end).join('');expandedBytes+=Buffer.byteLength(JSON.stringify(actualExcerpt));if(expandedBytes>4*1024**2)fail('reference-expansion-limit',path);
  item.start=start;item.end=end;item.excerpt=actualExcerpt;
  associations.push({path,unitId:unit.id,granularity:item.granularity??'excerpt',reason});
 }
 const citations=(items:unknown,path:string)=>array(items,path).forEach((item,index)=>citation(item,`${path}/${index}`));
 if(stage==='organize'){
  if(value.leadCitations===undefined)value.leadCitations=[];
  citations(value.leadCitations,'/leadCitations');
  for(const [index,block]of array(value.blocks,'/blocks').entries()){if(!record(block))fail('block-kind',`/blocks/${index}`);citations(block.citations,`/blocks/${index}/citations`);}
  const ranges=new Map<string,{start:number;end:number}[]>();
  for(const block of value.blocks)for(const c of block.citations){const entries=ranges.get(c.unitId)??[];entries.push({start:c.start,end:c.end});ranges.set(c.unitId,entries);}
  value.coverage=[];
  for(const unit of input.units){const sorted=(ranges.get(unit.id)??[]).sort((a,b)=>a.start-b.start||a.end-b.end),merged:{start:number;end:number}[]=[];for(const item of sorted){const last=merged.at(-1);if(last&&item.start<=last.end)last.end=Math.max(last.end,item.end);else merged.push({...item});}for(const range of merged)value.coverage.push({unitId:unit.id,...range,disposition:'included'});}
 }else if(stage==='map'){
  for(const [index,node]of array(value.nodes,'/nodes').entries()){if(!record(node))fail('map-kind',`/nodes/${index}`);citations(node.citations,`/nodes/${index}/citations`);}
 }else fail('stage','/');
 if(Buffer.byteLength(JSON.stringify(value))>8*1024**2)fail('response-limit','/');
 return{value,audit:{policyVersion:GENERATION_USABILITY_SOURCE_POLICY,sourceSha256:generationSha256(input),originalValueSha256:generationSha256(original),canonicalValueSha256:generationSha256(value),repairs:[],associations}};
}
export function verifyGenerationUsabilitySourceAudit(input:GenerationFrozenInput,stage:GenerationStage,value:unknown,original:unknown,audit:GenerationCoordinateAudit,chunk?:GenerationChunk):void{
 if(audit.policyVersion!==GENERATION_USABILITY_SOURCE_POLICY)fail('proof-policy','/');
 const expected=normalizeGenerationUsabilitySources(input,stage,original,chunk);
 if(generationSha256(expected.audit)!==generationSha256(audit)||generationSha256(expected.value)!==generationSha256(value))fail('proof-derivation','/');
}

/** Original images remain part of the current editable draft and therefore its
 * future exports, even after a human revision no longer inherits generated prose refs. */
export function appendFrozenSourceImages(artifact:GenerationArtifact,input:GenerationFrozenInput):void{
 if(artifact.sourceSha256!==generationSha256(input))fail('source-version','/');
 const present=new Set(getDraftAssetRefs(artifact.draft.blocks).map(asset=>`${asset.assetId}@${asset.version}`));let heading=false;
 for(const unit of input.units)for(const asset of unit.assetRefs??[]){const key=`${asset.assetId}@${asset.version}`;if(present.has(key))continue;present.add(key);
  if(!heading){artifact.draft.blocks.push({id:`source-images-${generationSha256(input).slice(0,24)}`,type:'heading',level:2,runs:[{text:'来源原图'}]});heading=true;}
  const id=`source-image-${generationSha256(key).slice(0,24)}`;artifact.draft.blocks.push({id,type:'image',runs:[],assetRefs:[clone(asset)]});artifact.blockSourceRefs[id]=[clone(unit.reference)];
 }
 validateDraft(artifact.draft);artifact.draftSha256=generationSha256(artifact.draft);
}
