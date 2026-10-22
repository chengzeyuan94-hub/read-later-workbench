import { GenerationCoordinateError } from './generation-coordinates.js';
import { GenerationValidationError, generationSha256 } from './generation-validation.js';
import type { GenerationRetryFeedback, GenerationStage } from '../shared/generation-contracts.js';

export const GENERATION_REJECTION_POLICY = 'bounded-rejection-v1' as const;
export interface GenerationRejectionDiagnostic {
  schemaVersion: 1;
  policyVersion: typeof GENERATION_REJECTION_POLICY;
  stage: GenerationStage;
  code: string;
  jsonPath: string;
  userMessage: string;
  repairHint: string;
  sourceSha256: string;
  configurationSha256: string;
  response: { relativePath: string; sha256: string };
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value);
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 240 && /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(value);

/** Fixed local language only. Never feed an exception message or source instruction back to a model. */
export function generationRepairHint(code: string): { userMessage: string; repairHint: string } {
  if (/citation|coordinate|excerpt|source-range|unknown-source/.test(code)) return {
    userMessage: '生成的出处无法与本条原资料准确对应，结果尚未采用。',
    repairHint: '逐项核对引用：只用本次同一来源单元、冻结范围内的原样摘录；不要猜字、跨来源补齐或扩展范围。',
  };
  if (/critical|condition|negation|uncertain|ambigu|attribution|unsupported|strong|conclusion|quantity|inferred-age|ocr|suspect/.test(code)) return {
    userMessage: '生成内容改变了数字、条件、归因或不确定含义，结果尚未采用。',
    repairHint: '保留来源的数字单位、范围、近似、起价、否定、条件与归因；含混表达保留并以独立待校对提示标记，不得推成确定事实。',
  };
  if (/coverage|omitted|summary|retained|duplicate/.test(code)) return {
    userMessage: '清洗稿的内容覆盖或重复来源证明不完整，结果尚未采用。',
    repairHint: '保留全部有意义事实、例子、步骤和结尾；覆盖必须对应实际保留的正文。只去无意义口头赘词；重复来源必须无环并有实际保留的正文终点。',
  };
  if (/map|tree|group|claim|role|protocol|schema|field|identity|node|object|wire/.test(code)) return {
    userMessage: '生成内容的结构与事实说明不符合要求，结果尚未采用。',
    repairHint: '严格按本次分类型协议输出：分组只承载中性主题，事实标题与说明放有完整出处的事实节点；不得把事实说明放分组或删除说明来过关。',
  };
  return {
    userMessage: '生成结果未通过本地校验，原资料和人工稿保留。',
    repairHint: '按冻结协议检查完整结果；不要删减事实、改动来源或引文来规避校验，不输出额外字段。',
  };
}

export function generationRejectionDiagnostic(error: unknown, stage: GenerationStage, response: GenerationRejectionDiagnostic['response'], sourceSha256: string, configurationSha256: string): GenerationRejectionDiagnostic {
  if (!hex(response.sha256) || !/^rejected\/generation-run-[a-f0-9-]+\.json$/.test(response.relativePath) || !hex(sourceSha256) || !hex(configurationSha256)) throw Error('Invalid rejection evidence identity');
  const recognized = error instanceof GenerationValidationError || error instanceof GenerationCoordinateError;
  const code = recognized && safeCode(error.code) ? error.code : 'validation-internal';
  const candidate = recognized && 'path' in error ? error.path : '/';
  const jsonPath = safePath(candidate) ? candidate : '/';
  return { schemaVersion: 1, policyVersion: GENERATION_REJECTION_POLICY, stage, code, jsonPath, ...generationRepairHint(code), sourceSha256, configurationSha256, response };
}

/** Validated against durable files by the repository before this bounded data crosses the provider boundary. */
export function generationRetryFeedback(diagnostic: GenerationRejectionDiagnostic, diagnosticSha256: string): GenerationRetryFeedback {
  if (diagnostic?.schemaVersion !== 1 || diagnostic.policyVersion !== GENERATION_REJECTION_POLICY || !['organize', 'map'].includes(diagnostic.stage) || !safeCode(diagnostic.code) || !safePath(diagnostic.jsonPath) || !hex(diagnostic.response?.sha256) || !hex(diagnosticSha256) || !hex(diagnostic.sourceSha256) || !hex(diagnostic.configurationSha256) || !/^rejected\/generation-run-[a-f0-9-]+\.json$/.test(diagnostic.response.relativePath)) throw Error('Invalid bounded retry diagnostic');
  const language = generationRepairHint(diagnostic.code);
  if (diagnostic.userMessage !== language.userMessage || diagnostic.repairHint !== language.repairHint) throw Error('Retry hint must be fixed local language');
  return { policyVersion: GENERATION_REJECTION_POLICY, stage: diagnostic.stage, previousResponseSha256: diagnostic.response.sha256, diagnosticSha256, code: diagnostic.code, jsonPath: diagnostic.jsonPath, repairHint: language.repairHint };
}

export const generationRetryFeedbackSha = (value: GenerationRetryFeedback): string => generationSha256(value);
