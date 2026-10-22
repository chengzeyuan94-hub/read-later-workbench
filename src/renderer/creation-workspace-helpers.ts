import type { GenerationJobState, GenerationState, GenerationTarget } from '../shared/generation-contracts.js';
import type { DigestContentState } from '../shared/digest-contracts.js';

const labels: Record<GenerationJobState, string> = {
 'waiting-extraction': '等待来源文字', 'waiting-files': '等待本地资料', 'waiting-content': '缺少可整理内容', preparing: '正在准备文字', queued: '排队等待整理', running: '正在整理正文', publishing: '正在校验并保存成果', 'waiting-configuration': '等待生成配置', 'waiting-model': '等待可用生成模型', 'waiting-network': '等待联网', 'result-unknown': '调用结果未知 · 等待明确重试', failed: '生成失败', cancelled: '已取消', succeeded: '已完成'
};
export function creationStageLabel(state: GenerationState | null, digest?: DigestContentState): string {
 if (!state?.authorized) {
  const request = digest?.request;
  if (request?.state === 'cancelled') return '已取消，可重新消化';
  if (request?.state === 'failed') return '消化失败，可重试';
  if (request?.state === 'result-unknown') return '上次请求结果未知，可重试';
  if (request?.state === 'complete') return '已完成';
 }
 if (!state?.authorized || state.state === 'waiting-extraction') {
  const stage = digest?.stages.find(stage => stage.required && ['ocr', 'asr'].includes(stage.name) && stage.state !== 'succeeded');
  if (stage) {
   const transcription = stage.name === 'asr' ? stage.transcription : undefined;
   const count = transcription && transcription.totalChunks > 0
    ? ` · 已转 ${(transcription.doneMs / 60_000).toFixed(1)} / ${(transcription.totalMs / 60_000).toFixed(1)} 分钟 · 第 ${transcription.doneChunks}/${transcription.totalChunks} 段`
    : stage.progress ? ` ${stage.progress.succeeded + stage.progress.noText}/${stage.progress.total}` : '';
   return `${stage.label}${count} · ${stage.state === 'running' ? '处理中' : stage.state === 'failed' ? '失败，可重试' : stage.state === 'waiting-configuration' ? '等待配置' : stage.state === 'waiting-files' ? '等待本地资料' : '等待处理'}`;
  }
 }
 if (!state?.authorized) return digest?.request ? '正在建立消化请求' : '还没开始消化';
 if (state.state === 'running') {
  const active = state.tasks.find(task => task.state === 'running');
  return active?.stage === 'map' ? '正在提炼可编辑导图' : '正在整理完整正文';
 }
 if (state.state === 'queued') {
  const retrying = state.tasks.find(task => task.state === 'queued' && task.attempts > 0 && task.errorCode === 'invalid-output');
  if (retrying) return `正在重试第 ${retrying.order + 1} 段（上次结果未通过出处校验）`;
 }
 if (state.state === 'waiting-model' && state.errorCode === 'input-limit') return '来源过长，暂时不能整理';
 return labels[state.state];
}
/** Version equality is explicit, including manual epoch; empty content is never a substitute. */
export function sameGenerationTarget(a: GenerationTarget | null, b: GenerationTarget | null): boolean {
 return !!a && !!b && a.workspaceId === b.workspaceId && a.draftDocumentId === b.draftDocumentId && a.mapDocumentId === b.mapDocumentId && a.draftRevision === b.draftRevision && a.mapRevision === b.mapRevision && a.contentSha256 === b.contentSha256 && a.manualEpoch === b.manualEpoch && a.managed === b.managed;
}
export function mayInstallGeneration(visibleContentId: number, contentId: number, visibleRequestId: string | null, requestId: string, manualIntent: boolean): boolean {
 // Background items have no renderer-owned input here. Durable target/epoch and
 // request generation fences still decide whether the backend may install them.
 if (visibleContentId !== contentId) return true;
 return visibleRequestId === requestId && !manualIntent;
}
export function markdownStatus(state: GenerationState['markdown']): string {
 return state.state === 'ready' ? `Markdown 导出已更新 · 正文版本 ${state.draftRevision}` : state.state === 'pending' ? '正文已保存 · Markdown 导出待更新' : state.state === 'failed' ? '导出可能不是最新版本' : 'Markdown 导出尚未生成';
}
/** Caller blocks editing for the whole operation. A successful save precedes
 * releasing this view's dirty lease; the durable manual epoch never goes back. */
export async function generationReplacementBarrier(options: { save?: () => Promise<boolean>; protect?: () => Promise<boolean>; release(): Promise<void> }): Promise<boolean> {
 if (options.save && !await options.save()) return false;
 if (options.protect && !await options.protect()) return false;
 await options.release();
 return true;
}

/** Durable saved documents remain accessible when their derived package is bad.
 * Revision-zero managed pairs are system placeholders, never generated results. */
export function hasReadableCreationDocument(state: GenerationState): boolean {
 const target = state.target;
 return !!target && (!target.managed || target.manualEpoch > 0 || target.draftRevision > 0 && target.mapRevision > 0);
}
