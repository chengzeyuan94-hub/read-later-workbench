import type { DigestFreezeError } from '../shared/digest-contracts.js';

export type FreezeOperation = 'read-original' | 'copy-original' | 'read-header' | 'pin-attachment';

/** Classify the failed operation before interpreting an image header. Never expose OS paths. */
export function classifyFreezeError(error: unknown, operation: FreezeOperation): DigestFreezeError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const systemCode = typeof errno === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(errno) ? errno : undefined;
  const reason = errno === 'ENOSPC' || errno === 'EDQUOT'
    ? { code: 'disk-full', message: '本地存储空间或配额不足，未能固定资料；请释放空间后按当前资料重新消化' }
    : errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS'
      ? { code: 'permission-denied', message: '本地资料或附件目录无法读取或写入；请恢复目录权限后按当前资料重新消化' }
      : errno === 'ENOENT'
        ? { code: 'missing-file', message: '本地原件或所需目录缺失，未能固定资料；请恢复文件和目录后按当前资料重新消化' }
        : errno === 'RLW_CHANGED'
          ? { code: 'input-mismatch', message: '本地原件字节或大小已变化，请按当前资料重新消化' }
          // A filesystem error at the header/asset boundary is never evidence of bad pixels or EXIF.
          : systemCode
            ? { code: 'file-unavailable', message: '本地资料读取或附件保存失败；请检查目录、存储设备和权限后按当前资料重新消化' }
            : operation === 'read-header'
              ? { code: 'metadata-incompatible', message: '本地原件存在，但图片头元数据尚不兼容；请勿反复下载相同文件，可按当前资料重新消化' }
              : { code: 'file-unavailable', message: '无法安全读取或固定本地资料；请检查文件与附件目录后按当前资料重新消化' };
  return { ...reason, operation, ...(systemCode ? { systemCode } : {}), recovery: 'new-request' };
}
