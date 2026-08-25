/**
 * Browser-safe provider registry metadata. Keep this module free of pi-ai imports so
 * callers can validate persisted settings without loading any provider runtime.
 */
export const PI_AI_PROVIDER_KEYS = [
  'anthropic',
  'google',
  'openrouter',
  'groq',
  'moonshotai',
  'moonshotai-cn',
  'zai',
  'zai-coding-cn',
  'minimax',
  'minimax-cn',
  'xai',
  'cerebras',
  'together',
  'huggingface',
  'mistral',
  'fireworks',
  'xiaomi',
] as const;

export type PiAiProviderKey = (typeof PI_AI_PROVIDER_KEYS)[number];
