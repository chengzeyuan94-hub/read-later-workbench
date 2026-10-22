/** Save belongs to the visible source workspace while it occupies the modal layer. */
export interface SaveShortcutEvent {
  key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean;
  keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean };
  target?: unknown; composedPath?(): EventTarget[];
  preventDefault(): void; stopPropagation(): void;
}
const sourceWorkspace = '.e11-ocr-workspace,.e2-asr-workspace';
const openSourceWorkspace = '.e11-ocr-workspace[open],.e2-asr-workspace[open]';
export function isActiveSourceModal(host: { open: boolean } | null, modalLayers: readonly unknown[]): boolean { return !!host?.open && modalLayers.at(-1) === host; }
export function sourceWorkspaceOwnsShortcut(event: Pick<SaveShortcutEvent, 'target' | 'composedPath'>, root: Pick<Document, 'querySelector'>): boolean {
  const path = event.composedPath?.() ?? [event.target];
  return path.some(value => !!(value as { closest?(selector: string): unknown } | null)?.closest?.(sourceWorkspace)) || !!root.querySelector(openSourceWorkspace);
}
/** The source dialog also consumes composition shortcuts, without committing text or calling save. */
export function dispatchSaveShortcut(event: SaveShortcutEvent, options: { blocked?: boolean; composing?: boolean; save(): void }): 'ignored' | 'composing' | 'saved' {
  if (options.blocked || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return 'ignored';
  event.preventDefault(); event.stopPropagation();
  if (options.composing || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return 'composing';
  options.save(); return 'saved';
}
