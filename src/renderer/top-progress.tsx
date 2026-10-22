import React, { useRef } from 'react';
import type { WorkbenchState } from '../shared/contracts';
import { topProgress, topProgressHistory } from './ui-terms';

/** Top progress bar for collection sync and media downloads. Rendered at the
 *  bottom edge of the topbar, or inline atop workspace views (`inline`). */
export function TopProgress({ state, inline, onOpen }: { state: WorkbenchState; inline?: boolean; onOpen: () => void }) {
  const history = useRef(topProgressHistory());
  const result = topProgress(state, history.current, Date.now());
  if (result.mode === 'hidden') return null;
  const indeterminate = result.mode === 'syncing';
  return <button type="button" className={`top-progress${inline ? ' top-progress-inline' : ''}`} onClick={onOpen} title={result.label}>
    <span className="top-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(indeterminate ? {} : { 'aria-valuenow': result.pct })} aria-valuetext={result.label}>
      <span className={`top-progress-fill${indeterminate ? ' indeterminate' : ''}${result.mode === 'cooldown' || result.mode === 'paused' ? ' muted' : ''}`} style={indeterminate ? undefined : { width: `${result.pct}%` }} />
    </span>
    <span className="top-progress-label">{result.label}</span>
  </button>;
}
