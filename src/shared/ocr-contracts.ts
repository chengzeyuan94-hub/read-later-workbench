import type { AssetMetadata } from '../editor-core/model.js';
export type OcrJobState='preparing'|'inspecting'|'waiting-capability'|'queued'|'running'|'succeeded'|'no-text'|'partial'|'waiting-files'|'failed'|'cancelled';
export interface OcrBounds {x:number;y:number;width:number;height:number;unit:'normalized'}
export interface OcrRawExifOrientation {container:'jpeg'|'webp'|'png';type:number;count:number;value:number|null;offset:number;status:'valid'|'nonstandard'|'invalid';reason?:string}
export interface OcrHeaderMetadata {rawWidth:number;rawHeight:number;width:number;height:number;orientation:number;mime:string;rawExif:{status:'missing'|'valid'|'nonstandard'|'malformed';fields:OcrRawExifOrientation[];issues:string[]};orientationAuthority:'header-only-not-decoded'}
export interface OcrCandidate {id:string;text:string;bounds:OcrBounds;confidence:number;sliceId:string;edgeDistancePx:number;selected:boolean}
export interface OcrNormalization {policyVersion:'imageio-decode-v2';basis:'imageio-validated-orientation'|'imageio-default-after-full-decode';imageIOOrientation?:number;decode:'full-resolution'}
export interface OcrBlock {id:string;text:string;order:number;bounds:OcrBounds;confidence?:number;sliceIds:string[];provenance?:{selectedId:string;candidates:OcrCandidate[];conflict:boolean;mergePolicy:string;selectionReason:string;row:number;baselinePx:number}}
export interface OcrSlice {id:string;x:number;y:number;width:number;height:number;status:'succeeded'|'failed';error?:string|{code:string;message:string}}
export interface OcrEngine {id:string;version:string;osVersion:string;osBuild:string;architecture:string;revision:number;supportedRevisions:number[];supportedLanguages:string[];languages:string[];mode:'accurate';algorithm:string;configSha256:string;[key:string]:unknown}
export interface OcrImage {normalization?:OcrNormalization;width:number;height:number;rawWidth:number;rawHeight:number;orientation:number;orientationTransform:{normalizedDisplayToRaw:number[];unit?:string;displayOrigin?:string;rawOrigin?:string}}
export interface OcrResult {resultId:string;revision:1;contentId:number;requestId:string;scopeRevisionId:string;mediaId:number;mediaVersion:string;sha256:string;mime:string;asset:AssetMetadata;image:OcrImage;engine:OcrEngine;text:string;blocks:OcrBlock[];slices:OcrSlice[];coverage:'complete'|'partial'|'no-text';warnings:string[];quality?:{execution:'complete'|'partial';review:'required';conflictBlocks:number};createdAt:number;startedAt:string;completedAt:string;metrics?:{elapsedMs:number;peakResidentBytes:number;memoryMethod:string}}
export interface OcrCorrectionBlock {id:string;text:string;originalBlockIds:string[];provenance:'ocr'|'manual'}
export interface OcrCorrection {resultId:string;revision:number;blocks:OcrCorrectionBlock[];text:string;savedAt:number}
export interface OcrSavedVersion {kind:'original'|'correction';revision:number}
export interface OcrDocument {result:OcrResult;correction:OcrCorrection|null;correctionHead:number;correctionHistory:{revision:number;savedAt:number}[];adopted:OcrSavedVersion}
export interface OcrProgress {preparing?:number;inspecting?:number;waitingCapability?:number;total:number;succeeded:number;noText:number;partial:number;waitingFiles:number;failed:number;queued:number;running:number;cancelled:number}
export interface OcrCapability {available:boolean;supported?:boolean;reason?:string;engine?:OcrEngine}
/** Image recognition is macOS-only (Apple Vision); other platforms digest text-only. */
export const OCR_UNSUPPORTED_REASON = '此系统暂不支持本机图片文字识别，图片未参与整理';
export interface OcrSelection {mediaId:number;included:boolean;reason:string;roles:string[]}
export interface OcrJob {id:string;mediaId:number;title:string;order:number;state:OcrJobState;attempts:number;error?:string;errorCode?:string;recovery?:'new-request'|'retry-frozen';inspection?:OcrImage;resultId?:string;reused:boolean}
export interface OcrContentState {preparation?:{policyVersion:string|null;state:'legacy'|'preparing'|'frozen'|'blocked';frozen:number;selected:number};contentId:number;requestId:string|null;scopeRevisionId:string|null;totalMedia:number;selectedMedia:number;selection:OcrSelection[];jobs:OcrJob[];capability:OcrCapability;progress:OcrProgress;results:{resultId:string;mediaId:number;createdAt:number;coverage:OcrResult['coverage'];correctionHead:number;adopted:OcrSavedVersion;active:boolean}[]}
export interface OcrCorrectionSave {contentId:number;resultId:string;sessionId:string;requestId:string;expectedRevision:number;blocks:OcrCorrectionBlock[]}
export type OcrCorrectionSaveResult=({contentId:number;resultId:string;sessionId:string;requestId:string}) & ({status:'saved';revision:number}|{status:'conflict';actualRevision:number}|{status:'failed';error:string});
export interface OcrExportSelection {resultId:string;version:OcrSavedVersion}
export interface OcrExportResult {status:'exported'|'cancelled';path?:string;files?:number}
export interface OcrAPI {list(contentId:number):Promise<OcrContentState>;read(contentId:number,resultId:string,correctionRevision?:number):Promise<OcrDocument>;saveCorrection(request:OcrCorrectionSave):Promise<OcrCorrectionSaveResult>;adopt(contentId:number,resultId:string,version:OcrSavedVersion):Promise<OcrContentState>;retry(contentId:number,mediaId?:number):Promise<OcrContentState>;export(contentId:number,selection:OcrExportSelection[]):Promise<OcrExportResult>;imageUrl(contentId:number,resultId:string):string}
