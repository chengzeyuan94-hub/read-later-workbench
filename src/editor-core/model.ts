/** Shared E0 / E1 content contract. Offsets count Unicode code points (Array.from), not UTF-16 units. */
export interface TextRun { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }
export interface AssetRef { assetId: string; version: string }
export interface AssetMetadata { id: string; version: string; relativePath: string; mime: string; sha256: string; bytesBase64?: string }
export interface TextRange { start: number; end: number; unit: 'unicode-code-point'; excerpt?: string; before?: string; after?: string }
export type SourceReference = ({ kind: 'capturedSource'; sourceId: string; sourceRevisionId: string; blockId: string } | { kind: 'transcript'; transcriptId: string; revision: number; segmentId: string; mediaId?: string; partId?: string; startMs?: number; endMs?: number; timeContractVersion?: 2; inputSource?: TranscriptInputSource; inputRange?: TranscriptInputRange; timing?: TranscriptTiming } | { kind: 'ocr'; resultId: string; revision: 1; blockId: string; correctionRevision?: number } | { kind: 'userDraft'; documentId: string; revision: number; blockId: string }) & { range?: TextRange; assets?: AssetRef[]; granularity?: 'source-unit' | 'frozen-slice' };
export interface DraftBlock { id: string; type: 'heading' | 'paragraph' | 'bulletList' | 'orderedList' | 'listItem' | 'blockquote' | 'image'; level?: number; runs: TextRun[]; assetRefs?: AssetRef[]; children?: DraftBlock[]; start?: number }
/** Every text leaf has a persistent ID; containers have separate IDs and never masquerade as text. */
export function walkDraftBlocks(blocks: readonly DraftBlock[]): DraftBlock[] { const result: DraftBlock[] = []; const walk=(items:readonly DraftBlock[])=>{for(const block of items){result.push(block);if(block.children)walk(block.children);}};walk(blocks);return result; }
export function findDraftBlock(blocks: readonly DraftBlock[], id:string):DraftBlock|undefined { return walkDraftBlocks(blocks).find(block=>block.id===id); }
export function textBlocks(blocks: readonly DraftBlock[]):DraftBlock[] { return walkDraftBlocks(blocks).filter(block=>block.type==='paragraph'||block.type==='heading'); }
export function getDraftAssetRefs(blocks: readonly DraftBlock[]):AssetRef[] { return walkDraftBlocks(blocks).flatMap(block=>block.assetRefs??[]); }
export function isSafeLink(value:unknown):value is string { if(typeof value!=='string'||value.length>4000||/[\u0000-\u0020\u007f]/.test(value))return false;try{return ['http:','https:','mailto:'].includes(new URL(value).protocol);}catch{return false;} }

export interface DraftDocument { documentId: string; workspaceId: string; schemaVersion: 1; revision: number; blocks: DraftBlock[] }
export interface MindMapNode { id: string; parentId: string | null; children: string[]; title: TextRun[]; notes: string; sourceRefs: SourceReference[]; image?: AssetRef; style?: { bold?: boolean; italic?: boolean; fill?: string; textColor?: string } }
export interface MindMapDocument { documentId: string; workspaceId: string; schemaVersion: 1; revision: number; sheetId: string; rootId: string; theme: { id: string; name: string }; nodes: Record<string, MindMapNode> }
export interface Workspace { id: string; collectionId: string; userTitle: string; draftDocumentId: string; mindMapDocumentId: string; draftRevision: number; mapRevision: number }
export interface SourceSnapshot { workspaceId: string; sourceId: string; sourceRevisionId: string; blocks: DraftBlock[]; sha256: string; coverage: { complete: boolean; description: string }; originalUrl: string }
/** Time is relative to the original media part, never the uploaded slice. */
export interface TranscriptInputRange { coordinate: 'media-part'; mediaId: string; partId: string; startMs?: number; endMs?: number }
export interface TranscriptInputSource { kind: 'plain-text-response' | 'manual-correction' | 'platform-subtitle' | 'synthetic' | 'legacy-unknown'; sourceId: string; revision: number; rawText: string; responseFormat?: 'text-only' | 'caption-records'; mediaId?: string; partId?: string; derivedFrom?: { sourceId: string; revision: number } }
export type TranscriptTiming = { state: 'unknown'; reason: 'not-provided' | 'legacy-unverified' } | { state: 'known'; source: 'platform-subtitle' | 'independent-alignment' | 'synthetic'; granularity: 'caption' | 'sentence' | 'segment'; coordinate: 'media-part'; mediaId: string; partId: string; startMs: number; endMs: number; evidence: { sourceId: string; revision: number; inputSourceId: string; inputSourceRevision: number } };
export interface LegacyTranscriptSegment { workspaceId: string; transcriptId: string; revision: number; segmentId: string; runs: TextRun[]; mediaId?: string; partId?: string; startMs?: number; endMs?: number }
export interface TranscriptSegment extends LegacyTranscriptSegment { timeContractVersion?: 2; inputSource?: TranscriptInputSource; inputRange?: TranscriptInputRange; sourceTextRange?: TextRange; timing?: TranscriptTiming; legacy?: { format: 'e0-v1'; identity: 'exact-synthetic-fixture' | 'unattributed'; original: LegacyTranscriptSegment } }
export interface TranscriptTrace { timeContractVersion: 2; mediaId?: string; partId?: string; inputSource: TranscriptInputSource; inputRange?: TranscriptInputRange; sourceTextRange: TextRange; timing: TranscriptTiming; legacy?: TranscriptSegment['legacy'] }
export interface EditorViewState { selection: { kind: 'node'; nodeId: string } | { kind: 'draft'; blockId: string; start: number; end: number } | null; inputSession: { id: string; targetId: string; composing: boolean } | null; viewport: { x: number; y: number; zoom: number } }
export interface WorkspaceBundle { workspace: Workspace; draft: DraftDocument; map: MindMapDocument; sources: SourceSnapshot[]; transcripts: TranscriptSegment[]; assets: AssetMetadata[] }
export type ContentDocument = DraftDocument | MindMapDocument;
export interface SaveRequest { workspaceId: string; documentId: string; sessionId: string; requestId: string; expectedRevision: number; document: ContentDocument }
export type SaveResult = { status: 'saved'; workspaceId: string; documentId: string; sessionId: string; requestId: string; committedRevision: number } | { status: 'conflict'; workspaceId: string; documentId: string; sessionId: string; requestId: string; actualRevision: number } | { status: 'failed'; workspaceId: string; documentId: string; sessionId: string; requestId: string; error: string };
export interface ResolvedReference { kind: SourceReference['kind']; text: string; selectedText: string; assets: AssetRef[]; version: string; targetId: string; transcript?: TranscriptTrace; ocr?: { contentId:number; mediaId:number; resultId:string; revision:1; blockId:string; correctionRevision?:number; originalBlockIds:string[]; manual:boolean; asset:AssetRef; image:{width:number;height:number;orientation:number}; regions:{id:string;text:string;bounds:{x:number;y:number;width:number;height:number;unit:'normalized'}}[] } }

