import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProcessingSettings, ProcessingEndpoints } from '../src/renderer/processing-settings.js';
import type { AsrAPI } from '../src/shared/asr-contracts.js';
import type { GenerationAPI } from '../src/shared/generation-contracts.js';

const asr = { configureCredentials: async () => ({ configured: true }), setCredential: async (_key: string) => ({ configured: true }), setNetworkAllowed: async (allowed: boolean) => ({ allowed }) } as AsrAPI;
const generation = { configureCredentials: async () => ({ configured: true }), setCredential: async (_key: string) => ({ configured: true }) } as GenerationAPI;
const run = async (_label: string, action: () => Promise<void>) => { await action(); };
test('settings name both providers with paste-friendly key fields and keep the single network switch', () => {
 const html = renderToStaticMarkup(React.createElement(ProcessingSettings, { asr, generation, configuration: { asrConfigured: true, asrNetworkAllowed: false, generationConfigured: false, generationNetworkAllowed: false }, busy: false, run }));
 assert.match(html, /data-testid="asr-configure"/); assert.match(html, /data-testid="generation-configure"/);
 assert.match(html, /data-testid="asr-configure-status">已配置/); assert.match(html, /data-testid="generation-configure-status">未配置/);
 assert.match(html, /硅基流动/); assert.match(html, /DeepSeek/);
 assert.equal((html.match(/type="password"/g) || []).length, 2);
 assert.match(html, /粘贴 sk- 开头的密钥/); assert.match(html, />保存</); assert.match(html, />显示</);
 assert.match(html, /data-testid="processing-network-resume"/); assert.match(html, /允许 AI 处理联网/);
});
test('key inputs disable save while empty and show the typed-character hint placeholder', () => {
 const html = renderToStaticMarkup(React.createElement(ProcessingSettings, { asr, configuration: { asrConfigured: false, asrNetworkAllowed: true }, busy: false, run }));
 assert.match(html, /data-testid="asr-configure"[^>]*disabled/);
 assert.doesNotMatch(html, /data-testid="generation-configure"|DeepSeek/);
 assert.match(html, /credential-note/); assert.match(html, /转录联网：允许|允许 AI 处理联网/); assert.match(html, /data-testid="processing-network-pause"/);
});
test('endpoints stay reachable through the advanced ProcessingEndpoints surface', () => {
 const html = renderToStaticMarkup(React.createElement(ProcessingEndpoints, { asr, generation }));
 assert.match(html, /api\.siliconflow\.cn\/v1\/audio\/transcriptions/);
 assert.match(html, /api\.deepseek\.com\/models/); assert.match(html, /api\.deepseek\.com\/chat\/completions/);
});
