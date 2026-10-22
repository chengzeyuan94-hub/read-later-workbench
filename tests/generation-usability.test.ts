import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFrozenSourceImages, normalizeGenerationUsabilitySources, verifyGenerationUsabilitySourceAudit } from '../src/main/generation-usability.js';
import { normalizeGenerationQuality, validateGenerationQuality } from '../src/main/generation-quality.js';
import { freezeGenerationPlan, generationSha256, resolveGenerationCitation, validateGeneratedMap, validateOrganizedDocument } from '../src/main/generation-validation.js';
import { referenceDescription } from '../src/editor-core/model.js';
import type { GenerationArtifact, GenerationFrozenInput, OrganizedDocument } from '../src/shared/generation-contracts.js';
const source=(text='有三种模式。四个人参与。如果满足条件，可以按第二张截图操作。',extra=false):GenerationFrozenInput=>({sourceRevisionId:'v1',title:'功能 v2.0',units:[{id:'u',kind:'capturedSource',text,reference:{kind:'capturedSource',sourceId:'s',sourceRevisionId:'v1',blockId:'b'},versionIdentity:'s/v1/b',coverage:'complete',warnings:[]},...(extra?[{id:'ui',kind:'capturedSource' as const,text:'收起',reference:{kind:'capturedSource' as const,sourceId:'s',sourceRevisionId:'v1',blockId:'ui'},versionIdentity:'s/v1/ui',coverage:'complete' as const,warnings:[]}]:[])]});
const document=(input:GenerationFrozenInput,text=input.units[0].text,citations:any[]=[{unitId:'u'}]):unknown=>({schemaVersion:1,sourceRevisionId:input.sourceRevisionId,title:'功能 v2.0',lead:'',leadCitations:[],blocks:[{id:'b',type:'paragraph',role:'fact',text,citations}],coverage:[{unitId:'u',start:0,end:3700,disposition:'included'}]});

test('new product policy does not reject equivalent numerals, source labels, version headings or normal conditional phrasing by token shape',()=>{
 const input=source(undefined,true),raw=document(input,'有3种模式，4人参与。若满足条件，可依第二张截图操作。'),before=JSON.stringify(raw);
 const normalized=normalizeGenerationUsabilitySources(input,'organize',raw);validateOrganizedDocument(normalized.value,input,{usabilityPolicy:true});
 assert.equal((normalized.value as OrganizedDocument).blocks[0].text,'有3种模式，4人参与。若满足条件，可依第二张截图操作。');assert.equal(JSON.stringify(raw),before);
 assert.deepEqual((normalized.value as OrganizedDocument).coverage,[{unitId:'u',start:0,end:Array.from(input.units[0].text).length,disposition:'included'}]);
 assert.equal((normalized.value as OrganizedDocument).blocks[0].citations[0].granularity,'source-unit');
 assert.throws(()=>validateGenerationQuality('organize',normalized.value,input),'v2 still retains its frozen old guards');
 assert.match(referenceDescription(resolveGenerationCitation(input,(normalized.value as OrganizedDocument).blocks[0].citations[0])),/粗粒度，非逐字对应/);
});

test('coordinates are rebuilt within the exact frozen unit; no clamping, fake quote, cross-unit or video-time guesses',()=>{
 const input=source('🙂开头，原文。结尾。'),raw=document(input,'AI 整理稿',[{unitId:'u',start:999,end:3700,excerpt:'原文。'}]);
 const exact=normalizeGenerationUsabilitySources(input,'organize',raw),citation=(exact.value as OrganizedDocument).blocks[0].citations[0];
 assert.deepEqual(citation,{unitId:'u',start:4,end:7,excerpt:'原文。'});verifyGenerationUsabilitySourceAudit(input,'organize',exact.value,raw,exact.audit);
 const coarseRaw=document(input,'AI 整理稿',[{unitId:'u',start:-2,end:999,excerpt:'合理改写不能作为逐字原话'}]),coarse=normalizeGenerationUsabilitySources(input,'organize',coarseRaw);
 assert.deepEqual((coarse.value as OrganizedDocument).blocks[0].citations[0],{unitId:'u',start:0,end:10,excerpt:input.units[0].text,granularity:'source-unit'});
 assert.equal(Object.hasOwn(resolveGenerationCitation(input,(coarse.value as OrganizedDocument).blocks[0].citations[0]),'startMs'),false);
 assert.throws(()=>normalizeGenerationUsabilitySources(input,'organize',document(input,'正文',[{unitId:'someone-else'}])),(e:any)=>e.code==='unknown-source-unit');
 const altered=structuredClone(coarse.value) as OrganizedDocument;altered.blocks[0].text='被篡改';assert.throws(()=>verifyGenerationUsabilitySourceAudit(input,'organize',altered,coarseRaw,coarse.audit),(e:any)=>e.code==='proof-derivation');
});

