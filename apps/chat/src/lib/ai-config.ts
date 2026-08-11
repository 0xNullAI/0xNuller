import {
  FREE_TRIAL_PROXY_URL,
  loadLlmConfig,
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
/** Re-exported for llm-client, which recognises the free proxy URL to skip the API-key requirement. */
export const FREE_PROXY_URL = FREE_TRIAL_PROXY_URL;

export function loadAiConfig(): AiConfig {
  return loadLlmConfig();
}

/** Whether the config can be used to make a request: the free preset always can, the rest need
 *  apiKey + model + baseUrl. */
export function isAiConfigured(c: AiConfig): boolean {
  return isLlmConfigured(c);
}
