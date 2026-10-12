import {
  createProviderSettings,
  MANAGED_VISION_MODEL,
  getProviderDefinition,
  providerRequiresUserApiKey,
  supportsProviderImageInput,
  type ProviderEndpoint,
  type ProviderId,
} from './index';
import { migrateLegacyProviderSettings } from './legacy-provider-migration';
import { createScopedProviderConfigStore } from './scoped-provider-config-store';

export const VIDEO_LLM_CONFIG_VERSION = 1 as const;

export interface VideoLlmConfig {
  version: typeof VIDEO_LLM_CONFIG_VERSION;
  providerId: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: ProviderEndpoint;
  useStrict: boolean;
  /** Custom endpoint only: the user confirmed the model accepts images. */
  imageInput: boolean;
  rememberApiKey: boolean;
}

const KEY = '0xnullai.video-llm-config.v1';
const SESSION_KEY = '0xnullai.video-llm-api-key.v1';

function managedVideoSettings() {
  return { ...createProviderSettings('managed'), model: MANAGED_VISION_MODEL };
}

export function defaultVideoLlmConfig(): VideoLlmConfig {
  return {
    version: VIDEO_LLM_CONFIG_VERSION,
    ...managedVideoSettings(),
    rememberApiKey: false,
  };
}

/** Exported for tests: parses and migrates one stored Video config. */
export function coerceVideoLlmConfig(raw: unknown): VideoLlmConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== VIDEO_LLM_CONFIG_VERSION || typeof value.providerId !== 'string') {
    return null;
  }
  // A removed provider becomes `custom` with image input off (the user re-confirms
  // it) or falls back to managed vision.
  const migrated = migrateLegacyProviderSettings({
    providerId: value.providerId,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    model: typeof value.model === 'string' ? value.model : '',
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    endpoint: value.endpoint === 'responses' ? 'responses' : 'chat/completions',
    useStrict: value.useStrict === true,
    imageInput: value.imageInput === true,
  });
  const rememberApiKey = value.rememberApiKey === true;
  if (migrated.providerId === 'managed') {
    // Older managed Video settings may carry a text-only tier. Keep the managed
    // billing path while upgrading only its model to the vision model.
    return { version: VIDEO_LLM_CONFIG_VERSION, ...managedVideoSettings(), rememberApiKey };
  }
  return { version: VIDEO_LLM_CONFIG_VERSION, ...migrated, rememberApiKey };
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
    imageInput: config.providerId === 'custom' && config.imageInput === true,
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

/** Video needs a model that accepts images: managed vision, or a custom model the user marked. */
export function isVideoLlmConfigured(config: VideoLlmConfig): boolean {
  const definition = getProviderDefinition(config.providerId);
  if (!definition?.browserSupported) return false;
  if (!supportsProviderImageInput(config)) return false;
  return !providerRequiresUserApiKey(definition.id) || config.apiKey.trim().length > 0;
}
