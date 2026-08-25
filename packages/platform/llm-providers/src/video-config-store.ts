import {
  createProviderSettings,
  getProviderDefinition,
  providerRequiresUserApiKey,
  supportsProviderModelImageInput,
  type ProviderEndpoint,
  type ProviderId,
} from './index';

export const VIDEO_LLM_CONFIG_VERSION = 1 as const;

export interface VideoLlmConfig {
  version: typeof VIDEO_LLM_CONFIG_VERSION;
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: ProviderEndpoint;
  useStrict: boolean;
  rememberApiKey: boolean;
}

const KEY = '0xnullai.video-llm-config.v1';
const SESSION_KEY = '0xnullai.video-llm-api-key.v1';
const listeners = new Set<(config: VideoLlmConfig) => void>();

export function defaultVideoLlmConfig(): VideoLlmConfig {
  return {
    version: VIDEO_LLM_CONFIG_VERSION,
    ...createProviderSettings('openai'),
    rememberApiKey: false,
  };
}

function coerceVideoLlmConfig(raw: unknown): VideoLlmConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== VIDEO_LLM_CONFIG_VERSION || typeof value.providerId !== 'string') {
    return null;
  }
  return {
    version: VIDEO_LLM_CONFIG_VERSION,
    providerId: value.providerId,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    model: typeof value.model === 'string' ? value.model : '',
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    endpoint: value.endpoint === 'responses' ? 'responses' : 'chat/completions',
    useStrict: value.useStrict === true,
    rememberApiKey: value.rememberApiKey === true,
  };
}

export function loadVideoLlmConfig(): VideoLlmConfig {
  if (typeof localStorage === 'undefined') return defaultVideoLlmConfig();
  try {
    const stored = coerceVideoLlmConfig(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
    if (!stored) return defaultVideoLlmConfig();
    const sessionApiKey =
      typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem(SESSION_KEY) ?? '');
    return { ...stored, apiKey: stored.rememberApiKey ? stored.apiKey : sessionApiKey };
  } catch {
    return defaultVideoLlmConfig();
  }
}

export function saveVideoLlmConfig(config: VideoLlmConfig): void {
  const normalized: VideoLlmConfig = {
    ...config,
    version: VIDEO_LLM_CONFIG_VERSION,
    endpoint: config.endpoint === 'responses' ? 'responses' : 'chat/completions',
    useStrict: config.useStrict === true,
    rememberApiKey: config.rememberApiKey === true,
  };
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...normalized,
        apiKey: normalized.rememberApiKey ? normalized.apiKey : '',
      }),
    );
    if (typeof sessionStorage !== 'undefined') {
      if (normalized.rememberApiKey) sessionStorage.removeItem(SESSION_KEY);
      else sessionStorage.setItem(SESSION_KEY, normalized.apiKey);
    }
  } catch {
    // Storage can be unavailable. The active page still receives the in-memory value.
  }
  for (const listener of listeners) listener(normalized);
}

export function subscribeVideoLlmConfig(listener: (config: VideoLlmConfig) => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener(loadVideoLlmConfig());
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function filterVideoModelIds(providerId: string, models: readonly string[]): string[] {
  const definition = getProviderDefinition(providerId as ProviderId);
  if (!definition?.browserSupported || definition.imageInput !== 'known-models') return [];
  return models.filter((model) => supportsProviderModelImageInput(definition.id, model));
}

export function isVideoLlmConfigured(config: VideoLlmConfig): boolean {
  const definition = getProviderDefinition(config.providerId as ProviderId);
  if (!definition?.browserSupported || definition.imageInput !== 'known-models') return false;
  if (!supportsProviderModelImageInput(definition.id, config.model)) return false;
  return !providerRequiresUserApiKey(definition.id) || config.apiKey.trim().length > 0;
}
