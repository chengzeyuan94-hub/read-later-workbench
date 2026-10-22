import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import type { SaveRequest, WorkspaceBundle } from '../src/editor-core/model.js';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQakAAAAASUVORK5CYII=', 'base64');
export function setup() { const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rlw-e1-storage-'))), store = new Store(root); return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } }; }
export function seed(store: Store, sourceId = 'realish-1', accountId = 'account-a', editedBody: string | null = null): number { store.saveSnapshot({ platform: 'xiaohongshu', accountId, accountName: 'synthetic only', folders: [], complete: true, items: [{ sourceId, title: '合成迁移 🧠 / 标题', author: 'test', url: 'https://www.xiaohongshu.com/explore/test', kind: 'image', folderIds: [] }] }, [{ item: { sourceId, title: '合成迁移 🧠 / 标题', author: 'test', url: 'https://www.xiaohongshu.com/explore/test', kind: 'image', folderIds: [] }, discovery: 'historical' }], 1); const id = store.find('xiaohongshu', accountId, sourceId)!; store.db.prepare("UPDATE contents SET edited_body=?,source_body=?,body_complete=1,detail_state='succeeded',subtitle=?,digested_at=123,last_reviewed_at=456 WHERE id=?").run(editedBody, '原文🙂\n第二段', '旧纯文字字幕没有时间', id); return id; }
export function repository(store: Store): EditorRepository { migrateEditorSchema(store.db, store.dataDir); return new EditorRepository(store.db, store.dataDir); }
export function bundle(repo: EditorRepository, id: number): WorkspaceBundle { const result = repo.open(id, 'blank'); assert.equal(result.initialized, true); return (result as any).bundle; }
export function request(document: WorkspaceBundle['draft'] | WorkspaceBundle['map'], token = 'r'): SaveRequest { return { workspaceId: document.workspaceId, documentId: document.documentId, expectedRevision: document.revision, sessionId: 'session-1', requestId: token, document }; }
