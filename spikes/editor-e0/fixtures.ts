import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { type WorkspaceBundle, type MindMapNode, type TranscriptSegment, validateBundle, pointLength } from './model.js';

export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
/** Self-authored 320×180 PNG, generated solely from geometric pixels. */
export function syntheticPng(): Buffer {
  const crc32=(bytes:Uint8Array)=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const name=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([len,name,data,crc]);};
  const width=320,height=180,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const raw=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++){for(let x=0;x<width;x++){const p=y*(width*3+1)+1+x*3;const orange=(x>35&&x<150&&y>35&&y<145);const white=x>180&&x<285&&y>55&&y<125;raw[p]=orange?245:white?250:28;raw[p+1]=orange?125:white?247:47;raw[p+2]=orange?45:white?236:65;}}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
/** An explicitly synthetic text-only provider response; no inferred sentence times. */
export function createTextOnlySliceFixture(which:'a'|'b'='a'):TranscriptSegment[] {
  const prefix=`e0-${which}`,first='第一段纯文本，没有逐句时间。\n',second='第二段纯文本，也没有逐句时间。',rawText=first+second;
  const common={workspaceId:`${prefix}-workspace`,transcriptId:`${prefix}-transcript`,revision:1,mediaId:'synthetic-media',partId:'p2',timeContractVersion:2 as const,inputSource:{kind:'synthetic' as const,responseFormat:'text-only' as const,sourceId:`${prefix}-text-response`,revision:1,rawText,mediaId:'synthetic-media',partId:'p2'},inputRange:{coordinate:'media-part' as const,mediaId:'synthetic-media',partId:'p2',startMs:60000,endMs:120000},timing:{state:'unknown' as const,reason:'not-provided' as const}};
  return[{...common,segmentId:`${prefix}-segment-unknown`,runs:[{text:first}],sourceTextRange:{start:0,end:pointLength(first),unit:'unicode-code-point'}},{...common,segmentId:`${prefix}-segment-unknown-2`,runs:[{text:second}],sourceTextRange:{start:pointLength(first),end:pointLength(rawText),unit:'unicode-code-point'}}];
}
/** Synthetic timing is explicitly synthetic even when it legitimately starts at zero. */
export function createZeroTimingFixture(which:'a'|'b'='a'):TranscriptSegment {
  const prefix=`e0-${which}`,rawText='合成已知时间段，从 0ms 开始，仅验证结构。',sourceId=`${prefix}-timed-fixture`;
  return{workspaceId:`${prefix}-workspace`,transcriptId:`${prefix}-transcript`,revision:1,segmentId:`${prefix}-segment-timed`,runs:[{text:rawText}],mediaId:'synthetic-media',partId:'p1',timeContractVersion:2,inputSource:{kind:'synthetic',responseFormat:'caption-records',sourceId,revision:1,rawText,mediaId:'synthetic-media',partId:'p1'},inputRange:{coordinate:'media-part',mediaId:'synthetic-media',partId:'p1',startMs:0,endMs:10000},sourceTextRange:{start:0,end:pointLength(rawText),unit:'unicode-code-point'},timing:{state:'known',source:'synthetic',granularity:'sentence',coordinate:'media-part',mediaId:'synthetic-media',partId:'p1',startMs:0,endMs:3500,evidence:{sourceId,revision:1,inputSourceId:sourceId,inputSourceRevision:1}}};
}
export function createFixtureBundle(which: 'a' | 'b' = 'a'): WorkspaceBundle {
  const transcripts=[...createTextOnlySliceFixture(which),createZeroTimingFixture(which)];
  const prefix=`e0-${which}`,wid=`${prefix}-workspace`,draftId=`${prefix}-draft`,mapId=`${prefix}-map`,sourceId=`${prefix}-source`,png=syntheticPng();
  const node=(n:number,parent:number|null,children:number[],title:string):MindMapNode=>({id:`${prefix}-n${n}`,parentId:parent===null?null:`${prefix}-n${parent}`,children:children.map(c=>`${prefix}-n${c}`),title:[{text:title}],notes:'',sourceRefs:[]});
  const nodes:Record<string,MindMapNode>={};
  for(const n of [node(1,null,[2,3,4],'收藏理解实验 🧠'),node(2,1,[5,6],'原始资料'),node(3,1,[7,8],'用户整理稿'),node(4,1,[9,10],'输出与验证'),node(5,2,[11],'重复标题'),node(6,2,[],'中文与 emoji 📚'),node(7,3,[12],'重复标题'),node(8,3,[],'局部粗体测试'),node(9,4,[],'两行标题\n第二行'),node(10,4,[],'本地图片'),node(11,5,[],'三级层级与来源'),node(12,7,[],'转录未知时间')])nodes[n.id]=n;
  nodes[`${prefix}-n8`].title=[{text:'普通文字 '},{text:'局部粗体',bold:true},{text:' 与 emoji 🧩'}];
  nodes[`${prefix}-n11`].notes='普通备注：仅为 E0 自建合成资料。公开示例链接 https://example.com/';
  nodes[`${prefix}-n11`].sourceRefs=[{kind:'capturedSource',sourceId,sourceRevisionId:'source-v1',blockId:`${prefix}-source-p1`,range:{start:0,end:5,unit:'unicode-code-point',excerpt:'中文📚资料'}}];
  nodes[`${prefix}-n7`].sourceRefs=[{kind:'userDraft',documentId:draftId,revision:1,blockId:`${prefix}-draft-p1`,range:{start:0,end:5,unit:'unicode-code-point',excerpt:'用户🧠整理'}}];
  nodes[`${prefix}-n12`].sourceRefs=[{kind:'transcript',transcriptId:`${prefix}-transcript`,revision:1,segmentId:`${prefix}-segment-unknown`,mediaId:'synthetic-media',partId:'p2',timeContractVersion:2}];
  nodes[`${prefix}-n6`].sourceRefs=[{kind:'transcript',transcriptId:`${prefix}-transcript`,revision:1,segmentId:`${prefix}-segment-timed`,mediaId:'synthetic-media',partId:'p1',timeContractVersion:2}];
  nodes[`${prefix}-n9`].sourceRefs=[{kind:'transcript',transcriptId:`${prefix}-transcript`,revision:1,segmentId:`${prefix}-segment-unknown-2`,mediaId:'synthetic-media',partId:'p2',timeContractVersion:2}];
  nodes[`${prefix}-n10`].image={assetId:`${prefix}-image`,version:'1'};
  nodes[`${prefix}-n5`].image={assetId:`${prefix}-image`,version:'1'};
  const sourceBlocks=[{id:`${prefix}-source-h1`,type:'heading' as const,level:1,runs:[{text:'合成原始资料'}]},{id:`${prefix}-source-p1`,type:'paragraph' as const,runs:[{text:'中文📚资料保持不可变，用户整理稿可以独立修改。'}],assetRefs:[{assetId:`${prefix}-image`,version:'1'}]}];
  const bundle:WorkspaceBundle={
    workspace:{id:wid,collectionId:`synthetic:${which}`,userTitle:which==='a'?'合成工作区 A':'合成工作区 B',draftDocumentId:draftId,mindMapDocumentId:mapId,draftRevision:1,mapRevision:1},
    draft:{documentId:draftId,workspaceId:wid,schemaVersion:1,revision:1,blocks:[{id:`${prefix}-draft-h1`,type:'heading',level:1,runs:[{text:which==='a'?'整理稿 A 📝':'整理稿 B 📝'}]},{id:`${prefix}-draft-p1`,type:'paragraph',runs:[{text:'用户🧠整理与原文独立。'},{text:'局部粗体',bold:true},{text:'，保留中文与 emoji 👩🏽‍💻。'}]},{id:`${prefix}-draft-p2`,type:'paragraph',runs:[{text:'第二段可以编辑、前插、拆分；引用继续定位历史块。'}]}]},
    map:{documentId:mapId,workspaceId:wid,schemaVersion:1,revision:1,sheetId:`${prefix}-sheet`,rootId:`${prefix}-n1`,theme:{id:'e0-warm',name:'E0 黑白橙'},nodes},
    sources:[{workspaceId:wid,sourceId,sourceRevisionId:'source-v1',blocks:sourceBlocks,sha256:sha256(JSON.stringify(sourceBlocks)),coverage:{complete:true,description:'完整的两块合成文本；没有真实平台内容'},originalUrl:'https://example.com/'}],
    transcripts,
    assets:[{id:`${prefix}-image`,version:'1',relativePath:`assets/${prefix}-image.png`,mime:'image/png',sha256:sha256(png),bytesBase64:png.toString('base64')}],
  };validateBundle(bundle);return bundle;
}
