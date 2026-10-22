import type { AssetRef, DraftDocument, MindMapDocument, SourceReference } from '../editor-core/model.js';

/** E3 contracts. All textual offsets use exact Unicode code points, without NFC/whitespace rewriting. */
export interface GenerationSourceUnit {
  id: string;
  kind: 'capturedSource' | 'ocr' | 'transcript';
  text: string;
  reference: SourceReference;
  versionIdentity: string;
  coverage: 'complete' | 'partial';
  warnings: string[];
  assetRefs?: AssetRef[];
}
export interface GenerationFrozenInput { sourceRevisionId: string; title: string; units: GenerationSourceUnit[] }
export interface GenerationSourceSlice { unitId: string; start: number; end: number; sha256: string }
export interface GenerationChunk { id: string; order: number; inputSha256: string; slices: GenerationSourceSlice[] }
export interface GenerationPlan { version: 'source-slices-v1'; sourceRevisionId: string; sourceSha256: string; chunks: GenerationChunk[]; maxAttemptsPerStagePerChunk: 2 }
export interface GenerationCitation { unitId: string; start: number; end: number; excerpt: string; granularity?: 'source-unit' | 'frozen-slice' }
export interface GenerationCoverage { unitId: string; start: number; end: number; disposition: 'included' | 'duplicate'; duplicateOf?: GenerationCitation }
export interface GenerationBlock {
  id: string; type: 'heading' | 'paragraph' | 'quote' | 'bullet' | 'step' | 'image';
  text: string; level?: number; role: 'fact' | 'structure'; citations: GenerationCitation[];
  assetRef?: AssetRef;
}
export interface OrganizedDocument {
  schemaVersion: 1; sourceRevisionId: string; title: string; lead: string;
  leadCitations?: GenerationCitation[]; blocks: GenerationBlock[]; coverage: GenerationCoverage[];
}
export interface GeneratedMapNode { id: string; parentId: string | null; children: string[]; title: string; notes: string; role: 'fact' | 'structure'; citations: GenerationCitation[] }
export interface GeneratedMap { schemaVersion: 1; sourceRevisionId: string; organizedSha256: string; rootId: string; nodes: GeneratedMapNode[] }
export interface GenerationModelSelection {
  provider: 'siliconflow' | 'deepseek'; model: string; discoveredAt: number; accountModelsSha256: string;
  publishedContextTokens: number; providerOutputLimitTokens: number | null;
  inputBudgetUtf8Bytes: number; maxOutputTokens: number; applicationContextBudgetTokens: number;
  responseFormat: 'json_object'; promptVersion: 'read-create-source-grounded-v1' | 'read-create-quality-v2' | 'read-create-usability-v3'; configurationSha256: string;
  capabilitySources: string[];
}
export type GenerationStage = 'organize' | 'map';
export interface GenerationCoordinateRepair {
  kind: 'citation' | 'coverage'; path: string;
  before: { unitId: string; start: number; end: number };
  after: { unitId: string; start: number; end: number };
  excerptSha256: string; citationPath?: string;
}
export interface GenerationCoordinateAudit {
  policyVersion: 'exact-excerpt-unique-codepoint-v1' | 'source-association-usability-v1'; sourceSha256: string;
  originalValueSha256: string; canonicalValueSha256: string; repairs: GenerationCoordinateRepair[]; associations?: { path: string; unitId: string; granularity: 'excerpt' | 'source-unit' | 'frozen-slice'; reason: string }[];
}
export interface GenerationQualityAudit {
  policyVersion: 'typed-map-source-fidelity-v3'; sourceSha256: string; originalValueSha256: string; canonicalValueSha256: string;
  nodeMappings: { path: string; id: string; kind: 'group' | 'claim' }[];
}
export interface GenerationRetryFeedback { policyVersion: 'bounded-rejection-v1'; stage: GenerationStage; previousResponseSha256: string; diagnosticSha256: string; code: string; jsonPath: string; repairHint: string }
export interface GenerationProviderResult { value: unknown; rawResponse: Record<string, unknown>; traceId?: string; model: string; configurationSha256: string; promptVersion: GenerationModelSelection['promptVersion']; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; qualityNormalization?: GenerationQualityAudit & { originalResponse: { relativePath: string; sha256: string } }; coordinateNormalization?: GenerationCoordinateAudit & { originalResponse: { relativePath: string; sha256: string } } }
export interface GenerationArtifact {
  sourceRevisionId: string; sourceSha256: string; organizedSha256: string;
  organized: OrganizedDocument; generatedMap: GeneratedMap;
  draft: DraftDocument; draftSha256: string; map: MindMapDocument;
  /** Exact generated body references; never masquerade as a second editable Markdown string. */
  blockSourceRefs: Record<string, SourceReference[]>;
  review: { state: 'required'; reason: string; sourceWarnings: string[] };
}
export type GenerationJobState = 'waiting-extraction' | 'waiting-files' | 'waiting-content' | 'preparing' | 'queued' | 'running' | 'publishing' | 'waiting-configuration' | 'waiting-model' | 'waiting-network' | 'result-unknown' | 'failed' | 'cancelled' | 'succeeded';