export const plainText = (runs: TextRun[]): string => runs.map(run => run.text).join('');
export const pointLength = (text: string): number => Array.from(text).length;
export const pointSlice = (text: string, start: number, end?: number): string => Array.from(text).slice(start, end).join('');
export const clone = <T>(value: T): T => structuredClone(value);
function object(value: unknown, name: string): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: object required`); }
function str(value: unknown, name: string, empty = false): asserts value is string { if (typeof value !== 'string' || (!empty && (!value || value.length > 200))) throw new Error(`${name}: string required`); }
function integer(value: unknown, name: string, minimum = 0): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name}: integer >= ${minimum} required`); }
function array(value: unknown, name: string): asserts value is unknown[] { if (!Array.isArray(value)) throw new Error(`${name}: array required`); }
function optionalBoolean(value: unknown, name: string): void { if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name}: boolean required`); }
function keys(value: Record<string, unknown>, permitted: string[], name: string): void { for (const key of Object.keys(value)) if (!permitted.includes(key)) throw new Error(`${name}: unknown field ${key}`); }
export function validateRuns(value: unknown): asserts value is TextRun[] { array(value, 'runs'); if (value.length > 10000) throw new Error('too many runs'); for (const run of value) { object(run, 'run'); keys(run, ['text','bold','italic','code','href'], 'run'); str(run.text, 'run.text', true); if ((run.text as string).length > 1000000) throw new Error('run too long'); optionalBoolean(run.bold, 'bold'); optionalBoolean(run.italic, 'italic'); optionalBoolean(run.code, 'code'); if(run.href!==undefined&&!isSafeLink(run.href))throw new Error('unsupported link protocol'); } }
export function validateAssetRef(value: unknown): asserts value is AssetRef { object(value, 'asset ref'); keys(value, ['assetId','version'], 'asset ref'); str(value.assetId, 'assetId'); str(value.version, 'version'); }
export function validateSourceReference(value: unknown): asserts value is SourceReference {
  object(value, 'reference'); const common = ['kind','range','assets','granularity'];
  if(value.granularity!==undefined&&!['source-unit','frozen-slice'].includes(value.granularity as string))throw new Error('invalid source granularity');
  if (value.kind === 'capturedSource') { keys(value, [...common,'sourceId','sourceRevisionId','blockId'], 'reference'); str(value.sourceId, 'sourceId'); str(value.sourceRevisionId, 'sourceRevisionId'); str(value.blockId, 'blockId'); }
  else if (value.kind === 'transcript') { keys(value, [...common,'transcriptId','revision','segmentId','mediaId','partId','startMs','endMs','timeContractVersion','inputSource','inputRange','timing'], 'reference'); str(value.transcriptId, 'transcriptId'); integer(value.revision, 'revision', 1); str(value.segmentId, 'segmentId'); optionalTiming(value); if(value.timeContractVersion!==undefined){ if(value.timeContractVersion!==2)throw new Error('unsupported transcript time contract'); if(value.startMs!==undefined||value.endMs!==undefined)throw new Error('legacy numbers cannot assert sentence timing'); for(const k of ['mediaId','partId'])if(value[k]!==undefined)str(value[k],k); if(value.inputSource!==undefined)validateInputSource(value.inputSource); if(value.inputRange!==undefined)validateInputRange(value.inputRange); if(value.timing!==undefined)validateTiming(value.timing); validateTimeOwnership(value as unknown as TranscriptSegment, false); } else if(['inputSource','inputRange','timing'].some(k=>value[k]!==undefined))throw new Error('time contract version required'); }
  else if (value.kind === 'ocr') { keys(value, [...common,'resultId','revision','blockId','correctionRevision'], 'OCR reference'); str(value.resultId,'resultId'); if(value.revision!==1)throw new Error('immutable OCR result revision must be 1'); str(value.blockId,'blockId'); if(value.correctionRevision!==undefined)integer(value.correctionRevision,'correctionRevision',1); }
  else if (value.kind === 'userDraft') { keys(value, [...common,'documentId','revision','blockId'], 'reference'); str(value.documentId, 'documentId'); integer(value.revision, 'revision', 1); str(value.blockId, 'blockId'); }
  else throw new Error('unknown reference kind');
  if (value.range !== undefined) { object(value.range, 'range'); keys(value.range, ['start','end','unit','excerpt','before','after'], 'range'); integer(value.range.start, 'range.start'); integer(value.range.end, 'range.end'); if (value.range.unit !== 'unicode-code-point' || value.range.end < value.range.start) throw new Error('invalid range'); for (const k of ['excerpt','before','after']) if (value.range[k] !== undefined) str(value.range[k], k, true); }
  if (value.assets !== undefined) { array(value.assets, 'assets'); value.assets.forEach(validateAssetRef); }
}
function optionalTiming(value: Record<string, unknown>): void { for (const k of ['mediaId','partId']) if (value[k] !== undefined) str(value[k], k); for (const k of ['startMs','endMs']) if (value[k] !== undefined) integer(value[k], k); if (typeof value.startMs === 'number' && typeof value.endMs === 'number' && value.endMs < value.startMs) throw new Error('invalid time range'); }
export function validateBlock(value: unknown): asserts value is DraftBlock { validateBlockTree(value,0); }
function validateBlockTree(value:unknown,depth:number):asserts value is DraftBlock {
  if(depth>32)throw new Error('draft nesting exceeds 32');object(value,'block');keys(value,['id','type','level','runs','assetRefs','children','start'],'block');str(value.id,'block.id');
  if(!['heading','paragraph','bulletList','orderedList','listItem','blockquote','image'].includes(value.type as string))throw new Error('invalid block type');
  if(value.type==='heading'){integer(value.level,'level',1);if((value.level as number)>6)throw new Error('heading level > 6');}else if(value.level!==undefined)throw new Error('non-heading has no level');
  validateRuns(value.runs);if(value.assetRefs!==undefined){array(value.assetRefs,'assetRefs');value.assetRefs.forEach(validateAssetRef);}
  const container=['bulletList','orderedList','listItem','blockquote'].includes(value.type as string);
  if(container){array(value.children,'block children');if(!value.children.length||value.runs.length)throw new Error('container requires children and no runs');for(const child of value.children)validateBlockTree(child,depth+1);
    if(['bulletList','orderedList'].includes(value.type as string)&&!(value.children as DraftBlock[]).every(child=>child.type==='listItem'))throw new Error('list only contains listItem');
    if(value.type==='listItem'&&(value.children as DraftBlock[])[0].type!=='paragraph')throw new Error('listItem starts with paragraph');
  } else if(value.children!==undefined)throw new Error('leaf cannot contain children');
  if(value.type==='orderedList'){if(value.start!==undefined)integer(value.start,'ordered list start',1);}else if(value.start!==undefined)throw new Error('start only belongs to ordered list');
  if(value.type==='image'&&(value.runs.length||(value.assetRefs as unknown[]|undefined)?.length!==1))throw new Error('image requires one local asset and no runs');
}
function validateBlocks(value:unknown):asserts value is DraftBlock[]{array(value,'blocks');for(const block of value)validateBlock(block);const all=walkDraftBlocks(value as DraftBlock[]);if(all.length>10000)throw new Error('too many draft blocks');const ids=new Set<string>();for(const block of all){if(ids.has(block.id))throw new Error('duplicate block id');ids.add(block.id);}}
export function validateDraft(value: unknown): asserts value is DraftDocument { object(value,'draft'); keys(value,['documentId','workspaceId','schemaVersion','revision','blocks'],'draft');str(value.documentId,'documentId');str(value.workspaceId,'workspaceId');if(value.schemaVersion!==1)throw new Error('unsupported draft schema');integer(value.revision,'revision');validateBlocks(value.blocks); }
export function validateMap(value: unknown): asserts value is MindMapDocument {
  object(value,'map'); keys(value,['documentId','workspaceId','schemaVersion','revision','sheetId','rootId','theme','nodes'],'map'); for (const k of ['documentId','workspaceId','sheetId','rootId']) str(value[k],k); if(value.schemaVersion!==1)throw new Error('unsupported map schema'); integer(value.revision,'revision'); object(value.theme,'theme'); keys(value.theme,['id','name'],'theme'); str(value.theme.id,'theme.id'); str(value.theme.name,'theme.name'); object(value.nodes,'nodes');
  const nodes=value.nodes; const ids=Object.keys(nodes); if(ids.length<1||ids.length>10000)throw new Error('node count out of bounds');if(ids.some(id=>['__proto__','constructor','prototype'].includes(id)))throw new Error('reserved node id');
  let roots=0; const owner=new Map<string,string>();
  for(const [id,node] of Object.entries(nodes)) { object(node,'node'); keys(node,['id','parentId','children','title','notes','sourceRefs','image','style'],'node'); str(node.id,'node.id'); if(node.id!==id)throw new Error('node key mismatch'); if(node.parentId===null)roots++; else str(node.parentId,'parentId'); array(node.children,'children'); validateRuns(node.title); str(node.notes,'notes',true); array(node.sourceRefs,'sourceRefs'); node.sourceRefs.forEach(validateSourceReference); if(node.image!==undefined)validateAssetRef(node.image); if(node.style!==undefined){object(node.style,'style'); keys(node.style,['bold','italic','fill','textColor'],'style'); optionalBoolean(node.style.bold,'bold'); optionalBoolean(node.style.italic,'italic'); for(const k of ['fill','textColor'])if(node.style[k]!==undefined){str(node.style[k],k);if(!/^#[0-9a-fA-F]{6}$/.test(node.style[k] as string))throw new Error('color requires #RRGGBB');}}
    for(const child of node.children){str(child,'child'); if(owner.has(child))throw new Error('duplicate child ownership'); owner.set(child,id);}
  }
  if(roots!==1||!(value.rootId as string in nodes)||(nodes[value.rootId as string] as Record<string,unknown>).parentId!==null)throw new Error('exactly one declared root required');
  for(const [id,node] of Object.entries(nodes)){const n=node as Record<string,unknown>; if(id===value.rootId){if(owner.has(id))throw new Error('root owned');}else if(!owner.has(id)||owner.get(id)!==n.parentId)throw new Error('parent/child mismatch'); for(const child of n.children as string[])if(!nodes[child])throw new Error('missing child');}
  const seen=new Set<string>(), active=new Set<string>(); function visit(id:string){if(active.has(id))throw new Error('cycle');if(seen.has(id))throw new Error('duplicate traversal');active.add(id);seen.add(id);for(const child of (nodes[id] as Record<string,unknown>).children as string[])visit(child);active.delete(id);} visit(value.rootId as string); if(seen.size!==ids.length)throw new Error('unreachable nodes or cycle');
}
export function validateDocument(value: unknown): asserts value is ContentDocument { object(value,'document'); if('blocks' in value)validateDraft(value);else validateMap(value); }
/** Ephemeral only: deliberately excluded from ContentDocument and SaveRequest. */
export function validateViewState(value:unknown,context:{map?:MindMapDocument;draft?:DraftDocument}={}):asserts value is EditorViewState {
  object(value,'view state');keys(value,['selection','inputSession','viewport'],'view state');
  if(value.selection!==null){object(value.selection,'selection');
    if(value.selection.kind==='node'){keys(value.selection,['kind','nodeId'],'selection');str(value.selection.nodeId,'nodeId');if(context.map&&!Object.hasOwn(context.map.nodes,value.selection.nodeId))throw new Error('selected node does not exist');}
    else if(value.selection.kind==='draft'){keys(value.selection,['kind','blockId','start','end'],'selection');str(value.selection.blockId,'blockId');integer(value.selection.start,'start');integer(value.selection.end,'end');if(value.selection.end<value.selection.start)throw new Error('invalid selection');if(context.draft){const blockId=value.selection.blockId;const block=findDraftBlock(context.draft.blocks,blockId);if(!block)throw new Error('selected draft block does not exist');if(value.selection.end>pointLength(plainText(block.runs)))throw new Error('selection exceeds Unicode code-point boundary');}}
    else throw new Error('invalid selection kind');
  }
  if(value.inputSession!==null){object(value.inputSession,'input session');keys(value.inputSession,['id','targetId','composing'],'input session');str(value.inputSession.id,'id');str(value.inputSession.targetId,'targetId');if(typeof value.inputSession.composing!=='boolean')throw new Error('composing boolean required');const targetId=value.inputSession.targetId;if(context.map&&context.draft&&targetId!==context.draft.documentId&&!Object.hasOwn(context.map.nodes,targetId)&&!!!findDraftBlock(context.draft.blocks,targetId))throw new Error('input target does not exist');}
  object(value.viewport,'viewport');keys(value.viewport,['x','y','zoom'],'viewport');for(const k of ['x','y','zoom'])if(typeof value.viewport[k]!=='number'||!Number.isFinite(value.viewport[k]))throw new Error('finite viewport required');if((value.viewport.zoom as number)<=0)throw new Error('positive zoom required');
}
export const validateEditorViewState=validateViewState;
export function validateWorkspace(value: unknown): asserts value is Workspace { object(value,'workspace'); keys(value,['id','collectionId','userTitle','draftDocumentId','mindMapDocumentId','draftRevision','mapRevision'],'workspace'); for(const k of ['id','collectionId','draftDocumentId','mindMapDocumentId'])str(value[k],k);str(value.userTitle,'userTitle',true);integer(value.draftRevision,'draftRevision');integer(value.mapRevision,'mapRevision');if(value.draftDocumentId===value.mindMapDocumentId)throw new Error('document identities must differ'); }
export function validateSource(value: unknown): asserts value is SourceSnapshot { object(value,'source');keys(value,['workspaceId','sourceId','sourceRevisionId','blocks','sha256','coverage','originalUrl'],'source');for(const k of ['workspaceId','sourceId','sourceRevisionId'])str(value[k],k);str(value.sha256,'sha256');if(!/^[a-f0-9]{64}$/.test(value.sha256 as string))throw new Error('source sha256');str(value.originalUrl,'originalUrl',true);try{const u=new URL(value.originalUrl as string);if(!['https:','http:'].includes(u.protocol))throw new Error();}catch{throw new Error('source URL must be HTTP(S)');}object(value.coverage,'coverage');keys(value.coverage,['complete','description'],'coverage');if(typeof value.coverage.complete!=='boolean')throw new Error('coverage complete');str(value.coverage.description,'description',true);validateBlocks(value.blocks); }
export function validateInputSource(value:unknown):asserts value is TranscriptInputSource {
  object(value,'input source'); keys(value,['kind','sourceId','revision','rawText','responseFormat','mediaId','partId','derivedFrom'],'input source');
  if(!['plain-text-response','manual-correction','platform-subtitle','synthetic','legacy-unknown'].includes(value.kind as string))throw new Error('invalid input source kind');
  str(value.sourceId,'input source id',true);if(!value.sourceId||value.sourceId.length>1000)throw new Error('input source id must be nonempty and bounded');integer(value.revision,'input source revision',1);str(value.rawText,'raw recognition text',true);
  if(value.responseFormat!==undefined&&!['text-only','caption-records'].includes(value.responseFormat as string))throw new Error('invalid transcription response format');if(value.kind==='plain-text-response'&&value.responseFormat!=='text-only')throw new Error('plain text source format mismatch');if(value.kind==='platform-subtitle'&&value.responseFormat!=='caption-records')throw new Error('subtitle source format mismatch');if((value.rawText as string).length>4000000)throw new Error('raw recognition text too long');
  for(const k of ['mediaId','partId'])if(value[k]!==undefined)str(value[k],k);
  if(value.kind==='manual-correction'){object(value.derivedFrom,'correction original');keys(value.derivedFrom,['sourceId','revision'],'correction original');str(value.derivedFrom.sourceId,'correction original source');integer(value.derivedFrom.revision,'correction original revision',1);if(value.responseFormat!=='text-only'||value.revision===1||value.derivedFrom.revision!==1||value.derivedFrom.sourceId!==value.sourceId)throw new Error('correction must name its immutable original');}
  else if(value.derivedFrom!==undefined)throw new Error('only a correction has derivedFrom');
}
export function validateInputRange(value:unknown):asserts value is TranscriptInputRange {
  object(value,'input range');keys(value,['coordinate','mediaId','partId','startMs','endMs'],'input range');
  if(value.coordinate!=='media-part')throw new Error('input range uses original media-part coordinates');
  str(value.mediaId,'input mediaId');str(value.partId,'input partId');
  if((value.startMs===undefined)!==(value.endMs===undefined))throw new Error('input range requires both bounds or neither');
  optionalTiming(value);
}
export function validateTiming(value:unknown):asserts value is TranscriptTiming {
  object(value,'timing');
  if(value.state==='unknown'){keys(value,['state','reason'],'unknown timing');if(!['not-provided','legacy-unverified'].includes(value.reason as string))throw new Error('unknown timing reason');return;}
  if(value.state!=='known')throw new Error('timing state required');
  keys(value,['state','source','granularity','coordinate','mediaId','partId','startMs','endMs','evidence'],'known timing');
  if(!['platform-subtitle','independent-alignment','synthetic'].includes(value.source as string))throw new Error('invalid timing source');
  if(!['caption','sentence','segment'].includes(value.granularity as string))throw new Error('invalid timing granularity');
  if(value.source==='platform-subtitle'&&value.granularity!=='caption')throw new Error('platform subtitle has caption granularity; sentence precision requires alignment');
  if(value.source==='independent-alignment'&&value.granularity==='caption')throw new Error('alignment granularity must be sentence or segment');
  if(value.coordinate!=='media-part')throw new Error('timing uses original media-part coordinates');
  str(value.mediaId,'timing mediaId');str(value.partId,'timing partId');integer(value.startMs,'timing startMs');integer(value.endMs,'timing endMs');if(value.endMs<value.startMs)throw new Error('invalid timing range');
  object(value.evidence,'timing evidence');keys(value.evidence,['sourceId','revision','inputSourceId','inputSourceRevision'],'timing evidence');
  str(value.evidence.sourceId,'timing evidence sourceId');integer(value.evidence.revision,'timing evidence revision',1);str(value.evidence.inputSourceId,'evidence inputSourceId');integer(value.evidence.inputSourceRevision,'evidence inputSourceRevision',1);
}
function validateTimeOwnership(value:TranscriptSegment,requireComplete=true):void {
  const input=value.inputSource,range=value.inputRange,timing=value.timing;
  for(const candidate of [input,range,timing?.state==='known'?timing:undefined])if(candidate)for(const k of ['mediaId','partId'] as const)if(candidate[k]!==undefined&&candidate[k]!==value[k])throw new Error('transcript media/part ownership mismatch');
  if(timing?.state==='known'){
    if(!input){if(requireComplete)throw new Error('known timing requires input source');return;}
    if(timing.evidence.inputSourceId!==input.sourceId||timing.evidence.inputSourceRevision!==input.revision)throw new Error('timing evidence input source mismatch');
    if(input.responseFormat==='text-only'&&timing.source!=='independent-alignment')throw new Error('text-only response has no sentence timing without independent alignment');
    if(input.kind==='legacy-unknown')throw new Error('legacy input cannot acquire known timing');
    if(input.kind==='synthetic'&&timing.source!=='synthetic')throw new Error('synthetic input cannot claim real timing provenance');
    if(timing.source==='synthetic'&&input.kind!=='synthetic')throw new Error('synthetic timing needs synthetic input');
    if(timing.source==='platform-subtitle'&&(input.kind!=='platform-subtitle'||timing.evidence.sourceId!==input.sourceId||timing.evidence.revision!==input.revision))throw new Error('subtitle timing source mismatch');
    if(timing.source==='synthetic'&&(timing.evidence.sourceId!==input.sourceId||timing.evidence.revision!==input.revision))throw new Error('synthetic timing source mismatch');
    if(timing.source==='independent-alignment'&&timing.evidence.sourceId===input.sourceId)throw new Error('independent alignment needs independent evidence source');
    if(range?.startMs!==undefined&&(timing.startMs<range.startMs||timing.endMs>range.endMs!))throw new Error('sentence timing outside input source range');
  }
}
export function validateTranscript(value: unknown): asserts value is TranscriptSegment {
  object(value,'transcript');keys(value,['workspaceId','transcriptId','revision','segmentId','runs','mediaId','partId','startMs','endMs','timeContractVersion','inputSource','inputRange','sourceTextRange','timing','legacy'],'transcript');
  for(const k of ['workspaceId','transcriptId','segmentId'])str(value[k],k);integer(value.revision,'revision',1);validateRuns(value.runs);optionalTiming(value);
  if(value.timeContractVersion===undefined){if(['inputSource','inputRange','sourceTextRange','timing','legacy'].some(k=>value[k]!==undefined))throw new Error('time contract version required');return;}
  if(value.timeContractVersion!==2)throw new Error('unsupported transcript time contract');
  if(value.startMs!==undefined||value.endMs!==undefined)throw new Error('legacy numbers must remain in legacy evidence, not sentence time');
  validateInputSource(value.inputSource);validateTiming(value.timing);
  if(value.inputSource.kind==='manual-correction'&&(value.timing.state!=='unknown'||value.timing.reason!=='not-provided'))throw new Error('manual ASR correction cannot introduce sentence timing');
  if(value.inputRange!==undefined)validateInputRange(value.inputRange);
  if(!value.legacy){for(const k of ['mediaId','partId'] as const){str(value[k],k);str(value.inputSource[k],`input source ${k}`);}if(!value.inputRange)throw new Error('input range required');if(!value.inputSource.responseFormat)throw new Error('input response format required');if(value.inputSource.kind==='legacy-unknown')throw new Error('legacy input requires original evidence');if(value.timing.state==='unknown'&&value.timing.reason==='legacy-unverified')throw new Error('legacy timing reason requires original evidence');}
  else {object(value.legacy,'legacy transcript evidence');keys(value.legacy,['format','identity','original'],'legacy transcript evidence');if(value.legacy.format!=='e0-v1'||!['exact-synthetic-fixture','unattributed'].includes(value.legacy.identity as string))throw new Error('invalid legacy evidence');validateTranscript(value.legacy.original);if(value.legacy.original.timeContractVersion!==undefined)throw new Error('legacy original must be original v1');if(value.timing.state!=='unknown'||value.timing.reason!=='legacy-unverified'||value.inputRange!==undefined)throw new Error('legacy numbers never upgrade to sentence or input timing');const expected=legacyTranscriptTrace(value.legacy.original);if(!sameJson(expected.inputSource,value.inputSource)||!sameJson(expected.sourceTextRange,value.sourceTextRange)||expected.legacy!.identity!==value.legacy.identity)throw new Error('legacy evidence/source mismatch');for(const k of ['workspaceId','transcriptId','revision','segmentId','mediaId','partId'] as const)if(value[k]!==value.legacy.original[k])throw new Error('legacy identity mismatch');if(!sameJson(value.runs,value.legacy.original.runs))throw new Error('legacy raw text modified');}
  object(value.sourceTextRange,'source text range');keys(value.sourceTextRange,['start','end','unit'],'source text range');integer(value.sourceTextRange.start,'source text start');integer(value.sourceTextRange.end,'source text end');if(value.sourceTextRange.unit!=='unicode-code-point'||value.sourceTextRange.end<value.sourceTextRange.start||value.sourceTextRange.end>pointLength(value.inputSource.rawText))throw new Error('invalid raw text range');
  if(pointSlice(value.inputSource.rawText,value.sourceTextRange.start,value.sourceTextRange.end)!==plainText(value.runs))throw new Error('segment text must match uncleaned recognition text range');
  validateTimeOwnership(value as unknown as TranscriptSegment);
}
/** Exact old fixture recognition is conservative; arbitrary legacy numbers remain unattributed. */
function knownLegacyFixture(segment:LegacyTranscriptSegment):boolean {
  for(const which of ['a','b']){const prefix=`e0-${which}`;if(segment.workspaceId!==`${prefix}-workspace`||segment.transcriptId!==`${prefix}-transcript`||segment.revision!==1||segment.mediaId!=='synthetic-media')continue;
    const identity={workspaceId:segment.workspaceId,transcriptId:segment.transcriptId,revision:1,segmentId:`${prefix}-segment-unknown`,runs:[{text:'合成转录：这一段没有可靠时间，时间字段保持缺省。'}],mediaId:'synthetic-media',partId:'p2'};
    const timed={...identity,segmentId:`${prefix}-segment-timed`,runs:[{text:'合成已知时间段，仅验证结构。'}],partId:'p1',startMs:1000,endMs:3500};
    if(sameJson(segment,identity)||sameJson(segment,timed))return true;
  }return false;
}
function legacyTranscriptTrace(segment:LegacyTranscriptSegment):TranscriptTrace {
  const synthetic=knownLegacyFixture(segment),rawText=plainText(segment.runs);
  return{timeContractVersion:2,...(segment.mediaId===undefined?{}:{mediaId:segment.mediaId}),...(segment.partId===undefined?{}:{partId:segment.partId}),inputSource:{kind:synthetic?'synthetic':'legacy-unknown',sourceId:`${segment.transcriptId}:legacy:${segment.segmentId}`,revision:segment.revision,rawText,...(segment.mediaId===undefined?{}:{mediaId:segment.mediaId}),...(segment.partId===undefined?{}:{partId:segment.partId})},sourceTextRange:{start:0,end:pointLength(rawText),unit:'unicode-code-point'},timing:{state:'unknown',reason:'legacy-unverified'},legacy:{format:'e0-v1',identity:synthetic?'exact-synthetic-fixture':'unattributed',original:clone(segment)}};
}
/** Pure idempotent compatibility read. Existing SQLite JSON and historical evidence are not rewritten. */
export function normalizeTranscript(segment:TranscriptSegment):TranscriptSegment & TranscriptTrace {
  validateTranscript(segment);if(segment.timeContractVersion===2)return clone(segment) as TranscriptSegment&TranscriptTrace;
  const normalized={workspaceId:segment.workspaceId,transcriptId:segment.transcriptId,revision:segment.revision,segmentId:segment.segmentId,runs:clone(segment.runs),...legacyTranscriptTrace(segment)};validateTranscript(normalized);return normalized;
}
export function transcriptTrace(segment:TranscriptSegment):TranscriptTrace {
  const normalized=normalizeTranscript(segment);return{timeContractVersion:2,...(normalized.mediaId===undefined?{}:{mediaId:normalized.mediaId}),...(normalized.partId===undefined?{}:{partId:normalized.partId}),inputSource:clone(normalized.inputSource),...(normalized.inputRange===undefined?{}:{inputRange:clone(normalized.inputRange)}),sourceTextRange:clone(normalized.sourceTextRange),timing:clone(normalized.timing),...(normalized.legacy===undefined?{}:{legacy:clone(normalized.legacy)})};
}
function sameJson(a:unknown,b:unknown):boolean {if(a===undefined||b===undefined)return a===b;if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((item,index)=>sameJson(item,b[index]));if(a&&b&&typeof a==='object'&&typeof b==='object'){const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;const ak=Object.keys(aa).sort(),bk=Object.keys(bb).sort();return JSON.stringify(ak)===JSON.stringify(bk)&&ak.every(k=>sameJson(aa[k],bb[k]));}return a===b;}
/** A reference may omit assertions, but cannot invent or upgrade exact-version timing. */
export function assertTranscriptReference(ref:Extract<SourceReference,{kind:'transcript'}>,segment:TranscriptSegment):TranscriptTrace {
  validateSourceReference(ref);if(ref.transcriptId!==segment.transcriptId||ref.revision!==segment.revision||ref.segmentId!==segment.segmentId)throw new Error('transcript exact-version identity mismatch');const trace=transcriptTrace(segment);
  for(const k of ['mediaId','partId'] as const)if(ref[k]!==undefined&&ref[k]!==trace[k])throw new Error('transcript media/time mismatch');
  for(const k of ['startMs','endMs'] as const)if(ref[k]!==undefined&&ref[k]!==trace.legacy?.original[k])throw new Error('legacy transcript media/time mismatch');
  for(const k of ['inputSource','inputRange','timing'] as const)if(ref[k]!==undefined&&!sameJson(ref[k],trace[k]))throw new Error(`transcript exact-version ${k} mismatch`);
  return trace;
}
export function transcriptTimeDescription(trace:TranscriptTrace):string {
  const range=trace.inputRange;
  const input=`输入来源 ${trace.inputSource.kind} / ${trace.inputSource.sourceId} / revision ${trace.inputSource.revision}${trace.inputSource.responseFormat?` / 响应 ${trace.inputSource.responseFormat}`:''} / 原识别文本 code point ${trace.sourceTextRange.start}–${trace.sourceTextRange.end}`;
  const locator=`媒体 ${trace.mediaId??'未知'} / 分P ${trace.partId??'未知'} / 原媒体分P坐标`;
  const rangeLabel=range?.startMs===undefined?'来源范围 未提供':`来源范围 ${range.startMs}–${range.endMs}ms（输入分片，非逐句时间）`;
  const timing=trace.timing.state==='unknown'?`句子时间 未知（仅可定位文字与引用时版本；${trace.timing.reason}）`:`时间 ${trace.timing.startMs}–${trace.timing.endMs}ms / 来源 ${trace.timing.source} / 粒度 ${trace.timing.granularity} / 依据 ${trace.timing.evidence.sourceId}@${trace.timing.evidence.revision}`;
  const legacy=trace.legacy?`\n旧值证据 ${trace.legacy.identity}：startMs=${trace.legacy.original.startMs??'未提供'}，endMs=${trace.legacy.original.endMs??'未提供'}（未升级为可信时间）`:'';
  return`${locator}\n${input}\n${rangeLabel}\n${timing}${legacy}`;
}
export function referenceDescription(ref:SourceReference,bundle?:WorkspaceBundle):string {
  validateSourceReference(ref);
  let locator=ref.kind==='capturedSource'?`来源 ${ref.sourceId} / ${ref.sourceRevisionId} / 块 ${ref.blockId}`:ref.kind==='userDraft'?`用户正文 ${ref.documentId} / revision ${ref.revision} / 块 ${ref.blockId}`:ref.kind==='ocr'?`图片文字 ${ref.resultId} / 原始识别 revision ${ref.revision}${ref.correctionRevision===undefined?'':` / 校对 revision ${ref.correctionRevision}`} / 块 ${ref.blockId}（Markdown保留图片及可读出处，不保留交互热区）`:`转录 ${ref.transcriptId} / revision ${ref.revision} / 段 ${ref.segmentId}`;
  if(ref.kind==='transcript'){
    const segment=bundle?.transcripts.find(s=>s.transcriptId===ref.transcriptId&&s.revision===ref.revision&&s.segmentId===ref.segmentId);
    if(bundle&&!segment)throw new Error('cannot export unresolved transcript version');
    locator+='\n'+(segment?transcriptTimeDescription(assertTranscriptReference(ref,segment)):'句子时间 未知（尚未解析精确版本；引用数值不作为播放时间）');
    if(segment)locator+='\n引用文本：'+plainText(segment.runs);
  }
  const grain=ref.granularity==='source-unit'?'\n来源单元定位（粗粒度，非逐字对应）':ref.granularity==='frozen-slice'?'\n冻结来源片段定位（粗粒度，非逐字对应）':'';
  return ref.range?`${locator}${grain}\n选区(${ref.range.unit}) ${ref.range.start}–${ref.range.end}${ref.range.excerpt===undefined?'':`：${ref.range.excerpt}`}`:`${locator}${grain}`;
}
export function validateAsset(value: unknown): asserts value is AssetMetadata {object(value,'asset');keys(value,['id','version','relativePath','mime','sha256','bytesBase64'],'asset');for(const k of ['id','version','relativePath','mime','sha256'])str(value[k],k);if(!/^[a-f0-9]{64}$/.test(value.sha256 as string))throw new Error('asset sha256');if((value.relativePath as string).startsWith('/')||(value.relativePath as string).split(/[\\/]/).some(p=>p==='..'||p===''||p==='.'))throw new Error('asset requires safe relative path');if(value.bytesBase64!==undefined)str(value.bytesBase64,'bytesBase64',true);}
export function validateSaveRequest(value: unknown): asserts value is SaveRequest { object(value,'save');keys(value,['workspaceId','documentId','sessionId','requestId','expectedRevision','document'],'save');for(const k of ['workspaceId','documentId','sessionId','requestId'])str(value[k],k);integer(value.expectedRevision,'expectedRevision');validateDocument(value.document);if(value.document.documentId!==value.documentId||value.document.workspaceId!==value.workspaceId||value.document.revision!==value.expectedRevision)throw new Error('save identity/revision mismatch'); }
/** Acknowledgements are untrusted transport data until structure and request identity match. */
export function validateSaveResult(value:unknown,request?:SaveRequest):asserts value is SaveResult {
  object(value,'save result');const identity=['workspaceId','documentId','sessionId','requestId'];
  for(const key of identity){str(value[key],`save result ${key}`);if(request&&value[key]!==request[key as keyof SaveRequest])throw new Error('save result identity mismatch');}
  if(value.status==='saved'){keys(value,['status',...identity,'committedRevision'],'save result');integer(value.committedRevision,'committedRevision',1);if(request&&value.committedRevision!==request.expectedRevision+1)throw new Error('save result committed revision mismatch');}
  else if(value.status==='conflict'){keys(value,['status',...identity,'actualRevision'],'save result');integer(value.actualRevision,'actualRevision',1);if(request&&value.actualRevision===request.expectedRevision)throw new Error('save result conflict requires differing revision');}
  else if(value.status==='failed'){keys(value,['status',...identity,'error'],'save result');str(value.error,'save result error',true);if(value.error.length===0||value.error.length>10000)throw new Error('save result error must be nonempty and bounded');}
  else throw new Error('unknown save result status');
}
export function validateBundle(value: unknown): asserts value is WorkspaceBundle {object(value,'bundle');keys(value,['workspace','draft','map','sources','transcripts','assets'],'bundle');validateWorkspace(value.workspace);validateDraft(value.draft);validateMap(value.map);for(const k of ['sources','transcripts','assets'])array(value[k],k);(value.sources as unknown[]).forEach(validateSource);(value.transcripts as unknown[]).forEach(validateTranscript);(value.assets as unknown[]).forEach(validateAsset);const w=value.workspace;if(value.draft.workspaceId!==w.id||value.map.workspaceId!==w.id||value.draft.documentId!==w.draftDocumentId||value.map.documentId!==w.mindMapDocumentId||value.draft.revision!==w.draftRevision||value.map.revision!==w.mapRevision)throw new Error('bundle ownership/revision mismatch');for(const x of [...value.sources as SourceSnapshot[],...value.transcripts as TranscriptSegment[]])if(x.workspaceId!==w.id)throw new Error('source ownership mismatch');}
export interface MarkdownOptions { assetPath?: (ref:AssetRef)=>string; includeReferences?:boolean }
export function markdownRuns(runs:TextRun[]):string { return runs.map(run=>run.text.split('\n').map(text=>{if(!text)return '';let t=text.replace(/([\\`*_\[\]<>~#|{}()+.!-])/g,'\\$1');if(run.code){const ticks='`'.repeat(Math.max(1,...(text.match(/`+/g)??[]).map(s=>s.length+1)));t=ticks+' '+text+' '+ticks;}if(run.italic)t='*'+t+'*';if(run.bold)t='**'+t+'**';if(run.href)t='['+t+']('+run.href.replace(/[()]/g,c=>c==='('? '%28':'%29')+')';return t;}).join('  \n')).join(''); }
/** Presentation only: a literal marker may duplicate a structured list marker.
 * Only the same current ordinal (or a plain bullet) is redundant. Decimal values,
 * mismatched ordinals, code/link text and continuation paragraphs stay literal.
 * Stored runs, block IDs, references and source offsets are never changed. */
