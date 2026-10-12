import type { ProviderEndpoint, ProviderId, ProviderSettings } from './index';

/**
 * OpenAI-compatible endpoints for providers that used to have their own entry.
 *
 * A saved config naming one of them becomes `custom` with the same key and model, so
 * it keeps working. Each URL is the one the removed entry actually called: the former
 * built-in defaults (qwen, deepseek, doubao, openai) or the `openai-completions` host
 * pi-ai used for that provider. Mistral and Gemini used their native APIs there; their
 * documented OpenAI-compatible hosts are used instead.
 *
 * Providers without a known OpenAI-compatible host for the same key (Anthropic,
 * MiniMax) fall back to `managed` rather than to a guessed URL.
 */
const LEGACY_OPENAI_COMPATIBLE: Readonly<
  Record<string, { baseUrl: string; endpoint: ProviderEndpoint }>
> = {
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    endpoint: 'chat/completions',
  },
  deepseek: { baseUrl: 'https://api.deepseek.com', endpoint: 'chat/completions' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', endpoint: 'chat/completions' },
  // Current OpenAI models call tools only through the Responses API.
  openai: { baseUrl: 'https://api.openai.com/v1', endpoint: 'responses' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', endpoint: 'chat/completions' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', endpoint: 'chat/completions' },
  moonshotai: { baseUrl: 'https://api.moonshot.ai/v1', endpoint: 'chat/completions' },
  'moonshotai-cn': { baseUrl: 'https://api.moonshot.cn/v1', endpoint: 'chat/completions' },
  // Both Z.AI entries were the GLM Coding Plan, whose keys work only on these hosts.
  zai: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', endpoint: 'chat/completions' },
  'zai-coding-cn': {
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    endpoint: 'chat/completions',
  },
  xai: { baseUrl: 'https://api.x.ai/v1', endpoint: 'chat/completions' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', endpoint: 'chat/completions' },
  together: { baseUrl: 'https://api.together.ai/v1', endpoint: 'chat/completions' },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1', endpoint: 'chat/completions' },
  fireworks: { baseUrl: 'https://api.fireworks.ai/inference/v1', endpoint: 'chat/completions' },
  xiaomi: { baseUrl: 'https://api.xiaomimimo.com/v1', endpoint: 'chat/completions' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', endpoint: 'chat/completions' },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    endpoint: 'chat/completions',
  },
};

/** Where a stored provider id now lives: unchanged, `custom`, or back on `managed`. */
export function migrateLegacyProviderId(providerId: string): ProviderId {
  if (providerId === 'managed' || providerId === 'custom') return providerId;
  return LEGACY_OPENAI_COMPATIBLE[providerId] ? 'custom' : 'managed';
}

/**
 * Converts a stored config naming a removed provider. Known hosts become `custom`
 * with the same key and model; anything else returns to `managed` and drops the
 * key, which belonged to a service the app no longer calls. Image input always
 * starts off: the user has to switch it on for the custom endpoint.
 */
export function migrateLegacyProviderSettings<
  T extends {
    providerId: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    endpoint: ProviderEndpoint;
    useStrict: boolean;
    imageInput?: boolean;
  },
>(config: T): Omit<T, 'providerId' | 'imageInput'> & ProviderSettings {
  const { providerId } = config;
  if (providerId === 'managed' || providerId === 'custom') {
    return { ...config, providerId, imageInput: config.imageInput === true };
  }
  const target = LEGACY_OPENAI_COMPATIBLE[providerId];
  if (!target) {
    return {
      ...config,
      providerId: 'managed',
      apiKey: '',
      model: '',
      baseUrl: '',
      endpoint: 'chat/completions',
      useStrict: false,
      imageInput: false,
    };
  }
  const storedBaseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return {
    ...config,
    providerId: 'custom',
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
    model: typeof config.model === 'string' ? config.model.trim() : '',
    // OpenAI's entry let the user edit the URL; the others stored their default or ''.
    baseUrl: storedBaseUrl || target.baseUrl,
    endpoint: target.endpoint,
    useStrict: false,
    imageInput: false,
  };
}
