import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CREDENTIAL_PROFILES, readProviderCredential, storeProviderCredential, type CredentialEncryption } from '../src/main/credential-store.js';

// Deliberately fake storage and fake environment: no real userData, OS keychain,
// provider environment values or supplied credentials are read by these tests.
const encryption: CredentialEncryption = {
 isEncryptionAvailable: () => true,
 encryptString: value => Buffer.from(`unit-test-cipher:${value}`, 'utf8'),
 decryptString: value => { const text = value.toString('utf8'); if (!text.startsWith('unit-test-cipher:')) throw Error('invalid unit-only cipher'); return text.slice('unit-test-cipher:'.length); },
};
const fixture = () => mkdtempSync(path.join(tmpdir(), 'provider-credentials-unit-'));

test('provider credentials read only their own environment value with no cross-service fallback', () => {
 const root = fixture(), both = { SILICONFLOW_API_KEY: 'unit-sf-only', DEEPSEEK_API_KEY: 'unit-ds-only' };
 assert.equal(readProviderCredential(root, 'siliconflow', both, encryption), 'unit-sf-only');
 assert.equal(readProviderCredential(root, 'deepseek', both, encryption), 'unit-ds-only');
 assert.equal(readProviderCredential(root, 'deepseek', { SILICONFLOW_API_KEY: 'unit-sf-only' }, encryption), undefined);
 assert.equal(readProviderCredential(root, 'siliconflow', { DEEPSEEK_API_KEY: 'unit-ds-only' }, encryption), undefined);
});

test('encrypted provider files are independent and retain the legacy SiliconFlow location', () => {
 const root = fixture();
 assert.equal(CREDENTIAL_PROFILES.siliconflow.filename, 'siliconflow-key.encrypted');
 assert.equal(CREDENTIAL_PROFILES.deepseek.filename, 'deepseek-key.encrypted');
 storeProviderCredential(root, 'siliconflow', 'unit-sf-first', encryption);
 const sf = path.join(root, CREDENTIAL_PROFILES.siliconflow.filename), before = readFileSync(sf);
 assert.equal(readProviderCredential(root, 'deepseek', {}, encryption), undefined);
 storeProviderCredential(root, 'deepseek', 'unit-ds-first', encryption);
 assert.deepEqual(readFileSync(sf), before);
 assert.equal(readProviderCredential(root, 'siliconflow', {}, encryption), 'unit-sf-first');
 assert.equal(readProviderCredential(root, 'deepseek', {}, encryption), 'unit-ds-first');
 storeProviderCredential(root, 'deepseek', 'unit-ds-second', encryption);
 assert.deepEqual(readFileSync(sf), before);
 assert.equal(readProviderCredential(root, 'deepseek', {}, encryption), 'unit-ds-second');
 for (const profile of Object.values(CREDENTIAL_PROFILES)) assert.equal(statSync(path.join(root, profile.filename)).mode & 0o777, 0o600);
});

test('invalid, damaged, symlinked and unavailable provider credentials do not expose or borrow another key', () => {
 const root = fixture(); storeProviderCredential(root, 'siliconflow', 'unit-sf-healthy', encryption);
 const ds = path.join(root, CREDENTIAL_PROFILES.deepseek.filename);
 writeFileSync(ds, 'deliberately invalid unit cipher');
 assert.equal(readProviderCredential(root, 'deepseek', {}, encryption), undefined);
 assert.equal(readProviderCredential(root, 'deepseek', { DEEPSEEK_API_KEY: 'invalid\nunit' }, encryption), undefined);
 assert.equal(readProviderCredential(root, 'siliconflow', {}, { ...encryption, isEncryptionAvailable: () => false }), undefined);
 assert.throws(() => storeProviderCredential(root, 'deepseek', 'invalid\nunit', encryption), /格式/);
 assert.equal(readProviderCredential(root, 'siliconflow', {}, encryption), 'unit-sf-healthy');
 const other = fixture(); symlinkSync(path.join(root, CREDENTIAL_PROFILES.siliconflow.filename), path.join(other, CREDENTIAL_PROFILES.deepseek.filename));
 assert.equal(readProviderCredential(other, 'deepseek', {}, encryption), undefined);
});

test('the legacy credentials constructor and DeepSeek native configuration remain isolated and return booleans only', async () => {
 // Injected fake storage keeps this on one code path with no real userData,
 // OS keychain, provider environment values or supplied credentials.
 const { AsrCredentials } = await import('../src/main/asr-credentials.js');
 const root = fixture(), legacy = new AsrCredentials(root, 'siliconflow', [], encryption), deepseek = new AsrCredentials(root, 'deepseek', [], encryption);
 assert.deepEqual(legacy.status(), { configured: false }); assert.deepEqual(deepseek.status(), { configured: false });
 const opened: string[] = [];
 legacy.setRequestHandler(request => { opened.push(`${request.provider}:${request.label}`); });
 deepseek.setRequestHandler(request => { opened.push(`${request.provider}:${request.label}`); });
 const legacyPrompt = legacy.configure();
 assert.match(opened[0], /^siliconflow:.*SiliconFlow 音视频转录/);
 assert.deepEqual(legacy.store('unit-native-sf'), { configured: true });
 assert.deepEqual(await legacyPrompt, { configured: true });
 assert.equal(legacy.read(), 'unit-native-sf'); assert.equal(deepseek.read(), undefined);
 const deepseekPrompt = deepseek.configure();
 assert.match(opened[1], /^deepseek:.*官方 DeepSeek 文字生成/);
 assert.deepEqual(deepseek.store('unit-native-ds'), { configured: true });
 assert.deepEqual(await deepseekPrompt, { configured: true });
 assert.equal(legacy.read(), 'unit-native-sf'); assert.equal(deepseek.read(), 'unit-native-ds');
 legacy.dispose(); deepseek.dispose(); assert.equal(legacy.read(), undefined); assert.equal(deepseek.read(), undefined);
 const calls = opened.length; assert.deepEqual(await deepseek.configure(), { configured: false }); assert.equal(opened.length, calls);
});

test('the in-app credential entry refuses Linux basic_text storage and never echoes a key', async () => {
 const { AsrCredentials } = await import('../src/main/asr-credentials.js');
 const { credentialStorageUnavailable } = await import('../src/main/credential-store.js');
 const basic: CredentialEncryption = { ...encryption, getSelectedStorageBackend: () => 'basic_text' };
 assert.match(credentialStorageUnavailable(basic, 'deepseek')!, /GNOME Keyring|KWallet/);
 assert.match(credentialStorageUnavailable(basic, 'siliconflow')!, /SILICONFLOW_API_KEY/);
 assert.equal(credentialStorageUnavailable(encryption, 'deepseek'), undefined);
 const root = fixture(), credentials = new AsrCredentials(root, 'deepseek', [], basic);
 let requests = 0; credentials.setRequestHandler(() => { requests += 1; });
 assert.throws(() => credentials.configure(), /GNOME Keyring|KWallet/);
 assert.equal(requests, 0); // The refusal happens before any prompt can open.
 assert.throws(() => credentials.store('unit-basic-key'), /GNOME Keyring|KWallet/);
 assert.equal(credentials.read(), undefined);
 // A cancelled prompt resolves without a key and without another request.
 const secure = new AsrCredentials(fixture(), 'deepseek', [], encryption);
 const prompt = secure.configure(); secure.cancelConfigure();
 assert.deepEqual(await prompt, { configured: false });
});
