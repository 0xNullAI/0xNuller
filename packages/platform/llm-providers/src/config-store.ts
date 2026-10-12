import type { ProviderId } from './index';
import {
  CUSTOM_PLACEHOLDER_BASE_URL,
  CUSTOM_PLACEHOLDER_MODEL,
  MANAGED_DEFAULT_MODEL,
  MANAGED_SERVICE_URL,
  getProviderDefinition,
} from './index';
import { migrateLegacyProviderSettings } from './legacy-provider-migration';
import { createScopedProviderConfigStore } from './scoped-provider-config-store';

/**
 * LLM configuration shared across modules.
 *
 * Pre-merge, DG-Agent and DG-Chat each stored a copy of exactly the same
 * four fields (providerId / apiKey / model / baseUrl). Configuring a
 * provider in Agent and having to do it again in Chat is precisely the
 * friction "one app" is supposed to remove.
 *
 * DG-Voice's realtime voice settings do NOT merge in: it is a different
 * domain (voice-session endpoints and auth differ) with a different shape.
 * Forcing them together would make both awkward.
 *
 * API keys live in localStorage, same as each module did pre-merge. This
 * is not encrypted storage — same-origin scripts can read it and so can
 * browser extensions. The managed provider does not use a user API key; it
 * calls Volcengine Ark through the llm-proxy Worker.
 */

export interface LlmConfig {
  providerId: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: 'responses' | 'chat/completions';
  useStrict: boolean;
  /** Custom endpoint only: the user confirmed the model accepts images. */
  imageInput: boolean;
  rememberApiKey: boolean;
}

const KEY = '0xnullai.llm-config';
const SESSION_KEY = '0xnullai.llm-api-key';
/** Per-module keys from before the merge, migrated once on read. */
const LEGACY_KEYS = ['dg-chat-ai-config', 'dg-agent.provider-settings'];

export function defaultLlmConfig(): LlmConfig {
  return {
    providerId: 'managed',
    apiKey: '',
    model: MANAGED_DEFAULT_MODEL,
    baseUrl: MANAGED_SERVICE_URL,
    endpoint: 'chat/completions',
    useStrict: false,
    imageInput: false,
    rememberApiKey: false,
  };
}

/** Exported for tests: parses and migrates one stored config. */
export function coerceLlmConfig(raw: unknown): LlmConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.providerId !== 'string') return null;
  // A removed provider becomes `custom` (same key/model, its OpenAI-compatible
  // host) or falls back to `managed`; see legacy-provider-migration.ts.
  return migrateLegacyProviderSettings({
    providerId: o.providerId === 'free' ? 'managed' : o.providerId,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    model: typeof o.model === 'string' ? o.model : '',
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
    endpoint: o.endpoint === 'responses' ? 'responses' : 'chat/completions',
    useStrict: o.useStrict === true,
    imageInput: o.imageInput === true,
    // Existing installations wrote the key to localStorage unconditionally.
    rememberApiKey: typeof o.rememberApiKey === 'boolean' ? o.rememberApiKey : true,
  });
}

const store = createScopedProviderConfigStore<LlmConfig>({
  localStorageKey: KEY,
  sessionStorageKey: SESSION_KEY,
  createDefault: defaultLlmConfig,
  coerce: coerceLlmConfig,
  normalize: (config) => ({
    ...config,
    endpoint: config.endpoint ?? 'chat/completions',
    useStrict: config.useStrict ?? false,
    imageInput: config.providerId === 'custom' && config.imageInput === true,
    rememberApiKey: config.rememberApiKey ?? true,
  }),
});

export function loadLlmConfig(): LlmConfig {
  const own = store.readStored();
  if (own) return own;
  if (typeof localStorage === 'undefined') return defaultLlmConfig();
  try {
    // One-time migration: copy a legacy key over, write the new key, and
    // never read the legacy keys again.
    for (const legacy of LEGACY_KEYS) {
      const old = coerceLlmConfig(JSON.parse(localStorage.getItem(legacy) ?? 'null'));
      if (old) {
        saveLlmConfig(old);
        return old;
      }
    }
  } catch {
    // On corrupt storage fall back to defaults instead of crashing the
    // module at startup.
  }
  return defaultLlmConfig();
}

/**
 * Whether the user has actually chosen a provider, as opposed to the store
 * handing back its defaults.
 *
 * Callers that merge this config over their own need the difference:
 * `loadLlmConfig()` always returns something, so an untouched store would
 * otherwise silently overwrite a module's own persisted provider with
 * `managed`.
 */
export function hasLlmConfig(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (coerceLlmConfig(JSON.parse(localStorage.getItem(KEY) ?? 'null'))) return true;
    return LEGACY_KEYS.some(
      (k) => coerceLlmConfig(JSON.parse(localStorage.getItem(k) ?? 'null')) !== null,
    );
  } catch {
    return false;
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  // Runtime callers from 6.0.0 can still pass the former four-field shape.
  // Treat a missing preference as the legacy behavior (remember the key),
  // rather than silently moving the key to session storage and losing it on
  // the next tab or process.
  store.save(config);
}

/**
 * Subscribe to config changes. Same-document changes go through
 * listeners; cross-tab through the storage event — the latter implements
 * "change the provider in the Agent tab, the Chat tab follows".
 */
export function subscribeLlmConfig(listener: (c: LlmConfig) => void): () => void {
  return store.subscribe(listener);
}

/** Whether the config is usable. The managed provider needs no user key; the rest do. */
export function isLlmConfigured(c: LlmConfig): boolean {
  if (c.providerId === 'managed') return true;
  const def = getProviderDefinition(c.providerId);
  const needsKey = def ? def.fields.some((f) => f.key === 'apiKey') : true;
  // A custom endpoint still carrying the placeholder address or model is not set up yet.
  if (
    c.providerId === 'custom' &&
    (c.baseUrl === CUSTOM_PLACEHOLDER_BASE_URL || c.model === CUSTOM_PLACEHOLDER_MODEL)
  )
    return false;
  return needsKey ? c.apiKey.trim().length > 0 : true;
}
