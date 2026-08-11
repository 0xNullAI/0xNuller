import type { ProviderId } from './index';
import { FREE_TRIAL_MODEL, FREE_TRIAL_PROXY_URL, getProviderDefinition } from './index';

/**
 * LLM configuration shared across modules.
 *
 * Pre-merge, DG-Agent and DG-Chat each stored a copy of exactly the same
 * four fields (providerId / apiKey / model / baseUrl). Configuring a
 * provider in Agent and having to do it again in Chat is precisely the
 * friction "one app" is supposed to remove.
 *
 * DG-Voice's realtime provider config does NOT merge in: it is a different
 * domain (voice-session endpoints and auth differ) with a different shape.
 * Forcing them together would make both awkward.
 *
 * API keys live in localStorage, same as each module did pre-merge. This
 * is not encrypted storage — same-origin scripts can read it and so can
 * browser extensions. Deployments that truly need secrecy should run their
 * own proxy so the key only exists server-side (the free provider works
 * that way).
 */

export interface LlmConfig {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: 'responses' | 'chat/completions';
  useStrict: boolean;
  rememberApiKey: boolean;
}

const KEY = '0xnullai.llm-config';
const SESSION_KEY = '0xnullai.llm-api-key';
/** Per-module keys from before the merge, migrated once on read. */
const LEGACY_KEYS = ['dg-chat-ai-config', 'dg-agent.provider-settings'];

const listeners = new Set<(c: LlmConfig) => void>();

export function defaultLlmConfig(): LlmConfig {
  return {
    providerId: 'free',
    apiKey: '',
    model: FREE_TRIAL_MODEL,
    baseUrl: FREE_TRIAL_PROXY_URL,
    endpoint: 'chat/completions',
    useStrict: false,
    rememberApiKey: false,
  };
}

function coerce(raw: unknown): LlmConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.providerId !== 'string') return null;
  return {
    providerId: o.providerId,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    model: typeof o.model === 'string' ? o.model : '',
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
    endpoint: o.endpoint === 'responses' ? 'responses' : 'chat/completions',
    useStrict: o.useStrict === true,
    // Existing installations wrote the key to localStorage unconditionally.
    rememberApiKey: typeof o.rememberApiKey === 'boolean' ? o.rememberApiKey : true,
  };
}

export function loadLlmConfig(): LlmConfig {
  if (typeof localStorage === 'undefined') return defaultLlmConfig();
  try {
    const own = coerce(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
    if (own) {
      const sessionKey =
        typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem(SESSION_KEY) ?? '');
      return { ...own, apiKey: own.rememberApiKey ? own.apiKey : sessionKey };
    }
    // One-time migration: copy a legacy key over, write the new key, and
    // never read the legacy keys again.
    for (const legacy of LEGACY_KEYS) {
      const old = coerce(JSON.parse(localStorage.getItem(legacy) ?? 'null'));
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
 * `free`.
 */
export function hasLlmConfig(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (coerce(JSON.parse(localStorage.getItem(KEY) ?? 'null'))) return true;
    return LEGACY_KEYS.some((k) => coerce(JSON.parse(localStorage.getItem(k) ?? 'null')) !== null);
  } catch {
    return false;
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...config, apiKey: config.rememberApiKey ? config.apiKey : '' }),
    );
    if (typeof sessionStorage !== 'undefined') {
      if (config.rememberApiKey) sessionStorage.removeItem(SESSION_KEY);
      else sessionStorage.setItem(SESSION_KEY, config.apiKey);
    }
  } catch {
    // Private browsing / quota exceeded: a failed write must not block
    // use; the config still applies for this session.
  }
  for (const l of listeners) l(config);
}

/**
 * Subscribe to config changes. Same-document changes go through
 * listeners; cross-tab through the storage event — the latter implements
 * "change the provider in the Agent tab, the Chat tab follows".
 */
export function subscribeLlmConfig(listener: (c: LlmConfig) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener(loadLlmConfig());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Whether the config is usable. The free provider needs no key; the rest do. */
export function isLlmConfigured(c: LlmConfig): boolean {
  if (c.providerId === 'free') return true;
  const def = getProviderDefinition(c.providerId as ProviderId);
  const needsKey = def ? def.fields.some((f) => f.key === 'apiKey') : true;
  return needsKey ? c.apiKey.trim().length > 0 : true;
}
