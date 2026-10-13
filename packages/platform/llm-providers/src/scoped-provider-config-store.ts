import { readSecret, writeSecret } from '@0xnullai/settings';

export interface ScopedProviderConfig {
  apiKey: string;
  rememberApiKey: boolean;
}

interface ScopedProviderConfigStoreOptions<T extends ScopedProviderConfig> {
  localStorageKey: string;
  sessionStorageKey: string;
  createDefault: () => T;
  coerce: (raw: unknown) => T | null;
  normalize: (config: T) => T;
}

export interface ScopedProviderConfigStore<T extends ScopedProviderConfig> {
  readStored(): T | null;
  load(): T;
  save(config: T): T;
  subscribe(listener: (config: T) => void): () => void;
}

/**
 * Shared browser persistence mechanics for independently scoped model configs.
 *
 * Agent/Chat and Video deliberately keep different storage keys and validation
 * policies, but they must agree on API-key session persistence, corrupt-storage
 * fallback, same-document notifications and cross-tab updates.
 */
export function createScopedProviderConfigStore<T extends ScopedProviderConfig>(
  options: ScopedProviderConfigStoreOptions<T>,
): ScopedProviderConfigStore<T> {
  const listeners = new Set<(config: T) => void>();
  // A remembered key lives behind the secret seam (the Android Keystore store on the phone),
  // never inside the config JSON.
  const apiKeySecret = `${options.localStorageKey}.api-key`;

  /** Older builds kept the remembered key inside the config JSON; move it out once. */
  function rememberedApiKey(raw: Record<string, unknown>, legacyApiKey: string): string {
    if (!legacyApiKey) return readSecret(apiKeySecret) ?? '';
    if (writeSecret(apiKeySecret, legacyApiKey)) {
      try {
        localStorage.setItem(options.localStorageKey, JSON.stringify({ ...raw, apiKey: '' }));
      } catch {
        // The next read retries; the secret copy already holds the key.
      }
    }
    return legacyApiKey;
  }

  function readStored(): T | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(options.localStorageKey) ?? 'null');
      const stored = options.coerce(raw);
      if (!stored) return null;
      if (stored.rememberApiKey) {
        return {
          ...stored,
          apiKey: rememberedApiKey(raw as Record<string, unknown>, stored.apiKey),
        };
      }
      const sessionApiKey =
        typeof sessionStorage === 'undefined'
          ? ''
          : (sessionStorage.getItem(options.sessionStorageKey) ?? '');
      return { ...stored, apiKey: sessionApiKey };
    } catch {
      return null;
    }
  }

  function load(): T {
    return readStored() ?? options.createDefault();
  }

  function save(config: T): T {
    const normalized = options.normalize(config);
    try {
      writeSecret(apiKeySecret, normalized.rememberApiKey ? normalized.apiKey : null);
      localStorage.setItem(options.localStorageKey, JSON.stringify({ ...normalized, apiKey: '' }));
      if (typeof sessionStorage !== 'undefined') {
        if (normalized.rememberApiKey) sessionStorage.removeItem(options.sessionStorageKey);
        else sessionStorage.setItem(options.sessionStorageKey, normalized.apiKey);
      }
    } catch {
      // Storage can be unavailable. The active page still receives the value.
    }
    for (const listener of listeners) listener(normalized);
    return normalized;
  }

  function subscribe(listener: (config: T) => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === options.localStorageKey) listener(load());
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }

  return { readStored, load, save, subscribe };
}