export function redundantListPrefixLength(runs: readonly TextRun[], kind: 'bulletList' | 'orderedList', ordinal = 1): number {
  const text = runs.map(run => run.text).join('');
  const match = kind === 'bulletList' ? /^[ \t]*[-+*•][ \t]+(?=\S)/.exec(text)
    : /^[ \t]*(\d{1,6})(?:[.．)）][ \t]+|、[ \t]*)(?=\S)/.exec(text);
  if (!match || (kind === 'orderedList' && Number(match[1]) !== ordinal)) return 0;
  let consumed = 0;
  for (const run of runs) { if (consumed >= match[0].length) break; if (run.code || run.href) return 0; consumed += run.text.length; }
  return match[0].length;
}
export function listItemDisplayRuns(runs: TextRun[], kind: 'bulletList' | 'orderedList', ordinal = 1): TextRun[] {
  let remaining = redundantListPrefixLength(runs, kind, ordinal);
  if (!remaining) return runs;
  return runs.flatMap(run => { if (!remaining) return [{ ...run }]; const count = Math.min(remaining, run.text.length); remaining -= count; return count < run.text.length ? [{ ...run, text: run.text.slice(count) }] : []; });
}
export function serializeDraftMarkdown(blocks:DraftBlock[],options:MarkdownOptions={}):string {
  const asset=(ref:AssetRef)=>options.assetPath?.(ref)??`assets/${encodeURIComponent(ref.assetId)}-${encodeURIComponent(ref.version)}`;
  const images=(block:DraftBlock)=> (block.assetRefs??[]).map(ref=>`![图片](${asset(ref).replace(/[()\s]/g,c=>encodeURIComponent(c))})`).join('\n\n');
  const render = (block: DraftBlock, displayRuns?: TextRun[]): string => {
    if (block.type === 'image') return images(block);
    if (block.type === 'blockquote') return block.children!.map(child => render(child)).join('\n\n').split('\n').map(line => '> ' + line).join('\n');
    if (block.type === 'bulletList' || block.type === 'orderedList') return block.children!.map((item, i) => {
      const ordinal = (block.start ?? 1) + i;
      const text = item.children!.map((child, index) => render(child, index === 0 && child.type === 'paragraph' ? listItemDisplayRuns(child.runs, block.type as 'bulletList' | 'orderedList', ordinal) : undefined)).join('\n\n');
      const prefix = block.type === 'orderedList' ? `${ordinal}. ` : '- ';
      return prefix + text.split('\n').map((line, n) => n ? ' '.repeat(prefix.length) + line : line).join('\n');
    }).join('\n');
    if (block.type === 'listItem') return block.children!.map(child => render(child)).join('\n\n');
    return (block.type === 'heading' ? '#'.repeat(block.level!) + ' ' : '') + markdownRuns(displayRuns ?? block.runs) + (block.assetRefs?.length ? '\n\n' + images(block) : '');
  };
  return blocks.map(block => render(block)).join('\n\n')+'\n';
}
export function markdown(document: DraftDocument, bundle?:WorkspaceBundle,options:MarkdownOptions={}): string {validateDraft(document);const body=serializeDraftMarkdown(document.blocks,options);if(!bundle||options.includeReferences===false)return body;validateBundle(bundle);if(document.workspaceId!==bundle.workspace.id||document.documentId!==bundle.draft.documentId)throw new Error('Markdown reference appendix ownership mismatch');const refs=Object.values(bundle.map.nodes).flatMap(node=>node.sourceRefs.map(ref=>`### ${plainText(node.title)}\n\n${referenceDescription(ref,bundle)}`));return body+(refs.length?'\n## 来源引用（可读降级；非原生时间链接）\n\n'+refs.join('\n\n')+'\n':'');}
