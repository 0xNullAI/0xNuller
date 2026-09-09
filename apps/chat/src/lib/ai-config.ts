import { loadLlmConfig, isLlmConfigured, type LlmConfig } from '@0xnullai/llm-providers';

// AI / LLM provider configuration: the host picks the model the in-room AI agent uses.
//
// The provider list and managed-service URL come from @0xnullai/llm-providers (the single
// platform-wide registry); all that stays here is DG-Chat's own persisted shape, AiConfig.
// Before the merge this file maintained its own provider list plus a second hardcoded
// llm.0xnullai.com — changing one address meant remembering to change two places.

/** The currently effective AI config. Shape is exactly @0xnullai/llm-providers' LlmConfig —
 *  before the merge DG-Agent and DG-Chat each stored their own copy of the same four fields,
 *  so after configuring Agent the user had to configure Chat all over again. Now it is one
 *  copy: change it in one place and both change. */
export type AiConfig = LlmConfig;

export function loadAiConfig(): AiConfig {
  return loadLlmConfig();
}

/** Whether the config can be used to make a request: the managed preset needs no user key, the rest need
 *  apiKey + model + baseUrl. */
export function isAiConfigured(c: AiConfig): boolean {
  return isLlmConfigured(c);
}
