import { GENERATION_USABILITY_ORGANIZE_PROMPT, GENERATION_USABILITY_MAP_PROMPT } from './generation-usability-prompts.js';
import { GENERATION_USABILITY_PROMPT_VERSION, GENERATION_USABILITY_SOURCE_POLICY } from './generation-usability.js';
import { JsonGenerationProvider, type GenerationProviderOptions } from './generation-provider.js';

/** Reviewed 2026-10-18; exact IDs still require an authenticated account GET /models intersection. */
export const DEEPSEEK_GENERATION_MODEL_POLICY = Object.freeze({
  version: 'deepseek-official-account-intersection-nonthinking-v1',
  candidates: Object.freeze([
    Object.freeze({ id: 'deepseek-flash', publishedContextTokens: 1_048_576 }),
    Object.freeze({ id: 'deepseek-v4-pro', publishedContextTokens: 1_048_576 }),
  ]),
  inputBudgetUtf8Bytes: 32_000, maxOutputTokens: 16_384, applicationContextBudgetTokens: 65_536,
  providerOutputLimitTokens: 393_216, maxChunks: 24, maxAttemptsPerStagePerChunk: 2,
  sources: Object.freeze([
    'https://api-docs.deepseek.com/api/list-models/',
    'https://api-docs.deepseek.com/api/create-chat-completion/',
    'https://api-docs.deepseek.com/guides/json_mode/',
    'https://api-docs.deepseek.com/guides/thinking_mode/',
    'https://api-docs.deepseek.com/quick_start/pricing/',
  ]),
});
const origin = 'https://api.deepseek.com', modelsPath = '/models', completionsPath = '/chat/completions';
const completionParameters = Object.freeze({ stream: false, temperature: .2, response_format: Object.freeze({ type: 'json_object' }), thinking: Object.freeze({ type: 'disabled' }) });
/** Explicitly repeat the strict output contract observed to fail in real responses.
 * These additions are part of the effective prompt/configuration identity.
 */
export const DEEPSEEK_GENERATION_PROMPT_REFINEMENTS = Object.freeze({
  organize: `官方 DeepSeek 补充输出约束（source-fidelity-v2）：lead 默认输出空字符串，leadCitations 默认 []；如确有非空导读，其中每一事实都必须有完整支持它的原文 citation，不能只给主题词引用，也不能添加来源没有的判断。完整信息保留在 blocks 中，不依赖导读承担正文覆盖。
OCR／ASR 可能存在疑词。不要凭常识自信补正疑词、专名、数字、单位、否定或条件；不能因为改写更顺而改变原意。不确定或明显可疑的识别表达按来源原样保留，并在相邻文字明确标注“原识别文字，待校对”。保留作者／说话者归因和原有不确定性；不能把来源的个人说法强化成普遍事实。title 和 heading 也不得强化断言、改正疑词或加入未经支持的事实。`,
  map: `官方 DeepSeek 补充输出约束（source-fidelity-v2）：role:"structure" 只用于根或主题分组；这些节点的 notes 必须严格为 ""，citations 必须为 []。不得为了便于阅读给 structure 根节点写摘要、说明或一句事实。需要说明、事实、例子或条件时，建立 role:"fact" 的节点并给完整支持的 citations；不允许把结构节点的说明藏进其他字段。
节点 title 和 notes 仍受来源约束：OCR／ASR 疑词、专名、数字、单位、否定和条件不能自信补正；保留作者／说话者归因与不确定性，不能把个人说法强化成事实。疑点沿用整理稿的待校对标识，不能靠更简短的标题抹去限定或把否定倒转。输出前逐一核对所有 structure 的 notes===""，每一事实节点有可解析且真正支持该观点的原始 citation。`,
});

/** Official DeepSeek text generation only; no SiliconFlow key or endpoint fallback exists. */
export class DeepSeekGenerationProvider extends JsonGenerationProvider {
  constructor(options: GenerationProviderOptions = {}) { super(options, {
    provider: 'deepseek', origin, modelsPath, completionsPath,
    defaultKey: () => process.env.DEEPSEEK_API_KEY, policy: DEEPSEEK_GENERATION_MODEL_POLICY, traceHeaders: ['x-request-id'], completionParameters,
    promptVersion: GENERATION_USABILITY_PROMPT_VERSION, promptOverrides: { organize: GENERATION_USABILITY_ORGANIZE_PROMPT, map: GENERATION_USABILITY_MAP_PROMPT },
    configurationIdentity: { qualityPolicy: 'product-usability-v1', sourcePolicy: GENERATION_USABILITY_SOURCE_POLICY, comparisonPolicy: 'source-identity-and-structure-no-lexical-semantics', retryFeedbackPolicy: 'bounded-rejection-v1', origin, modelsPath, completionsPath, completionParameters, singleChoice: 'one-response-choice-no-n-parameter' },
    // Optional current account metadata can narrow the reviewed capability, never enlarge application budgets.
    acceptsAccountModel: model => (model.context_window === undefined || Number.isSafeInteger(model.context_window) && model.context_window >= DEEPSEEK_GENERATION_MODEL_POLICY.applicationContextBudgetTokens) &&
      (model.max_output_tokens === undefined || Number.isSafeInteger(model.max_output_tokens) && model.max_output_tokens >= DEEPSEEK_GENERATION_MODEL_POLICY.maxOutputTokens) &&
      (model.input_modalities === undefined || Array.isArray(model.input_modalities) && model.input_modalities.includes('text')) &&
      (model.output_modalities === undefined || Array.isArray(model.output_modalities) && model.output_modalities.includes('text')),
  }); }
}
