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

  function readStored(): T | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const stored = options.coerce(
        JSON.parse(localStorage.getItem(options.localStorageKey) ?? 'null'),
      );
      if (!stored) return null;
      const sessionApiKey =
        typeof sessionStorage === 'undefined'
          ? ''
          : (sessionStorage.getItem(options.sessionStorageKey) ?? '');
      return { ...stored, apiKey: stored.rememberApiKey ? stored.apiKey : sessionApiKey };
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
      localStorage.setItem(
        options.localStorageKey,
        JSON.stringify({
          ...normalized,
          apiKey: normalized.rememberApiKey ? normalized.apiKey : '',
        }),
      );
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
