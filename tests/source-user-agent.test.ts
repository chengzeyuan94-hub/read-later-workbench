import assert from 'node:assert/strict';
import test from 'node:test';
import { synchronizeSourceUserAgent } from '../src/main/source-user-agent.js';

test('media session uses the existing consumer-page UA without replacing browser, OS, URLs or credential state', () => {
  const previous = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 read-later-workbench/0.1.0 Chrome/152.0.0.0 Electron/44.8.0 Safari/537.36';
  let current = previous; let writes = 0;
  const consumerWindowUA = previous.replace(/\sElectron\/\S+/g, '').replace(/\sread-later-workbench\/\S+/g, '');
  const sourceSession = { getUserAgent: () => current, setUserAgent: (value: string) => { current = value; writes++; },
    get cookies(): never { throw Error('must not access cookies'); }, fetch(): never { throw Error('must not fetch'); } };
  assert.equal(synchronizeSourceUserAgent(sourceSession), consumerWindowUA);
  assert.equal(current, consumerWindowUA); assert.equal(writes, 1);
  assert.equal(synchronizeSourceUserAgent(sourceSession), consumerWindowUA); assert.equal(writes, 1, 'unchanged session is not mutated again');
  assert.match(current, /Chrome\/152\.0\.0\.0/); assert.match(current, /Mac OS X 10_15_7/); assert.match(current, /Safari\/537\.36/);
});
