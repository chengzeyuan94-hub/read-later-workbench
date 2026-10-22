import { clone, validateBundle, validateSaveResult, type ContentDocument, type SaveRequest, type SaveResult, type WorkspaceBundle } from './model.js';

export interface Session {
  id: string; workspaceId: string; bundle: WorkspaceBundle; edit: number; savedEdit: number;
  status: 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict'; error: string;
  saving?: Promise<boolean>;
}
export interface SaveTransport { load(id: string): Promise<WorkspaceBundle>; saveAtomic(requests: SaveRequest[]): Promise<SaveResult[]> }
/** Renderer-only sessions. Revision is exclusively the last confirmed durable revision. */
export class SaveCoordinator {
  readonly sessions = new Map<string, Session>();
  active: Session | null = null;
  private loadEpoch = 0;
  private candidateEpoch = 0;
  constructor(private transport: SaveTransport, private changed: () => void = () => {}) {}
  async activate(workspaceId: string): Promise<Session | null> {
    const epoch = ++this.loadEpoch; ++this.candidateEpoch;
    const cached = this.sessions.get(workspaceId);
    if (cached) { this.active = cached; this.changed(); return cached; }
    const bundle = await this.transport.load(workspaceId);
    if (epoch !== this.loadEpoch) return null;
    validateBundle(bundle); if (bundle.workspace.id !== workspaceId) throw new Error('加载回包工作区身份不匹配');
    const session: Session = { id: `session-${crypto.randomUUID()}`, workspaceId, bundle: clone(bundle), edit: 0, savedEdit: 0, status: 'saved', error: '' };
    this.sessions.set(workspaceId, session); this.active = session; this.changed(); return session;
  }
  replace(draft: WorkspaceBundle['draft'], map: WorkspaceBundle['map']) {
    const session = this.active; if (!session) throw new Error('No active document');
    if (draft.workspaceId !== session.workspaceId || map.workspaceId !== session.workspaceId) throw new Error('Session ownership mismatch');
    session.bundle.draft = { ...clone(draft), revision: session.bundle.workspace.draftRevision };
    session.bundle.map = { ...clone(map), revision: session.bundle.workspace.mapRevision };
    session.edit++; session.status = session.saving ? 'saving' : 'dirty'; session.error = ''; this.changed();
  }
  isDirty(session = this.active) { return !!session && session.edit !== session.savedEdit; }
  async save(session = this.active): Promise<boolean> {
    if (!session) return false;
    if (session.saving) return session.saving;
    if (!this.isDirty(session)) return true;
    const atEdit = session.edit;
    const requestId = `save-${crypto.randomUUID()}`;
    const docs: ContentDocument[] = [clone(session.bundle.draft), clone(session.bundle.map)];
    const requests = docs.map(document => ({ workspaceId: session.workspaceId, documentId: document.documentId, sessionId: session.id, requestId: `${requestId}-${document.documentId}`, expectedRevision: document.revision, document }));
    session.status = 'saving'; session.error = ''; this.changed();
    const operation = (async () => {
      try {
        const results = await this.transport.saveAtomic(requests);
        if (this.sessions.get(session.workspaceId) !== session) return false;
        if (!Array.isArray(results) || results.length !== requests.length) throw new Error('保存回包数量不匹配');
        // Validate the complete batch before changing any durable metadata.
        results.forEach((result, index) => validateSaveResult(result, requests[index]));
        const failure = results.find(result => result.status === 'conflict') ?? results.find(result => result.status !== 'saved');
        if (failure) { session.status = failure.status === 'conflict' ? 'conflict' : 'failed'; session.error = failure.status === 'conflict' ? `版本冲突：磁盘版本 ${failure.actualRevision}，当前稿保留` : failure.status === 'failed' ? failure.error : ''; return false; }
        for (const result of results) if (result.status === 'saved') {
          if (result.documentId === session.bundle.draft.documentId) { session.bundle.workspace.draftRevision = result.committedRevision; session.bundle.draft.revision = result.committedRevision; }
          if (result.documentId === session.bundle.map.documentId) { session.bundle.workspace.mapRevision = result.committedRevision; session.bundle.map.revision = result.committedRevision; }
        }
        session.savedEdit = atEdit;
        session.status = this.isDirty(session) ? 'dirty' : 'saved'; return true;
      } catch (error) { session.status = 'failed'; session.error = error instanceof Error ? error.message : String(error); return false; }
      finally { session.saving = undefined; this.changed(); }
    })();
    session.saving = operation; return operation;
  }
  async saveAll(): Promise<boolean> {
    for (const session of this.sessions.values()) {
      if (session.saving && !await session.saving) return false;
      if (this.isDirty(session) && !await this.save(session)) return false;
      // Input can continue while a request is pending. Normal close only proceeds once all current edits are confirmed.
      if (this.isDirty(session)) return false;
    }
    // A prior session may have been reactivated and edited while a later session
    // was waiting for its acknowledgement. Recheck every session at the commit barrier.
    return [...this.sessions.values()].every(session => !this.isDirty(session) && !session.saving);
  }
  candidateToken() { return { epoch: ++this.candidateEpoch, sessionId: this.active?.id, edit: this.active?.edit }; }
  applyCandidate(token: ReturnType<SaveCoordinator['candidateToken']>, apply: () => void): boolean {
    if (!this.active || token.epoch !== this.candidateEpoch || token.sessionId !== this.active.id || token.edit !== this.active.edit) return false;
    apply(); return true;
  }
}
