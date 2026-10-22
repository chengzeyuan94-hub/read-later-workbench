import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetMetadata } from '../editor-core/model.js';
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function sha256File(file: string): string { const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(file, 'r'); try {
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
}
finally {
    closeSync(fd);
} }
export function boundedFile(root: string, relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => !x || x === '.' || x === '..'))
        throw new Error('本地资源路径无效');
    if(lstatSync(root).isSymbolicLink()||realpathSync(root)!==path.resolve(root))throw new Error('本地资源根目录不能使用符号链接或别名');
    const base = realpathSync(root), candidate = path.resolve(base, relative);
    if (!candidate.startsWith(base + path.sep))
        throw new Error('本地资源超出允许目录');
    let current = base;
    for (const segment of relative.split(/[\\/]/)) {
        current = path.join(current, segment);
        if (lstatSync(current).isSymbolicLink())
            throw new Error('本地资源不能使用符号链接');
    }
    if (realpathSync(candidate) !== candidate || !statSync(candidate).isFile())
        throw new Error('本地资源不可用');
    return candidate;
}
/** Signature only: identifies the container, never proves dimensions or decoded pixels. */
export function imageMimeSignature(bytes:Buffer):'image/png'|'image/jpeg'|'image/webp'{
    if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
    if(bytes.length>=2&&bytes[0]===255&&bytes[1]===216)return'image/jpeg';
    if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'image/webp';
    throw new Error('图片容器签名不受支持');
}
/** E1.1.1 preparation pins exact original bytes before ImageIO determines dimensions/decode validity. */
export function pinOcrOriginal(options:{mediaDir:string;localPath:string;assetsDir:string;workspaceId:string;mediaId:number;mime:string;expectedBytes:number}):AssetMetadata{
    const source=boundedFile(options.mediaDir,options.localPath),bytes=readFileSync(source),mime=imageMimeSignature(bytes);
    if(!bytes.length||bytes.length!==options.expectedBytes||mime!==options.mime.split(';')[0])throw new Error('图片原件字节或容器类型不符');
    const digest=sha256(bytes),extension=mime==='image/jpeg'?'jpg':mime==='image/webp'?'webp':'png',relativePath=`${digest.slice(0,2)}/${digest}.${extension}`;
    mkdirSync(path.join(options.assetsDir,digest.slice(0,2)),{recursive:true,mode:0o700});const target=path.join(options.assetsDir,relativePath);
    if(existsSync(target)){if(sha256(readFileSync(boundedFile(options.assetsDir,relativePath)))!==digest)throw new Error('固定原件摘要冲突');}
    else{const temp=target+`.tmp-${randomUUID()}`;try{writeFileSync(temp,bytes,{flag:'wx',mode:0o600});if(sha256(readFileSync(temp))!==digest)throw new Error('原件固定校验失败');renameSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp);}}
    return{id:`${options.workspaceId}-media-${options.mediaId}`,version:digest,relativePath,mime,sha256:digest};
}
export function imageInfo(bytes: Buffer): {
    mime: string;
    width: number;
    height: number;
    extension: string;
} {
    if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png' };
    if (bytes[0] === 255 && bytes[1] === 216) {
        let p = 2;
        while (p + 8 < bytes.length) {
            if (bytes[p++] !== 255)
                continue;
            const marker = bytes[p++];
            if (marker === 0xd9 || marker === 0xda)
                break;
            const length = bytes.readUInt16BE(p);
            if (length < 2)
                break;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
                return { mime: 'image/jpeg', height: bytes.readUInt16BE(p + 3), width: bytes.readUInt16BE(p + 5), extension: 'jpg' };
            p += length;
        }
    }
    if (bytes.length > 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        const kind = bytes.toString('ascii', 12, 16);
        if (kind === 'VP8X')
            return { mime: 'image/webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1, extension: 'webp' };
        if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a)
            return { mime: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, extension: 'webp' };
        if (kind === 'VP8L' && bytes[20] === 0x2f) {
            const v = bytes.readUInt32LE(21);
            return { mime: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, extension: 'webp' };
        }
    }
    throw new Error('图片类型或尺寸不可识别');
}
export function pinImage(options: {
    mediaDir: string;
    localPath: string;
    assetsDir: string;
    workspaceId: string;
    mediaId: number;
    mime: string;
    expectedBytes: number;
}): {
    asset: AssetMetadata;
    width: number;
    height: number;
    bytes: number;
} {
    const source = boundedFile(options.mediaDir, options.localPath), bytes = readFileSync(source), info = imageInfo(bytes);
    if (!bytes.length || bytes.length !== options.expectedBytes || info.width <= 0 || info.height <= 0 || !['image/png', 'image/jpeg', 'image/webp'].includes(options.mime.split(';')[0]) || info.mime !== options.mime.split(';')[0])
        throw new Error('图片内容、大小或类型不符');
    const digest = sha256(bytes), relativePath = `${digest.slice(0, 2)}/${digest}.${info.extension}`;
    mkdirSync(path.join(options.assetsDir, digest.slice(0, 2)), { recursive: true, mode: 0o700 });
    const target = path.join(options.assetsDir, relativePath);
    if (existsSync(target)) {
        if (sha256(readFileSync(boundedFile(options.assetsDir, relativePath))) !== digest)
            throw new Error('固定资源摘要冲突');
    }
    else {
        const temp = target + `.tmp-${randomUUID()}`;
        try {
            writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
            if (sha256(readFileSync(temp)) !== digest)
                throw new Error('资源写入校验失败');
            renameSync(temp, target);
        }
        finally {
            if (existsSync(temp))
                unlinkSync(temp);
        }
    }
    return { asset: { id: `${options.workspaceId}-media-${options.mediaId}`, version: digest, relativePath, mime: info.mime, sha256: digest }, width: info.width, height: info.height, bytes: bytes.length };
}
export function readFixedAsset(assetsDir: string, asset: AssetMetadata): Buffer { const bytes = readFileSync(boundedFile(assetsDir, asset.relativePath)); if (sha256(bytes) !== asset.sha256 || asset.version !== asset.sha256)
    throw new Error('固定资源缺失或版本摘要不符'); if (imageMimeSignature(bytes) !== asset.mime)
    throw new Error('固定资源类型不符'); return bytes; }
export function fixedAssetResponse(request: Request, assetsDir: string, asset: AssetMetadata | undefined): Response {
    if (!['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 405 });
    if (!asset)
        return new Response('资源不属于当前工作区', { status: 404 });
    try {
        const bytes = readFixedAsset(assetsDir, asset);
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { 'Content-Type': asset.mime, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    catch {
        return new Response('本地图片缺失、损坏或版本不符', { status: 404 });
    }
}