test('repeated excerpts degrade explicitly; frozen chunks cannot borrow another chunk or guess among disjoint slices',()=>{
 const input=source('重复。中间。重复。'),normalized=normalizeGenerationUsabilitySources(input,'organize',document(input,'正文',[{unitId:'u',start:100,end:200,excerpt:'重复。'}]));
 assert.equal((normalized.value as OrganizedDocument).blocks[0].citations[0].granularity,'source-unit');
 const long=source('第一段原文已冻结，不能越过此授权边界。第二段原文是另一个冻结部分。'),chunk=freezeGenerationPlan(long,{maxChunkCodePoints:20}).chunks[0],result=normalizeGenerationUsabilitySources(long,'organize',document(long,'正文',[{unitId:'u',excerpt:'第二段原文'}]),chunk);
 const c=(result.value as OrganizedDocument).blocks[0].citations[0];assert.equal(c.granularity,'frozen-slice');assert.equal(c.start,chunk.slices[0].start);assert.equal(c.end,chunk.slices[0].end);validateOrganizedDocument(result.value,long,{chunk,usabilityPolicy:true});
});

test('source associations no longer pretend every unit/character was retained; invalid ownership, empty manuscript and malformed trees still reject',()=>{
 const input=source('甲，乙。',true),normalized=normalizeGenerationUsabilitySources(input,'organize',document(input,'甲。乙。',[{unitId:'u',start:0,end:1,excerpt:'甲'},{unitId:'u',start:2,end:3,excerpt:'乙'}]));
 validateOrganizedDocument(normalized.value,input,{usabilityPolicy:true});assert.equal((normalized.value as OrganizedDocument).coverage.length,2,'punctuation gaps remain visible associations, not fake full coverage');
 const empty=normalizeGenerationUsabilitySources(input,'organize',{...document(input) as any,blocks:[]});assert.throws(()=>validateOrganizedDocument(empty.value,input,{usabilityPolicy:true}),(e:any)=>e.code==='empty-manuscript');
 const organized=normalized.value as OrganizedDocument,wire={schemaVersion:2,sourceRevisionId:input.sourceRevisionId,organizedSha256:generationSha256(organized),root:{kind:'group',topic:'v2.0 的3种模式',children:[{kind:'claim',title:'主要观点',explanation:'若符合条件，可以使用。',citations:[{unitId:'u'}],children:[]}]}};
 const typed=normalizeGenerationQuality('map',input,wire,organized),mapped=normalizeGenerationUsabilitySources(input,'map',typed.value);validateGeneratedMap(mapped.value,input,organized,{usabilityPolicy:true});
 const bad=structuredClone(mapped.value) as any;bad.nodes[1].parentId='missing';assert.throws(()=>validateGeneratedMap(bad,input,organized,{usabilityPolicy:true}),(e:any)=>e.code==='invalid-map-tree');
 const wrongVersion={...organized,sourceRevisionId:'foreign'};assert.throws(()=>validateOrganizedDocument(wrongVersion,input,{usabilityPolicy:true}),(e:any)=>e.code==='source-version');
});


test('frozen original images become durable draft blocks once, preserving prose, map, input and exact source identity',()=>{
 const input=source(),a={assetId:'image-a',version:'sha-a'},b={assetId:'image-b',version:'sha-b'};input.units[0].assetRefs=[a,b,a];
 const artifact={sourceSha256:generationSha256(input),organizedSha256:'saved-organized-sha',draft:{schemaVersion:1,documentId:'d',workspaceId:'w',revision:1,blocks:[{id:'p',type:'paragraph',runs:[{text:'完整AI整理正文'}]},{id:'already-a',type:'image',runs:[],assetRefs:[a]}]},map:{unchanged:true},blockSourceRefs:{},draftSha256:'before'} as unknown as GenerationArtifact;
 const inputBefore=JSON.stringify(input),mapBefore=JSON.stringify(artifact.map);appendFrozenSourceImages(artifact,input);
 assert.deepEqual(artifact.draft.blocks.filter(b=>b.type==='image').map(b=>b.assetRefs![0]),[a,b]);assert.equal(artifact.draft.blocks[0].runs[0].text,'完整AI整理正文');assert.equal(artifact.organizedSha256,'saved-organized-sha');assert.equal(artifact.draftSha256,generationSha256(artifact.draft));assert.equal(JSON.stringify(artifact.map),mapBefore);assert.equal(JSON.stringify(input),inputBefore);
 const after=JSON.stringify(artifact);appendFrozenSourceImages(artifact,input);assert.equal(JSON.stringify(artifact),after,'idempotent with images already present');assert.equal(Object.keys(artifact.blockSourceRefs).length,1);
 const foreign={...input,sourceRevisionId:'other'};assert.throws(()=>appendFrozenSourceImages(artifact,foreign),(e:any)=>e.code==='source-version');
});

test('coarse citation expansion is bounded before constructing an oversized canonical artifact',()=>{
 const input=source('正文'.repeat(100000)),raw=document(input,'AI整理稿',Array.from({length:10},()=>({unitId:'u'})));
 assert.throws(()=>normalizeGenerationUsabilitySources(input,'organize',raw),(e:any)=>e.code==='reference-expansion-limit');
});
