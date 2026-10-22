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
 const { build } = await import('esbuild');
 // Bundle only in memory. Both native services are replaced; real provider env
 // values are compiled out before this module can execute.
 const bundled = await build({
  stdin: { contents: "export {AsrCredentials} from './asr-credentials.ts'; export {fixture} from 'node:child_process';", resolveDir: path.resolve('src/main'), sourcefile: 'credential-constructor-unit.ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  define: { 'process.env': '{}', 'process.platform': '"darwin"' },
  plugins: [{ name: 'only-unit-native-services', setup(plugin) {
   plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'credential-unit' }));
   plugin.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'spawn', namespace: 'credential-unit' }));
   plugin.onLoad({ filter: /.*/, namespace: 'credential-unit' }, args => ({ contents: args.path === 'electron'
    ? `export const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('unit-test-cipher:'+value),decryptString:value=>value.toString('utf8').slice('unit-test-cipher:'.length)};`
    : `import {EventEmitter} from 'node:events';export const fixture={calls:[],responses:[]};export function spawn(command,args,options){fixture.calls.push({command,args,options});const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{queueMicrotask(()=>child.emit('close',1));return true;};const text=fixture.responses.shift();queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(text+'\\n'));child.emit('close',0);});return child;}`,
   }));
  } }],
 });
 const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
 const root = fixture(), legacy = new module.AsrCredentials(root), deepseek = new module.AsrCredentials(root, 'deepseek');
 assert.deepEqual(legacy.status(), { configured: false }); assert.deepEqual(deepseek.status(), { configured: false });
 module.fixture.responses.push('unit-native-sf'); assert.deepEqual(await legacy.configure(), { configured: true });
 assert.equal(legacy.read(), 'unit-native-sf'); assert.equal(deepseek.read(), undefined);
 module.fixture.responses.push('unit-native-ds'); assert.deepEqual(await deepseek.configure(), { configured: true });
 assert.equal(legacy.read(), 'unit-native-sf'); assert.equal(deepseek.read(), 'unit-native-ds');
 assert.match(module.fixture.calls[0].args[1], /SiliconFlow 音视频转录/); assert.match(module.fixture.calls[1].args[1], /官方 DeepSeek 文字生成/);
 for (const call of module.fixture.calls) { assert.equal(call.command, '/usr/bin/osascript'); assert.match(call.args[1], /with hidden answer/); assert.doesNotMatch(call.args[1], /unit-native-/); assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'ignore']); }
 legacy.dispose(); deepseek.dispose(); assert.equal(legacy.read(), undefined); assert.equal(deepseek.read(), undefined);
 const calls = module.fixture.calls.length; assert.deepEqual(await deepseek.configure(), { configured: false }); assert.equal(module.fixture.calls.length, calls);
});
