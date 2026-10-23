import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { renameSyncRetry, safeFilename } from './fs-paths.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDraftAssetRefs, plainText, pointSlice, referenceDescription, transcriptTimeDescription, serializeDraftMarkdown, markdownRuns, type AssetRef, type DraftBlock, type TextRun, type SourceReference } from '../editor-core/model.js';
import type { EditorExportKind, EditorExportResult } from '../shared/editor-contracts.js';
import { readFixedAsset, sha256 } from './editor-media.js';
import type { EditorRepository } from './editor-store.js';
export function exportFilename(title: string): string { const clean = title.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, ''); let result = ''; for (const char of clean) {
    if (Buffer.byteLength(result + char, 'utf8') > 140)
        break;
    result += char;
} return safeFilename(result, '整理稿'); }
const escape = (text: string) => text.replace(/([\\`*_\[\]<>])/g, '\\$1');
/** Freeze and validate saved versions before opening/publishing any external target. */
export function prepareMarkdown(repository: EditorRepository, workspaceId: string, kind: EditorExportKind, expected: {
    draftRevision: number;
    mapRevision: number;
}) {
    if (!['draft', 'map', 'both'].includes(kind))
        throw new Error('导出范围无效');
    const loaded = repository.load(workspaceId), bundle = loaded.bundle;
    if (bundle.draft.revision !== expected.draftRevision || bundle.map.revision !== expected.mapRevision)
        throw new Error('保存版本已变化，请重新保存后导出');
    const refs: AssetRef[] = [];
    // Generated citations belong to one exact saved structured draft. A later
    // human revision must never inherit their semantic claim implicitly.
    const generationEnabled=Number(repository.db.pragma('user_version',{simple:true}))>=9;
    const bodySidecar=generationEnabled&&kind!=='map'?repository.db.prepare('SELECT json FROM generation_body_refs WHERE workspace_id=? AND draft_revision=? AND draft_sha=?').get(workspaceId,bundle.draft.revision,sha256(JSON.stringify(bundle.draft))) as {json:string}|undefined:undefined;
    const bodyReferences=bodySidecar?JSON.parse(bodySidecar.json) as Record<string,SourceReference[]>:{};
    for(const references of Object.values(bodyReferences))for(const ref of references)refs.push(...repository.resolve(workspaceId,ref).assets);
    if (kind !== 'map')
        refs.push(...getDraftAssetRefs(bundle.draft.blocks));
    if (kind !== 'draft')
        for (const node of Object.values(bundle.map.nodes)) {
            if (node.image)
                refs.push(node.image);
            for (const ref of node.sourceRefs)
                refs.push(...repository.resolve(workspaceId, ref).assets);
        }
    const assets = new Map<string, {
        name: string;
        bytes: Buffer;
        sha: string;
    }>(), names = new Map<string, string>();
    for (const ref of refs) {
        const key = ref.assetId + '@' + ref.version;
        if (names.has(key))
            continue;
        const asset = repository.asset(workspaceId, ref);
        if (!asset)
            throw new Error('导出需要的图片版本不存在');
        const bytes = readFixedAsset(repository.assetsDir, asset), extension = asset.mime === 'image/jpeg' ? 'jpg' : asset.mime === 'image/webp' ? 'webp' : 'png', name = `${asset.sha256}.${extension}`;
        assets.set(name, { name, bytes, sha: asset.sha256 });
        names.set(key, `assets/${name}`);
    }
    const assetPath = (a: AssetRef) => { const name = names.get(a.assetId + '@' + a.version); if (!name)
        throw new Error('导出图片引用未包含'); return name; };
    // References retain every exact source identity. Only repeated visual copies
    // are reduced; distinct assets with identical bytes share the same attachment.
    const bodyImages = new Set(kind === 'map' ? [] : getDraftAssetRefs(bundle.draft.blocks).map(assetPath));
    const mapImages = new Set(kind === 'draft' ? [] : Object.values(bundle.map.nodes).flatMap(node => node.image ? [assetPath(node.image)] : []));
    const citedImages = new Set<string>();
    const sourceImage = (asset: AssetRef, indent: string, label: string) => {
        const relative = assetPath(asset);
        if (bodyImages.has(relative))
            return `${indent}[来源图片已在正文展示](${relative})\n`;
        if (mapImages.has(relative))
            return `${indent}[来源图片已在导图展示](${relative})\n`;
        if (citedImages.has(relative))
            return `${indent}[同一来源图片，见前一出处](${relative})\n`;
        citedImages.add(relative);
        return `${indent}![${label}](${relative})\n`;
    };
    let markdown = `# ${escape(bundle.workspace.userTitle)}\n\n`;
    if (kind !== 'map')
        markdown += serializeDraftMarkdown(bundle.draft.blocks, { assetPath }) + '\n';
    if(kind!=='map'&&bodySidecar){
        markdown+='\n来源说明：正文依据所选固定资料整理，详细版本与定位可展开核对。\n\n<details>\n<summary>正文出处（精确版本、区域与摘录）</summary>\n\n## 正文出处\n\n'+`以下出处绑定正文版本 ${bundle.draft.revision}，不是逐句转录时间。\n`;
        for(const[blockId,references]of Object.entries(bodyReferences)){
            if(!references.length)continue;
            markdown+=`\n正文块 ${escape(blockId)} 的来源：\n`;
            for(const ref of references){
                const resolved=repository.resolve(workspaceId,ref),descriptive=structuredClone(ref);
                if(descriptive.range){delete descriptive.range.excerpt;delete descriptive.range.before;delete descriptive.range.after;}
                markdown+='\n- '+escape(referenceDescription(descriptive))+'\n';
                if(resolved.ocr)markdown+='  原图媒体 '+resolved.ocr.mediaId+' / 原件版本 '+escape(resolved.ocr.asset.version)+' / 行级区域 '+resolved.ocr.regions.map(region=>`${region.bounds.x.toFixed(4)},${region.bounds.y.toFixed(4)},${region.bounds.width.toFixed(4)},${region.bounds.height.toFixed(4)}`).join('；')+'（方向归一化左上角坐标）\n';
                if(resolved.transcript)markdown+='  '+escape(transcriptTimeDescription(resolved.transcript))+'\n';
                const excerpt=pointSlice(resolved.selectedText,0,240);
                if(excerpt)markdown+='  摘录：'+escape(excerpt)+(Array.from(resolved.selectedText).length>240?'…':'')+'\n';
                for(const asset of resolved.assets)markdown+=sourceImage(asset,'  ','来源图片');
            }
        }
        markdown+='\n</details>\n';
    }else if(kind!=='map'&&generationEnabled){markdown+='\n本正文版本含人工保存；历史生成出处仅属于原生成版本，不冒称当前人工文字已经过自动来源核验。\n';}
    if (kind === 'both')
        markdown += '\n## 导图大纲\n\n';
    if (kind !== 'draft') {
        const walk = (nodeId: string, depth: number) => { const node = bundle.map.nodes[nodeId]; markdown += '  '.repeat(depth) + '- ' + markdownRuns(node.title).replace(/\n/g, '\n' + '  '.repeat(depth + 1)) + '\n'; if (node.notes)
            markdown += '  '.repeat(depth + 1) + '> ' + escape(node.notes).replace(/\n/g, '\n' + '  '.repeat(depth + 1) + '> ') + '\n'; if (node.image)
            markdown += '  '.repeat(depth + 1) + `![节点图片](${assetPath(node.image)})\n`; for (const ref of node.sourceRefs) {
            const resolved = repository.resolve(workspaceId, ref);
            markdown += '\n' + '  '.repeat(depth + 1) + '> ' + escape(referenceDescription(ref, bundle)).replace(/\n/g, '\n' + '  '.repeat(depth + 1) + '> ') + '\n';
            if(resolved.ocr){
                const label=resolved.ocr.manual?'人工补充（没有可声明的原图文字区域）':`原图行级区域 ${resolved.ocr.regions.map(region=>`${region.bounds.x.toFixed(4)},${region.bounds.y.toFixed(4)},${region.bounds.width.toFixed(4)},${region.bounds.height.toFixed(4)}`).join('；')}（方向归一化后左上角坐标；非字级定位）`;
                markdown+='  '.repeat(depth+1)+'> '+escape(label)+'\n';
            }
            if (resolved.selectedText)
                markdown += '  '.repeat(depth + 1) + '> 摘录：' + escape(resolved.selectedText).replace(/\n/g, '\n' + '  '.repeat(depth + 1) + '> ') + '\n';
            for (const a of resolved.assets)
                markdown += sourceImage(a, '  '.repeat(depth + 1), '引用图片');
        } for (const child of node.children)
            walk(child, depth + 1); };
        walk(bundle.map.rootId, 0);
    }
    const links = [...new Set(bundle.sources.map(s => s.originalUrl))];
    markdown += '\n---\n\n来源：' + (links.length ? links.map(x => `[原收藏](${x})`).join('、') : '原资料尚未取得') + '\n\n音视频文件未包含。本文件是当前所选已保存版本的阅读投影，不是完整工程备份；不包含完整历史或画布视图。\n';
    if (/(?:rlw-media|rlw-editor|file):\/\//i.test(markdown) || /!\[[^\]]*\]\((?:https?:|\/)/i.test(markdown))
        throw new Error('导出不能依赖私有协议或远程图片');
    return { bundle, markdown, assets };
}

/** Synchronous compatibility path for existing managed internal projections. */
export function exportMarkdown(repository: EditorRepository, workspaceId: string, kind: EditorExportKind, expected: {draftRevision:number;mapRevision:number}, chosenPath:string, options:{failAt?:'after-write'|'before-publish'}={}):EditorExportResult {
    if (!path.isAbsolute(chosenPath) || chosenPath !== path.normalize(chosenPath)) throw new Error('导出位置无效');
    const {bundle,markdown,assets}=prepareMarkdown(repository,workspaceId,kind,expected);
    const parent = path.dirname(chosenPath);
    if (!existsSync(parent) || realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink())
        throw new Error('导出父目录不存在或使用别名');
    const hasImages = assets.size > 0, selectedBase = path.basename(chosenPath).replace(/\.md$/i, ''), base = exportFilename(selectedBase || bundle.workspace.userTitle);
    const temp = mkdtempSync(path.join(parent, '.rlw-export-'));
    let target: string | undefined;
    try {
        if (hasImages)
            mkdirSync(path.join(temp, 'assets'));
        writeFileSync(path.join(temp, `${base}.md`), markdown, { flag: 'wx', mode: 0o600 });
        for (const a of assets.values())
            writeFileSync(path.join(temp, 'assets', a.name), a.bytes, { flag: 'wx', mode: 0o600 });
        if (options.failAt === 'after-write')
            throw new Error('injected export failure');
        for (const a of assets.values())
            if (sha256(readFileSync(path.join(temp, 'assets', a.name))) !== a.sha)
                throw new Error('导出附件校验失败');
        if (readFileSync(path.join(temp, `${base}.md`), 'utf8') !== markdown)
            throw new Error('导出正文校验失败');
        if (options.failAt === 'before-publish')
            throw new Error('injected export failure');
        if (hasImages) {
            target = path.join(parent, `${base}-${randomUUID()}`);
            while (existsSync(target))
                target = path.join(parent, `${base}-${randomUUID()}`);
            renameSyncRetry(temp, target);
        }
        else {
            let n = 1;
            target = path.join(parent, `${base}.md`);
            for (;;) {
                try {
                    linkSync(path.join(temp, `${base}.md`), target);
                    break;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                        throw error;
                    target = path.join(parent, `${base} (${++n}).md`);
                }
            }
        }
        return { status: 'exported', path: target, files: 1 + assets.size, draftRevision: bundle.draft.revision, mapRevision: bundle.map.revision };
    }
    finally {
        if (existsSync(temp))
            rmSync(temp, { recursive: true, force: true });
    }
}
