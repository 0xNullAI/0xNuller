import {
  FREE_TRIAL_PROXY_URL,
  FREE_TRIAL_MODEL,
  loadLlmConfig,
  saveLlmConfig,
  isLlmConfigured,
  type LlmConfig,
} from '@0xnullai/llm-providers';

// AI / LLM provider configuration: the host picks the model the in-room AI agent uses.
//
// The provider list and the free-trial proxy URL come from @0xnullai/llm-providers (the single
// platform-wide registry); all that stays here is DG-Chat's own persisted shape, AiConfig.
// Before the merge this file maintained its own provider list plus a second hardcoded
// llm.0xnullai.com — changing one address meant remembering to change two places.

/** The currently effective AI config. Shape is exactly @0xnullai/llm-providers' LlmConfig —
 *  before the merge DG-Agent and DG-Chat each stored their own copy of the same four fields,
 *  so after configuring Agent the user had to configure Chat all over again. Now it is one
 *  copy: change it in one place and both change. */
export type AiConfig = LlmConfig;

/** Provider preset: used by the dropdown and to prefill baseUrl / model. */
export interface AiProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
}

/** Free proxy URL. The single source of truth is @0xnullai/llm-providers; this is only a
 *  re-export so existing imports keep working. */
export const FREE_PROXY_URL = FREE_TRIAL_PROXY_URL;

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'free',
    label: '免费代理（0xNullAI）',
    baseUrl: FREE_PROXY_URL,
    defaultModel: FREE_TRIAL_MODEL,
    needsKey: false,
  },
  {
    id: 'qwen',
    label: 'Qwen（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.5-plus',
    needsKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    needsKey: true,
  },
  {
    id: 'doubao',
    label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-mini-250415',
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    needsKey: true,
  },
];

/** The free preset is the default config (always available, needs no configuration). */

export function getPreset(id: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Read the saved config; falls back to the free preset when there is none or parsing fails. */
export function loadAiConfig(): AiConfig {
  return loadLlmConfig();
}

export function saveAiConfig(c: AiConfig): void {
  saveLlmConfig(c);
}

/** Whether the config can be used to make a request: the free preset always can, the rest need
 *  apiKey + model + baseUrl. */
export function isAiConfigured(c: AiConfig): boolean {
  return isLlmConfigured(c);
}
