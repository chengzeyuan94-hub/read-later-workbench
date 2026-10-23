import React, { useEffect, useRef, useState } from 'react';
import type { CredentialPromptRequest } from '../shared/contracts.js';

/**
 * In-app credential entry on every platform. The typed key is sent once to the
 * main process for safeStorage encryption; it is never read back, never logged,
 * and cleared from this component's state on submit, cancel and close.
 */
export function CredentialModal() {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [request, setRequest] = useState<CredentialPromptRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const bridge = window.workbench.credentials;
    if (!bridge) return;
    return bridge.onOpen(next => { setRequest(next); setError(''); setBusy(false); dialog.current?.showModal(); });
  }, []);

  const clear = () => { if (input.current) input.current.value = ''; };
  const close = (notify: boolean) => {
    clear();
    const pending = request;
    setRequest(null); setError(''); setBusy(false);
    dialog.current?.close();
    if (notify && pending) void window.workbench.credentials?.cancel(pending.provider);
  };
  const submit = async () => {
    if (!request || busy) return;
    const value = input.current?.value ?? '';
    if (!value.trim()) { setError('请输入密钥后再保存。'); return; }
    setBusy(true); setError('');
    try {
      await window.workbench.credentials!.set(request.provider, value);
      close(false);
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败，密钥未保存。'); setBusy(false); clear(); }
  };

  return (
    <dialog ref={dialog} className="credential-dialog" onCancel={() => close(true)} onClose={() => { clear(); setRequest(null); setError(''); setBusy(false); }}>
      {request && <form method="dialog" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h3>配置 {request.label}</h3>
        <p className="muted">{request.purpose}。只保存在本机安全存储，不会显示或导出。</p>
        <input ref={input} type="password" autoFocus autoComplete="off" spellCheck={false} aria-label={`${request.label} 密钥`} placeholder="粘贴 API 密钥" disabled={busy} />
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => close(true)}>取消</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? '保存中…' : '保存密钥'}</button>
        </div>
      </form>}
    </dialog>
  );
}
