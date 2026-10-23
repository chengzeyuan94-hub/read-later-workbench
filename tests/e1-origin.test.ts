import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { isRendererFile } from '../src/main/renderer-origin.js';
test('renderer origin accepts only the exact application file while permitting its view query', () => {
  const file = process.platform === 'win32' ? 'C:\\synthetic\\含 空格\\renderer\\index.html' : '/synthetic/含 空格/renderer/index.html', url = pathToFileURL(file).href;
  assert.equal(isRendererFile(url + '?view=library#read', file), true);
  for (const wrong of [url + '.other', url + '/nested', 'https://example.invalid/index.html', 'javascript:void(0)', 'file://other-host/index.html', 'invalid']) assert.equal(isRendererFile(wrong, file), false);
});
