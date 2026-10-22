import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clone } from '../src/editor-core/model.js';
import { exportFilename, exportMarkdown } from '../src/main/editor-export.js';
import { sha256 } from '../src/main/editor-media.js';
import { png, setup, seed, repository, bundle, request } from './e1-helpers.js';
function prepared() { const f = setup(), id = seed(f.store), repo = repository(f.store), b = bundle(repo, id); f.store.detailSaved(id, { body: '合成原文', bodyComplete: true, media: [{ remoteUrl: 'https://example.invalid/image', kind: 'image', mime: 'image/png' }, { remoteUrl: 'https://example.invalid/unreferenced', kind: 'image', mime: 'image/png' }] }); for (const m of f.store.content(id)!.media) {
    const filename = `image-${m.id}.png`;
    writeFileSync(path.join(f.root, 'media', filename), png);
    f.store.downloadSaved(m.id, filename, png.length, 'image/png');
} const image = repo.selectImage(b.workspace.id, f.store.content(id)!.media[0].id), draft = clone(b.draft), map = clone(b.map); draft.blocks = [{ id: 'h1', type: 'heading', level: 1, runs: [{ text: '一级🙂' }] }, { id: 'h2', type: 'heading', level: 2, runs: [{ text: '二级' }] }, { id: 'h3', type: 'heading', level: 3, runs: [{ text: '三级' }] }, { id: 'p', type: 'paragraph', runs: [{ text: '粗体', bold: true }, { text: '斜体', italic: true }, { text: '代码', code: true }, { text: '链接', href: 'https://example.com/safe' }] }, { id: 'ul', type: 'bulletList', runs: [], children: [{ id: 'li', type: 'listItem', runs: [], children: [{ id: 'list-text', type: 'paragraph', runs: [{ text: '无序项' }] }] }] }, { id: 'ol', type: 'orderedList', start: 3, runs: [], children: [{ id: 'oli', type: 'listItem', runs: [], children: [{ id: 'olp', type: 'paragraph', runs: [{ text: '有序项' }] }] }] }, { id: 'q', type: 'blockquote', runs: [], children: [{ id: 'qp', type: 'paragraph', runs: [{ text: '引用块' }] }] }, { id: 'img', type: 'image', runs: [], assetRefs: [{ assetId: image.id, version: image.version }] }]; map.nodes[map.rootId].image = { assetId: image.id, version: image.version }; map.nodes[map.rootId].notes = '备注'; assert.ok(repo.save([request(draft), request(map)]).every(x => x.status === 'saved')); return { ...f, repo, b: repo.load(b.workspace.id).bundle, image }; }
test('E1 Markdown three scopes preserve semantics and only collect referenced fixed images', () => { const f = prepared(); try {
    const parent = path.join(f.root, 'exports');
    mkdirSync(parent);
    for (const kind of ['draft', 'map', 'both'] as const) {
        const result = exportMarkdown(f.repo, f.b.workspace.id, kind, { draftRevision: 2, mapRevision: 2 }, path.join(parent, '中文🧠 / invalid'.replace('/', '_') + '.md'));
        assert.equal(result.status, 'exported');
        assert.ok(result.path);
        assert.equal(result.files, 2);
        const files = readdirSync(result.path!);
        assert.equal(files.filter(x => x.endsWith('.md')).length, 1);
        const text = readFileSync(path.join(result.path!, files.find(x => x.endsWith('.md'))!), 'utf8');
        assert.match(text, /音视频文件未包含/);
        assert.doesNotMatch(text, /rlw-editor:|rlw-media:|file:\/\/|!\[[^\]]*\]\(https?:/);
        assert.equal(readdirSync(path.join(result.path!, 'assets')).length, 1);
        if (kind !== 'map') {
            for (const semantic of ['# 一级🙂', '## 二级', '### 三级', '**粗体**', '*斜体*', '[链接](https://example.com/safe)', '- 无序项', '3. 有序项', '> 引用块'])
                assert.ok(text.includes(semantic), semantic);
        }
        if (kind !== 'draft')
            assert.match(text, /备注/);
        const relative = /!\[[^\]]*\]\((assets\/[^)]+)\)/.exec(text)![1];
        assert.equal(sha256(readFileSync(path.join(result.path!, relative))), f.image.sha256);
    }
}
finally {
    f.close();
} });
test('E1 Markdown saved-version check, failures and collisions never damage a prior target', () => { const f = prepared(); try {
    const parent = path.join(f.root, 'exports');
    mkdirSync(parent);
    const target = path.join(parent, 'same.md');
    writeFileSync(target, 'USER ORIGINAL');
    assert.throws(() => exportMarkdown(f.repo, f.b.workspace.id, 'draft', { draftRevision: 1, mapRevision: 2 }, target), /版本/);
    for (const failAt of ['after-write', 'before-publish'] as const)
        assert.throws(() => exportMarkdown(f.repo, f.b.workspace.id, 'both', { draftRevision: 2, mapRevision: 2 }, target, { failAt }), /injected/);
    assert.equal(readFileSync(target, 'utf8'), 'USER ORIGINAL');
    assert.deepEqual(readdirSync(parent), ['same.md']);
    const first = exportMarkdown(f.repo, f.b.workspace.id, 'both', { draftRevision: 2, mapRevision: 2 }, target), second = exportMarkdown(f.repo, f.b.workspace.id, 'both', { draftRevision: 2, mapRevision: 2 }, target);
    assert.notEqual(first.path, second.path);
    assert.equal(readFileSync(target, 'utf8'), 'USER ORIGINAL');
}
finally {
    f.close();
} });
test('E1 Markdown missing referenced image reports incomplete; moved output remains entirely self-contained', () => { const f = prepared(); try {
    const parent = path.join(f.root, 'exports');
    mkdirSync(parent);
    const result = exportMarkdown(f.repo, f.b.workspace.id, 'both', { draftRevision: 2, mapRevision: 2 }, path.join(parent, '搬动🙂.md'));
    const moved = path.join(f.root, 'new-location');
    renameSync(result.path!, moved);
    const md = readdirSync(moved).find(x => x.endsWith('.md'))!, text = readFileSync(path.join(moved, md), 'utf8'), links = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    assert.ok(links.length >= 2);
    for (const link of links) {
        assert.ok(!path.isAbsolute(link));
        assert.ok(readFileSync(path.join(moved, link)).equals(png));
    }
    writeFileSync(path.join(f.repo.assetsDir, f.image.relativePath), 'corrupt');
    assert.throws(() => exportMarkdown(f.repo, f.b.workspace.id, 'draft', { draftRevision: 2, mapRevision: 2 }, path.join(parent, 'failure.md')), /摘要/);
    assert.ok(!existsSync(path.join(parent, 'failure')));
}
finally {
    f.close();
} });
test('E1 map Markdown keeps multiline root and child titles inside their list items before nested branches and notes', () => { const f = setup(); try {
    const id = seed(f.store), repo = repository(f.store), b = bundle(repo, id), map = clone(b.map), root = map.nodes[map.rootId], parent = path.join(f.root, 'exports');
    mkdirSync(parent);
    root.title = [{ text: '根第一行\n根第二行' }];
    root.children = ['child-multiline', 'sibling'];
    map.nodes['child-multiline'] = { id: 'child-multiline', parentId: root.id, children: ['grandchild'], title: [{ text: '子第一行\n子第二行', bold: true }], notes: '子节点备注', sourceRefs: [] };
    map.nodes.grandchild = { id: 'grandchild', parentId: 'child-multiline', children: [], title: [{ text: '孙节点' }], notes: '', sourceRefs: [] };
    map.nodes.sibling = { id: 'sibling', parentId: root.id, children: [], title: [{ text: '同级节点' }], notes: '', sourceRefs: [] };
    assert.equal(repo.save([request(map)])[0].status, 'saved');
    const result = exportMarkdown(repo, b.workspace.id, 'map', { draftRevision: 1, mapRevision: 2 }, path.join(parent, 'multiline.md'));
    const markdown = readFileSync(result.path!, 'utf8');
    assert.ok(markdown.includes([
        '- 根第一行  ',
        '  根第二行',
        '  - **子第一行**  ',
        '    **子第二行**',
        '    > 子节点备注',
        '    - 孙节点',
        '  - 同级节点',
    ].join('\n')), 'each continuation line must remain within the containing list item at every depth');
    assert.doesNotMatch(markdown, /^根第二行|^\*\*子第二行/m, 'multiline title text must not escape into top-level paragraphs');
}
finally {
    f.close();
} });
test('E1 text-only export chooses a new .md filename and sanitizes Chinese/emoji/path separators', () => { const f = setup(); try {
    const id = seed(f.store), repo = repository(f.store), b = bundle(repo, id), parent = path.join(f.root, 'exports');
    mkdirSync(parent);
    writeFileSync(path.join(parent, '相同🙂.md'), 'original');
    const result = exportMarkdown(repo, b.workspace.id, 'draft', { draftRevision: 1, mapRevision: 1 }, path.join(parent, '相同🙂.md'));
    assert.equal(path.basename(result.path!), '相同🙂 (2).md');
    assert.equal(readFileSync(path.join(parent, '相同🙂.md'), 'utf8'), 'original');
    assert.equal(exportFilename('中文🙂<>:/\\|?*'), '中文🙂________');
    assert.ok(Buffer.byteLength(exportFilename('中文🙂'.repeat(200)), 'utf8') <= 140);
    assert.ok(!exportFilename('🙂'.repeat(200)).endsWith('\ud83d'));
}
finally {
    f.close();
} });
