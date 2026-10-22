import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Store } from '../src/main/store.js';
import { EditorRepository, migrateEditorSchema } from '../src/main/editor-store.js';
import { createE1Paths, resolveE1Paths } from '../src/main/e1-isolation.js';
import { fixedAssetResponse, readFixedAsset, sha256 } from '../src/main/editor-media.js';
import { clone, plainText, type SaveRequest, type WorkspaceBundle } from '../src/editor-core/model.js';
const binding = path.resolve('.runtime/node24.node');
import { png, setup, seed, repository, bundle, request } from './e1-helpers.js';
test('E1 migration preserves NULL / empty / whitespace / populated legacy values without touching business data', () => { const f = setup(); try {
    const values = [null, '', ' \t\n  ', '正文🙂\n原样'];
    const ids = values.map((v, i) => seed(f.store, `item-${i}`, 'account-a', v));
    const before = f.store.db.prepare('SELECT * FROM contents ORDER BY id').all();
    const migration = migrateEditorSchema(f.store.db, f.root);
    assert.equal(migration.migrated, true);
    assert.ok(existsSync(migration.backup!));
    const backup = new Database(migration.backup!, { readonly: true, nativeBinding: binding });
    try {
        assert.equal(backup.pragma('user_version', { simple: true }), 4);
        assert.deepEqual(backup.prepare('SELECT * FROM contents ORDER BY id').all(), before);
    }
    finally {
        backup.close();
    }
    const repo = new EditorRepository(f.store.db, f.root);
    assert.equal(repo.open(ids[0]).initialized, false);
    for (let i = 1; i < ids.length; i++) {
        const opened = repo.open(ids[i]);
        assert.equal(opened.initialized, true);
        assert.equal(plainText((opened as any).bundle.draft.blocks[0].runs), values[i]);
    }
    assert.deepEqual(f.store.db.prepare('SELECT * FROM contents ORDER BY id').all(), before);
    assert.deepEqual(migrateEditorSchema(f.store.db, f.root), { backup: null, migrated: false });
}
finally {
    f.close();
} });
test('E1 migration transaction rolls back completely and a fresh retry succeeds', () => { const f = setup(); try {
    seed(f.store);
    assert.throws(() => migrateEditorSchema(f.store.db, f.root, { failAfterSchema: true }), /injected/);
    assert.equal(f.store.db.pragma('user_version', { simple: true }), 4);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'editor_%'").get() as {
        n: number;
    }).n, 0);
    assert.equal(migrateEditorSchema(f.store.db, f.root).migrated, true);
}
finally {
    f.close();
} });
test('E1 new Store requires explicit editor enablement and refuses unknown higher schema without downgrade', () => { const root = mkdtempSync(path.join(os.tmpdir(), 'rlw-e1-version-')); try {
    let s = new Store(root);
    assert.equal(s.db.pragma('user_version', { simple: true }), 4);
    s.close();
    s = new Store(root, { editorEnabled: true });
    assert.equal(s.db.pragma('user_version', { simple: true }), 6);
    s.db.pragma('user_version=7');
    s.close();
    assert.throws(() => new Store(root, { editorEnabled: true }), /高于/);
    const db = new Database(path.join(root, 'workbench.sqlite'), { readonly: true, nativeBinding: binding });
    assert.equal(db.pragma('user_version', { simple: true }), 7);
    db.close();
}
finally {
    rmSync(root, { recursive: true, force: true });
} });
test('E1 workspace creation is idempotent and same source ID across accounts never shares a draft', () => { const f = setup(); try {
    const a = seed(f.store, 'same', 'a'), b = seed(f.store, 'same', 'b'), repo = repository(f.store);
    const first = bundle(repo, a);
    assert.equal(bundle(repo, a).workspace.id, first.workspace.id);
    assert.notEqual(bundle(repo, b).workspace.id, first.workspace.id);
    assert.equal(repo.list().length, 2);
    repo.title(first.workspace.id, '我的标题');
    assert.equal(repo.load(first.workspace.id).bundle.workspace.userTitle, '我的标题');
    assert.notEqual(f.store.content(a)!.title, '我的标题');
}
finally {
    f.close();
} });
test('E1 atomic draft-plus-map references pin the exact new draft revision; conflicts and failures leave no half state', () => { const f = setup(); try {
    const a = seed(f.store), repo = repository(f.store), original = bundle(repo, a), draft = clone(original.draft), map = clone(original.map);
    draft.blocks = [{ id: 'quote-container', type: 'blockquote', runs: [], children: [{ id: 'stable-nested', type: 'paragraph', runs: [{ text: '前🙂后' }] }] }];
    map.nodes[map.rootId].sourceRefs = [{ kind: 'userDraft', documentId: draft.documentId, revision: 2, blockId: 'stable-nested', range: { start: 1, end: 2, unit: 'unicode-code-point', excerpt: '🙂' } }];
    assert.ok(repo.save([request(draft), request(map)]).every(x => x.status === 'saved'));
    assert.equal(repo.resolve(original.workspace.id, map.nodes[map.rootId].sourceRefs[0]).selectedText, '🙂');
    const after = repo.load(original.workspace.id).bundle;
    const stale = repo.save([request(draft), request(map)]);
    assert.ok(stale.every(x => x.status === 'conflict'));
    assert.equal(repo.load(original.workspace.id).bundle.draft.revision, 2);
    const d = clone(after.draft), m = clone(after.map);
    d.blocks = [];
    m.nodes[m.rootId].notes = 'should rollback';
    assert.ok(repo.save([request(d), request(m)], { failAfterFirst: true }).every(x => x.status === 'failed'));
    assert.deepEqual(repo.load(original.workspace.id).bundle, after);
    const saved = repo.save([request(d), request(m)]);
    assert.ok(saved.every(x => x.status === 'saved'));
    assert.equal(repo.resolve(original.workspace.id, map.nodes[map.rootId].sourceRefs[0]).selectedText, '🙂');
    assert.equal(repo.restore(original.workspace.id, 'draft', 2, 3, 'session', 'restore').status, 'saved');
    assert.equal(repo.load(original.workspace.id).bundle.draft.revision, 4);
    assert.equal(repo.history(original.workspace.id).draft.length, 4);
}
finally {
    f.close();
} });
test('E1 source versions are immutable, deduplicated, exact-reference resolving, and old subtitles remain unknown time', () => { const f = setup(); try {
    const a = seed(f.store), repo = repository(f.store), b = bundle(repo, a);
    assert.equal(b.sources.length, 1);
    const source = b.sources[0], ref = { kind: 'capturedSource' as const, sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, blockId: source.blocks[0].id, range: { start: 2, end: 3, unit: 'unicode-code-point' as const, excerpt: '🙂' } };
    repo.captureSource(a);
    assert.equal(repo.load(b.workspace.id).bundle.sources.length, 1);
    f.store.db.prepare('UPDATE contents SET source_body=? WHERE id=?').run('前插新来源', a);
    repo.captureSource(a);
    assert.equal(repo.load(b.workspace.id).bundle.sources.length, 2);
    assert.equal(repo.resolve(b.workspace.id, ref).selectedText, '🙂');
    assert.equal(repo.load(b.workspace.id).bundle.draft.blocks[0].runs[0].text, '');
    const segment = b.transcripts[0];
    assert.equal(segment.timing!.state, 'unknown');
    assert.equal(segment.inputRange, undefined);
    assert.equal(segment.inputSource!.kind, 'legacy-unknown');
}
finally {
    f.close();
} });
test('E1 failed nonempty error responses and empty regressions never create a replacement source snapshot', () => { const f = setup(); try {
    const a = seed(f.store), repo = repository(f.store), b = bundle(repo, a);
    assert.equal(b.sources.length, 1);
    f.store.db.prepare("UPDATE contents SET source_body='LOGIN EXPIRED ERROR',detail_state='failed',body_complete=0 WHERE id=?").run(a);
    repo.captureSource(a);
    assert.equal(repo.load(b.workspace.id).bundle.sources.length, 1);
    f.store.db.prepare("UPDATE contents SET source_body='',detail_state='succeeded',body_complete=0 WHERE id=?").run(a);
    repo.captureSource(a);
    assert.equal(repo.load(b.workspace.id).bundle.sources.length, 1);
    assert.equal(repo.load(b.workspace.id).bundle.sources[0].blocks[0].runs[0].text, '原文🙂');
}
finally {
    f.close();
} });
test('E1 fixed image bytes survive mutable upstream replacement/non-current and all ownership/digest boundaries apply', async () => { const f = setup(); try {
    const a = seed(f.store), bId = seed(f.store, 'other'), repo = repository(f.store), b = bundle(repo, a), other = bundle(repo, bId);
    f.store.detailSaved(a, { body: '原文🙂', bodyComplete: true, media: [{ remoteUrl: 'https://example.invalid/img?secret=never-exported', kind: 'image', mime: 'image/png' }] });
    const m = f.store.content(a)!.media[0];
    writeFileSync(path.join(f.root, 'media', 'image.png'), png);
    f.store.downloadSaved(m.id, 'image.png', png.length, 'image/png');
    const image = repo.selectImage(b.workspace.id, m.id), bytes = readFixedAsset(repo.assetsDir, image);
    f.store.db.prepare('UPDATE media SET current=0 WHERE id=?').run(m.id);
    writeFileSync(path.join(f.root, 'media', 'image.png'), 'overwritten');
    assert.deepEqual(readFixedAsset(repo.assetsDir, image), bytes);
    assert.equal(repo.asset(other.workspace.id, { assetId: image.id, version: image.version }), undefined);
    assert.throws(() => repo.selectImage(other.workspace.id, m.id), /不属于/);
    assert.equal((await fixedAssetResponse(new Request('https://local'), repo.assetsDir, image)).status, 200);
    writeFileSync(path.join(repo.assetsDir, image.relativePath), 'corrupt');
    assert.throws(() => readFixedAsset(repo.assetsDir, image), /摘要/);
    assert.equal(fixedAssetResponse(new Request('https://local'), repo.assetsDir, image).status, 404);
}
finally {
    f.close();
} });
test('E1 source captures only current image bytes per media row while immutable old snapshots and references retain their versions', () => { const f = setup(); try {
    const rgbPNG = (red: number, green: number, blue: number) => {
        const chunk = (type: string, data: Buffer) => {
            const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
            header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(payload));
            return Buffer.concat([header, payload, checksum]);
        };
        const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0))]);
    };
    const a = seed(f.store), firstBytes = rgbPNG(255, 0, 0), replacementBytes = rgbPNG(0, 255, 0), secondBytes = rgbPNG(0, 0, 255);
    f.store.detailSaved(a, { body: '原件正文保持不变', bodyComplete: true, media: [{ remoteUrl: 'https://example.invalid/first', kind: 'image', mime: 'image/png', order: 1 }, { remoteUrl: 'https://example.invalid/second', kind: 'image', mime: 'image/png', order: 0 }] });
    const media = f.store.content(a)!.media, first = media.find(m => m.order === 1)!, second = media.find(m => m.order === 0)!;
    writeFileSync(path.join(f.root, 'media', 'first.png'), firstBytes); f.store.downloadSaved(first.id, 'first.png', firstBytes.length, 'image/png');
    writeFileSync(path.join(f.root, 'media', 'second.png'), secondBytes); f.store.downloadSaved(second.id, 'second.png', secondBytes.length, 'image/png');
    const repo = repository(f.store), opened = bundle(repo, a), original = opened.sources.at(-1)!;
    const refs = (source: WorkspaceBundle['sources'][number]) => source.blocks.find(block => block.id === 'source-images')?.assetRefs ?? [];
    const firstRef = { assetId: `${opened.workspace.id}-media-${first.id}`, version: sha256(firstBytes) }, replacementRef = { ...firstRef, version: sha256(replacementBytes) }, secondRef = { assetId: `${opened.workspace.id}-media-${second.id}`, version: sha256(secondBytes) };
    assert.deepEqual(refs(original), [secondRef, firstRef], 'initial snapshot follows actual platform media order');
    const originalJSON = JSON.stringify(original), oldReference = { kind: 'capturedSource' as const, sourceId: original.sourceId, sourceRevisionId: original.sourceRevisionId, blockId: 'source-images' };
    const map = clone(opened.map); map.nodes[map.rootId].sourceRefs = [oldReference]; assert.equal(repo.save([request(map)])[0].status, 'saved');

    // A successful re-download replaces bytes at the same media ID and pathname.
    writeFileSync(path.join(f.root, 'media', 'first.png'), replacementBytes); f.store.downloadSaved(first.id, 'first.png', replacementBytes.length, 'image/png');
    repo.captureSource(a);
    let current = repo.load(opened.workspace.id).bundle;
    assert.equal(current.sources.length, 2);
    assert.deepEqual(refs(current.sources.at(-1)!), [secondRef, replacementRef], 'new source contains exactly the newly pinned version for each current media row, never its historical versions');
    assert.equal(JSON.stringify(current.sources[0]), originalJSON, 'old snapshot JSON stays immutable');
    assert.deepEqual(repo.resolve(opened.workspace.id, oldReference).assets, [secondRef, firstRef], 'the saved old node still resolves its exact image versions');
    assert.deepEqual(readFixedAsset(repo.assetsDir, repo.asset(opened.workspace.id, firstRef)!), firstBytes);
    assert.deepEqual(readFixedAsset(repo.assetsDir, repo.asset(opened.workspace.id, replacementRef)!), replacementBytes);
    assert.equal(current.assets.length, 3, 'history retains both byte versions; it is not the source image manifest');
    repo.captureSource(a); assert.equal(repo.load(opened.workspace.id).bundle.sources.length, 2, 'unchanged current bytes deduplicate');

    // A now-unreadable current file must not borrow either successful historical version.
    writeFileSync(path.join(f.root, 'media', 'first.png'), 'corrupt'); f.store.downloadSaved(first.id, 'first.png', 7, 'image/png'); repo.captureSource(a);
    current = repo.load(opened.workspace.id).bundle;
    assert.deepEqual(refs(current.sources.at(-1)!), [secondRef]);
    assert.deepEqual(repo.resolve(opened.workspace.id, oldReference).assets, [secondRef, firstRef]);
    assert.deepEqual(readFixedAsset(repo.assetsDir, repo.asset(opened.workspace.id, firstRef)!), firstBytes);
    f.store.db.prepare('UPDATE media SET current=0 WHERE id=?').run(second.id); repo.captureSource(a);
    assert.deepEqual(refs(repo.load(opened.workspace.id).bundle.sources.at(-1)!), [], 'retired media is not a current source image even though pinned history remains readable');
    assert.deepEqual(readFixedAsset(repo.assetsDir, repo.asset(opened.workspace.id, secondRef)!), secondBytes);
}
finally {
    f.close();
} });
test('E1 preview revision cache rejects late old results and keeps workspace identity distinct', () => { const f = setup(); try {
    const a = seed(f.store), b = seed(f.store, 'other'), repo = repository(f.store), aa = bundle(repo, a), bb = bundle(repo, b);
    assert.equal(repo.putPreview({ workspaceId: aa.workspace.id, mapRevision: 1, configKey: 'test', state: 'ready', svg: '<svg/>', }), true);
    const map = clone(aa.map);
    map.nodes[map.rootId].notes = 'new';
    repo.save([request(map)]);
    assert.equal(repo.putPreview({ workspaceId: aa.workspace.id, mapRevision: 1, configKey: 'test', state: 'ready', svg: '<svg/>' }), false);
    assert.equal(repo.putPreview({ workspaceId: bb.workspace.id, mapRevision: 1, configKey: 'test', state: 'failed', error: '重试' }), true);
    assert.equal(repo.previews().length, 1);
    assert.equal(repo.previews()[0].workspaceId, bb.workspace.id);
}
finally {
    f.close();
} });
test('E1 isolation rejects missing/relative/aliased root, child directories, marker, database and dangling symlinks', () => { const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rlw-e1-entry-'))); try {
    assert.throws(() => resolveE1Paths(undefined, { projectRoot: project }));
    assert.throws(() => resolveE1Paths('relative', { projectRoot: project }));
    const root = path.join(project, '.acceptance-data/editor-e1/run-1'), p = createE1Paths(root, { projectRoot: project });
    writeFileSync(path.join(root, 'e1-isolated.json'), JSON.stringify({ schema: 1, kind: 'read-later-workbench-editor-e1', root }));
    assert.equal(resolveE1Paths(root, { mustExist: true, projectRoot: project }).root, root);
    rmdirSync(p.dataDir);
    const outside = path.join(project, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, p.dataDir);
    assert.throws(() => resolveE1Paths(root, { mustExist: true, projectRoot: project }), /symlink/);
    rmSync(p.dataDir);
    mkdirSync(p.dataDir);
    rmSync(path.join(root, 'e1-isolated.json'));
    writeFileSync(path.join(outside, 'marker'), '{}');
    symlinkSync(path.join(outside, 'marker'), path.join(root, 'e1-isolated.json'));
    assert.throws(() => resolveE1Paths(root, { mustExist: true, projectRoot: project }), /symlink/);
    const dangling = path.join(project, '.acceptance-data/editor-e1/dangling');
    symlinkSync(path.join(project, 'missing'), dangling);
    assert.throws(() => resolveE1Paths(dangling, { projectRoot: project }), /symlink/);
}
finally {
    rmSync(project, { recursive: true, force: true });
} });

test('E1 fixed resource protocol refuses traversal, symlink escape and MIME substitution',()=>{
 const f=setup();try{const a=seed(f.store),repo=repository(f.store),b=bundle(repo,a);const digest=sha256(png),asset={id:'safe',version:digest,relativePath:'safe.png',mime:'image/png',sha256:digest};writeFileSync(path.join(repo.assetsDir,'safe.png'),png);writeFileSync(path.join(f.root,'outside.png'),png);assert.equal(fixedAssetResponse(new Request('https://local'),repo.assetsDir,asset).status,200);assert.equal(fixedAssetResponse(new Request('https://local'),repo.assetsDir,{...asset,relativePath:'../outside.png'}).status,404);symlinkSync(path.join(f.root,'outside.png'),path.join(repo.assetsDir,'escape.png'));assert.equal(fixedAssetResponse(new Request('https://local'),repo.assetsDir,{...asset,relativePath:'escape.png'}).status,404);assert.equal(fixedAssetResponse(new Request('https://local'),repo.assetsDir,{...asset,mime:'image/jpeg'}).status,404);assert.equal(repo.asset(b.workspace.id,{assetId:asset.id,version:asset.version}),undefined);}finally{f.close();}
});