/** Repository / IPC state. Model payloads remain private source artifacts. */
export interface GenerationTarget {workspaceId:string;draftDocumentId:string;mapDocumentId:string;draftRevision:number;mapRevision:number;contentSha256:string;manualEpoch:number;managed:boolean}
export interface GenerationTaskRecord {id:string;stage:GenerationStage;chunkId:string;order:number;state:GenerationJobState;attempts:number;error?:string;errorCode?:string;reused:boolean;mayDuplicateCharge:boolean}
export interface GenerationCandidateRecord {id:string;requestId:string;sourceRevisionId:string;createdAt:number;adopted:boolean;draftRevision:number;mapRevision:number}
export interface GenerationState {contentId:number;requestId:string|null;authorized:boolean;state:GenerationJobState;sourceRevisionId:string|null;target:GenerationTarget|null;model:GenerationModelSelection|null;tasks:GenerationTaskRecord[];candidate:GenerationCandidateRecord|null;currentArtifactId:string|null;canRestorePrevious:boolean;markdown:{state:'none'|'ready'|'pending'|'failed';draftRevision?:number;error?:string};error?:string;errorCode?:string}
export interface GenerationArtifactView {id:string;requestId:string;artifact:GenerationArtifact;candidate:boolean;installed:boolean;createdAt:number;markdownText:string;files:{relativePath:string;sha256:string}[]}
export interface GenerationAPI {
 /** Native hidden input; only configuration booleans cross IPC. */
 configureCredentials?():Promise<{configured:boolean}>;
 /** Paste a key in settings; only the configured boolean crosses IPC back. */
 setCredential?(key:string):Promise<{configured:boolean}>;
 status(contentId:number):Promise<GenerationState>;
 /** false acquires temporary installation protection; true records actual human mutation. */
 touch(contentId:number,sessionId:string,dirty?:boolean):Promise<{epoch:number}>;
 release(contentId:number,sessionId:string):Promise<void>;
 retry(contentId:number,acknowledgeUnknown?:boolean):Promise<GenerationState>;
 candidate(contentId:number):Promise<GenerationArtifactView|null>;
 adopt(contentId:number,candidateId:string,expected:GenerationTarget):Promise<GenerationState>;
 artifact(contentId:number):Promise<GenerationArtifactView|null>;
 undoAdoption?(contentId:number,expected:GenerationTarget):Promise<GenerationState>;
 refreshMarkdown?(contentId:number):Promise<GenerationState>;
 assetUrl?(contentId:number,artifactId:string,relativePath:string):string;
 onBeforeInstall?(handler:(contentId:number,requestId:string)=>Promise<boolean>):()=>void;
}
