/** Main-process credential profiles. Callers never expose credential bytes over IPC. */
import { existsSync, lstatSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { renameSyncRetry } from './fs-paths.js';
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
  /** Electron safeStorage backend ('basic_text' means Linux has no keychain). */
  getSelectedStorageBackend?(): string;
}
function valid(value: string | undefined): value is string { return !!value && value.length <= 1024 && !/[\r\n]/.test(value); }
/** Returns the refusal reason, or undefined when secure storage can hold a key. */
export function credentialStorageUnavailable(encryption: CredentialEncryption, provider: CredentialProvider): string | undefined {
  const profile = CREDENTIAL_PROFILES[provider];
  if (!encryption.isEncryptionAvailable()) return `安全凭据存储不可用；请通过主进程环境配置 ${profile.environment}`;
  if (encryption.getSelectedStorageBackend?.() === 'basic_text') return `未检测到系统钥匙串（如 GNOME Keyring / KWallet），无法安全保存密钥；也可通过环境变量 ${profile.environment} 配置`;
}
export function assertCredentialStorage(encryption: CredentialEncryption, provider: CredentialProvider): void {
  const reason = credentialStorageUnavailable(encryption, provider);
  if (reason) throw Error(reason);
}
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
  renameSyncRetry(temporary, file);
}
