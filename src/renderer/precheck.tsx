import React, { useEffect, useRef, useState } from 'react';
import type { ProcessingConfiguration, ProcessingUsage } from '../shared/contracts';
import { precheckMissing, type PrecheckMissing } from './ui-terms';
import { usageLine } from './processing-settings';

export interface PrecheckAPI {
 setNetworkAllowed?(allowed: boolean): Promise<unknown>;
 configureAsr?(): Promise<unknown>;
 configureGeneration?(): Promise<unknown>;
}
/** E4.3 §9a: lists what blocks a new digest request; fixes in place, then 开始消化. */
export function PrecheckDialog({ config, usage, needsAsr, api, busy, onStart, onCancel, onOpenSettings }: { config: ProcessingConfiguration | undefined; usage?: ProcessingUsage; needsAsr: boolean; api: PrecheckAPI; busy: boolean; onStart(): void; onCancel(): void; onOpenSettings?(kind: 'asr' | 'generation'): void }) {
 const dialog = useRef<HTMLDialogElement>(null);
 const [working, setWorking] = useState(false), [error, setError] = useState('');
 useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); }; }, []);
 const missing: PrecheckMissing | null = precheckMissing(config, needsAsr);
 const fix = async (fn?: () => Promise<unknown>) => {
  if (!fn) return; setWorking(true); setError('');
  try { await fn(); } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作未完成，请重试'); }
  finally { setWorking(false); }
 };
 const rows: { key: keyof PrecheckMissing; label: string; fixLabel: string; apply?: () => Promise<unknown> }[] = [
  { key: 'generationConfigured', label: '尚未配置整理密钥', fixLabel: '去设置填写', apply: onOpenSettings ? async () => { onCancel(); onOpenSettings('generation'); } : api.configureGeneration },
  { key: 'generationNetwork', label: 'AI 处理联网未开启', fixLabel: '开启 AI 处理', apply: api.setNetworkAllowed ? () => api.setNetworkAllowed!(true) : undefined },
  { key: 'asrConfigured', label: '尚未配置转录密钥', fixLabel: '去设置填写', apply: onOpenSettings ? async () => { onCancel(); onOpenSettings('asr'); } : api.configureAsr },
  { key: 'asrNetwork', label: '转录联网未开启', fixLabel: '开启 AI 处理', apply: api.setNetworkAllowed ? () => api.setNetworkAllowed!(true) : undefined },
 ];
 return <dialog ref={dialog} className="precheck-dialog" aria-label="开始消化前的检查" onCancel={event => { event.preventDefault(); onCancel(); }} data-testid="digest-precheck">
  <h2>开始消化前的检查</h2>
  {missing ? <>
   <p>以下条件满足后才能创建消化请求：</p>
   <ul className="precheck-missing">{rows.filter(row => missing[row.key]).map(row => <li key={row.key}><span>{row.label}</span><button className="btn" disabled={working || !row.apply} onClick={() => void fix(row.apply)}>{row.fixLabel}</button></li>)}</ul>
  </> : <p>配置与联网已就绪。</p>}
  {usage && <p className="precheck-usage">本月用量：{usageLine(usage, 'month')}</p>}
  {error && <p role="alert" className="inline-error">{error}</p>}
  <div className="precheck-actions">
   <button className="btn" onClick={onCancel}>取消</button>
   <button className="btn-primary" disabled={!!missing || working || busy} data-testid="digest-precheck-start" onClick={onStart}>开始消化</button>
  </div>
 </dialog>;
}
