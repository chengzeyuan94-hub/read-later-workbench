import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AsrCredentials } from '../src/main/asr-credentials.js';
import { CREDENTIAL_PROFILES, readProviderCredential, type CredentialEncryption } from '../src/main/credential-store.js';

// Fake storage: no real keychain, no real userData and no supplied credentials.
const encryption: CredentialEncryption = {
 isEncryptionAvailable: () => true,
 encryptString: value => Buffer.from(`unit-test-cipher:${value}`, 'utf8'),
 decryptString: value => { const text = value.toString('utf8'); if (!text.startsWith('unit-test-cipher:')) throw Error('invalid unit-only cipher'); return text.slice('unit-test-cipher:'.length); },
};
const fixture = () => mkdtempSync(path.join(tmpdir(), 'asr-credentials-unit-'));

test('store persists an encrypted key, reads it back and sets the memory value', () => {
 const root = fixture(), credentials = new AsrCredentials(root, 'siliconflow', [], encryption);
 assert.deepEqual(credentials.store(' sk-unit-pasted '), { configured: true });
 const file = path.join(root, CREDENTIAL_PROFILES.siliconflow.filename);
 assert.equal(encryption.decryptString(readFileSync(file)), 'sk-unit-pasted');
 assert.equal(readProviderCredential(root, 'siliconflow', {}, encryption), 'sk-unit-pasted');
 assert.equal(credentials.read(), 'sk-unit-pasted');
 assert.deepEqual(credentials.status(), { configured: true });
});

test('store writes the deepseek provider to its own file', () => {
 const root = fixture(), credentials = new AsrCredentials(root, 'deepseek', [], encryption);
 credentials.store('sk-deepseek-unit');
 assert.equal(encryption.decryptString(readFileSync(path.join(root, CREDENTIAL_PROFILES.deepseek.filename))), 'sk-deepseek-unit');
 assert.equal(readProviderCredential(root, 'siliconflow', {}, encryption), undefined);
});

test('store rejects empty, newline and overlong keys without writing', () => {
 const root = fixture(), credentials = new AsrCredentials(root, 'siliconflow', [], encryption);
 for (const bad of ['', '   ', 'sk-part\nrest', 'x'.repeat(1025)]) assert.throws(() => credentials.store(bad), /未保存|不正确|为空/);
 assert.equal(readProviderCredential(root, 'siliconflow', {}, encryption), undefined);
 assert.deepEqual(credentials.status(), { configured: false });
});
