import type { AssetMetadata, AssetRef, ContentDocument, ResolvedReference, SaveRequest, SaveResult, SourceReference, WorkspaceBundle } from '../editor-core/model.js';
import type { KnowledgeCardPayload, KnowledgeCardTarget } from './knowledge-card.js';
export type EditorInitializationKind = 'source' | 'subtitle' | 'blank';
export interface EditorInitialization {
    initialized: false;
    contentId: number;
    title: string;
    available: {
        source: boolean;
        subtitle: boolean;
        blank: true;
    };
}
export interface EditorWorkspaceRecord {
    initialized: true;
    contentId: number;
    bundle: WorkspaceBundle;
    sourceRevisionId: string | null;
    sourceUpdated: boolean;
    updatedAt: number;
    /** Unavailable exact source versions never replace or invalidate the human documents. */
    unavailableSources?: EditorUnavailableSource[];
}
export interface EditorUnavailableSource {
    kind: 'transcript';
    transcriptId: string;
    revision: number;
    segmentId: string;
    mediaId?: string;
    partId?: string;
    code: 'missing-file' | 'file-unavailable' | 'damaged-source' | 'invalid-source' | 'upstream-unavailable';
    reason: string;
    referencedByNodeIds: string[];
}
export type EditorOpenResult = EditorInitialization | EditorWorkspaceRecord;
export interface EditorHistoryEntry {
    revision: number;
    savedAt: number;
    kind: 'draft' | 'map';
}
export interface EditorHistory {
    draft: EditorHistoryEntry[];
    map: EditorHistoryEntry[];
}
export interface EditorPreview {
    contentId?: number;
    userTitle?: string;
    updatedAt?: number;
    nodeCount?: number;
    workspaceId: string;
    mapRevision: number;
    configKey: string;
    state: 'ready' | 'failed';
    svg?: string;
    error?: string;
}
export type EditorExportKind = 'draft' | 'map' | 'both';
export interface EditorExportResult {
    status: 'exported' | 'cancelled';
    path?: string;
    files?: number;
    draftRevision?: number;
    mapRevision?: number;
    warnings?: string[];
    mediaIncluded?: boolean;
    mediaFiles?: number;
    mediaBytes?: number;
    offlineComplete?: boolean;
}
export interface EditorExportMediaItem {mediaId:number;kind:'audio'|'video';label:string;bytes:number;status:'available'|'missing';reason?:string}
export interface EditorExportMediaPreview {items:EditorExportMediaItem[];totalBytes:number;missingCount:number}
export interface EditorExportOptions {includeLocalMedia?:boolean;operationId?:string}
export interface EditorExportProgress {operationId:string;phase:'preparing'|'copying'|'publishing';copiedBytes:number;totalBytes:number;currentFile?:string}
export interface EditorAPI {
    previewExportMedia?(workspaceId:string):Promise<EditorExportMediaPreview>;
    onExportProgress?(listener:(progress:EditorExportProgress)=>void):()=>void;
    cancelExport?(operationId:string):Promise<void>;
    revealExport?(path:string):Promise<void>;
    exportXmind?(workspaceId: string, expected: { draftRevision: number; mapRevision: number }): Promise<EditorExportResult>;
    open(contentId: number, initialization?: EditorInitializationKind): Promise<EditorOpenResult>;
    load(workspaceId: string): Promise<EditorWorkspaceRecord>;
    save(requests: SaveRequest[]): Promise<SaveResult[]>;
    title(workspaceId: string, title: string): Promise<void>;
    resolve(workspaceId: string, ref: SourceReference): Promise<ResolvedReference>;
    history(workspaceId: string): Promise<EditorHistory>;
    restore(workspaceId: string, kind: 'draft' | 'map', revision: number, expectedRevision: number, sessionId: string, requestId: string): Promise<SaveResult>;
    images(workspaceId: string): Promise<AssetMetadata[]>;
    selectImage(workspaceId: string, mediaId: number): Promise<AssetMetadata>;
    assetUrl(workspaceId: string, ref: AssetRef): string;
    preview(workspaceId: string, mapRevision: number, configKey?: string): Promise<EditorPreview>;
    previews(): Promise<EditorPreview[]>;
    export(workspaceId: string, kind: EditorExportKind, expected: {
        draftRevision: number;
        mapRevision: number;
    }, options?:EditorExportOptions): Promise<EditorExportResult>;
    /** Renders the editable card data at 1080×1440 offscreen; 'save' asks for a PNG path, 'copy' puts it on the clipboard. */
    knowledgeCardPng?(payload: KnowledgeCardPayload, target: KnowledgeCardTarget): Promise<{ status: 'exported' | 'copied' | 'cancelled'; path?: string }>;
}
export type { AssetMetadata, AssetRef, ContentDocument, ResolvedReference, SaveRequest, SaveResult, SourceReference, WorkspaceBundle };
