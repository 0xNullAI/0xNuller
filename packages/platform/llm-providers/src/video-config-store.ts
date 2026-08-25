import {
  createProviderSettings,
  getProviderDefinition,
  providerRequiresUserApiKey,
  supportsProviderModelImageInput,
  type ProviderEndpoint,
  type ProviderId,
} from './index';
import { createScopedProviderConfigStore } from './scoped-provider-config-store';

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

const store = createScopedProviderConfigStore<VideoLlmConfig>({
  localStorageKey: KEY,
  sessionStorageKey: SESSION_KEY,
  createDefault: defaultVideoLlmConfig,
  coerce: coerceVideoLlmConfig,
  normalize: (config) => ({
    ...config,
    version: VIDEO_LLM_CONFIG_VERSION,
    endpoint: config.endpoint === 'responses' ? 'responses' : 'chat/completions',
    useStrict: config.useStrict === true,
    rememberApiKey: config.rememberApiKey === true,
  }),
});

export function loadVideoLlmConfig(): VideoLlmConfig {
  return store.load();
}

export function saveVideoLlmConfig(config: VideoLlmConfig): void {
  store.save(config);
}

export function subscribeVideoLlmConfig(listener: (config: VideoLlmConfig) => void): () => void {
  return store.subscribe(listener);
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
