/** Main-process credential profiles. Callers never expose credential bytes over IPC. */
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type CredentialProvider = 'siliconflow' | 'deepseek';
export const CREDENTIAL_PROFILES = Object.freeze({
  siliconflow: { environment: 'SILICONFLOW_API_KEY', filename: 'siliconflow-key.encrypted', label: 'SiliconFlow 音视频转录', purpose: '仅用于硅基流动音视频转录' },
  deepseek: { environment: 'DEEPSEEK_API_KEY', filename: 'deepseek-key.encrypted', label: '官方 DeepSeek 文字生成', purpose: '仅用于官方 DeepSeek 正文与导图生成' },
});
export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  decryptString(value: Buffer): string;
  encryptString(value: string): Buffer;
}
function valid(value: string | undefined): value is string { return !!value && value.length <= 1024 && !/[\r\n]/.test(value); }
export function readProviderCredential(userDataDir: string, provider: CredentialProvider, environment: Readonly<Record<string, string | undefined>>, encryption: CredentialEncryption, memory?: string): string | undefined {
  if (valid(memory)) return memory;
  const profile = CREDENTIAL_PROFILES[provider], configured = environment[profile.environment]?.trim();
  if (valid(configured)) return configured;
  const file = path.join(userDataDir, profile.filename);
  if (!existsSync(file) || !encryption.isEncryptionAvailable()) return;
  try {
    const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) return;
    const key = encryption.decryptString(readFileSync(file)); if (valid(key)) return key;
  } catch { /* No credential bytes, filesystem path, or keychain diagnostics leave here. */ }
}
export function storeProviderCredential(userDataDir: string, provider: CredentialProvider, key: string, encryption: CredentialEncryption): void {
  if (!valid(key)) throw Error('密钥格式不正确，未保存');
  if (!encryption.isEncryptionAvailable()) throw Error('安全凭据存储不可用，现有配置保持');
  const encrypted = encryption.encryptString(key), file = path.join(userDataDir, CREDENTIAL_PROFILES[provider].filename), temporary = file + '.tmp-' + randomUUID();
  writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 });
  const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}
