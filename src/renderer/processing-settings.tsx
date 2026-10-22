import React, { useEffect, useRef, useState } from 'react';
import type { ProcessingConfiguration, ProcessingUsage } from '../shared/contracts.js';
import type { AsrAPI } from '../shared/asr-contracts.js';
import type { GenerationAPI } from '../shared/generation-contracts.js';
function CredentialRow({ title, configured, testid, save, busy, run, focus }: {
 title: string; configured: boolean | undefined; testid: string;
 save?: (key: string) => Promise<{ configured: boolean }>; busy: boolean;
 run(label: string, action: () => Promise<void>): Promise<void>; focus?: boolean;
}) {
 const [value, setValue] = useState(''), [visible, setVisible] = useState(false), [note, setNote] = useState<'已保存' | string | null>(null);
 const input = useRef<HTMLInputElement>(null), focused = useRef(false);
 useEffect(() => { if (focus && !focused.current) { focused.current = true; input.current?.scrollIntoView({ block: 'center' }); input.current?.focus(); } }, [focus]);
 const submit = () => {
  if (!save) return;
  void run(`保存${title}`, async () => {
   try { const result = await save(value); setNote(result.configured ? '已保存' : '未保存'); if (result.configured) setValue(''); }
   catch (error) { setNote(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '保存未完成，请重试'); }
  });
 };
 return <div className="setting-row credential-row">
  <div><b>{title}</b><p><span className={`chip ${configured ? 'ok' : ''}`} data-testid={`${testid}-status`}>{configured === undefined ? '读取中' : configured ? '已配置' : '未配置'}</span></p></div>
  <div className="credential-field">
   <input ref={input} type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} className="key-input" placeholder="粘贴 sk- 开头的密钥" aria-label={`${title}密钥`} value={value} disabled={busy || !save} onChange={event => { setValue(event.target.value); setNote(null); }} />
   <button className="text-button" type="button" onClick={() => setVisible(!visible)}>{visible ? '隐藏' : '显示'}</button>
   <button className="btn" data-testid={testid} disabled={busy || !save || !value.trim()} onClick={submit}>保存</button>
   <small className="credential-note">{note ?? (value ? `已输入 ${value.length} 个字符` : '')}</small>
  </div>
 </div>;
}
export function usageLine(usage: ProcessingUsage, scope: 'month' | 'total'): string {
  const u = scope === 'month' ? usage.month : usage.total;
  return `转录 ${u.asrMinutes.toFixed(1)} 分钟（${u.asrCount} 条）· 整理 ${u.generationCount} 次`;
}
export function ProcessingSettings({ asr, generation, configuration, usage, busy, run, focus }: {
 asr?: AsrAPI; generation?: GenerationAPI; configuration?: ProcessingConfiguration; usage?: ProcessingUsage; busy: boolean;
 run(label: string, action: () => Promise<void>): Promise<void>; focus?: 'asr' | 'generation' | null;
}) {
 if (!asr && !generation) return null;
 const allowed = configuration?.asrNetworkAllowed ?? configuration?.generationNetworkAllowed;
 return <>
  {usage && <div className="setting-row" data-testid="processing-usage"><div><b>用量</b><p>本月用量：{usageLine(usage, 'month')}　累计：{usageLine(usage, 'total')}</p><p>只显示用量，不设上限。</p></div></div>}
  {asr && <CredentialRow title="语音转文字 · 硅基流动" configured={configuration?.asrConfigured} testid="asr-configure" save={asr.setCredential?.bind(asr)} busy={busy} run={run} focus={focus === 'asr'} />}
  {generation && <CredentialRow title="整理与导图 · DeepSeek" configured={configuration?.generationConfigured} testid="generation-configure" save={generation.setCredential?.bind(generation)} busy={busy} run={run} focus={focus === 'generation'} />}
  {asr?.setNetworkAllowed && <div className="setting-row"><div><b>允许 AI 处理联网</b><p>{generation ? '同时控制转录和生成的外部处理联网，配置状态分别保留。' : '控制转录联网，配置状态保留。'}平台同步与此开关分别控制。</p></div><button role="switch" aria-checked={!!allowed} aria-label="允许 AI 处理联网" data-testid={allowed ? 'processing-network-pause' : 'processing-network-resume'} className={`switch ${allowed ? 'on' : ''}`} disabled={busy} onClick={() => void run(allowed ? '暂停处理联网' : '恢复处理联网', async () => { await asr.setNetworkAllowed?.(!allowed); })}><span/></button></div>}
 </>;
}
/** 开发者信息开启后才渲染的处理端点细节，归入设置→高级。 */
export function ProcessingEndpoints({ asr, generation }: { asr?: AsrAPI; generation?: GenerationAPI }) {
 if (!asr && !generation) return null;
 return <div className="setting-row"><div><b>处理端点</b>{asr && <p>实际端点：<code>https://api.siliconflow.cn/v1/audio/transcriptions</code></p>}{generation && <p>实际端点：<code>https://api.deepseek.com/models</code>、<code>https://api.deepseek.com/chat/completions</code></p>}<p>新请求按当前策略核验模型；已有请求保留原供应商与模型身份。</p></div></div>;
}
