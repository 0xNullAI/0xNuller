import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedProviderConfig } from './scoped-provider-config-store';

interface TestConfig extends ScopedProviderConfig {
  model: string;
}

const KEY = 'test.provider-config';
const SESSION_KEY = 'test.provider-api-key';

function coerce(raw: unknown): TestConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return {
    model: typeof value.model === 'string' ? value.model : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    rememberApiKey: value.rememberApiKey !== false,
  };
}

// Fresh modules per case: the secret seam keeps a per-session cache.
async function createStore() {
  vi.resetModules();
  const { createScopedProviderConfigStore } = await import('./scoped-provider-config-store');
  return createScopedProviderConfigStore<TestConfig>({
    localStorageKey: KEY,
    sessionStorageKey: SESSION_KEY,
    createDefault: () => ({ model: '', apiKey: '', rememberApiKey: true }),
    coerce,
    normalize: (config) => config,
  });
}

function storedJson(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown>;
}

function allLocalStorage(): string {
  const entries: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)!;
    entries.push(`${key}=${localStorage.getItem(key)}`);
  }
  return entries.join('\n');
}

type BridgeWindow = Window & { AndroidSystem?: unknown };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  delete (window as BridgeWindow).AndroidSystem;
});

describe('scoped provider config API keys', () => {
  it('keeps a remembered key out of the config JSON', async () => {
    const store = await createStore();
    store.save({ model: 'm', apiKey: 'sk-remembered', rememberApiKey: true });
    expect(storedJson().apiKey).toBe('');
    expect(store.load().apiKey).toBe('sk-remembered');
  });

  it('keeps a key the user chose not to remember in session storage only', async () => {
    const store = await createStore();
    store.save({ model: 'm', apiKey: 'sk-session', rememberApiKey: false });
    expect(storedJson().apiKey).toBe('');
    expect(localStorage.getItem(`${KEY}.api-key`)).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('sk-session');
    expect(store.load().apiKey).toBe('sk-session');
  });

  it('forgets a remembered key when remembering is turned off', async () => {
    const store = await createStore();
    store.save({ model: 'm', apiKey: 'sk-1', rememberApiKey: true });
    store.save({ model: 'm', apiKey: 'sk-1', rememberApiKey: false });
    expect(localStorage.getItem(`${KEY}.api-key`)).toBeNull();
  });

  it('moves a key from an older config JSON behind the secret seam', async () => {
    localStorage.setItem(KEY, JSON.stringify({ model: 'm', apiKey: 'sk-legacy' }));
    const store = await createStore();
    expect(store.load().apiKey).toBe('sk-legacy');
    expect(storedJson()).toEqual({ model: 'm', apiKey: '' });
    expect(store.load().apiKey).toBe('sk-legacy');
  });

  it('stores the remembered key in the Android secure store, never in localStorage', async () => {
    const sealed = new Map<string, string>();
    (window as BridgeWindow).AndroidSystem = {
      secureGet: (key: string) => sealed.get(key) ?? null,
      secureSet: (key: string, value: string) => (sealed.set(key, value), true),
      secureRemove: (key: string) => sealed.delete(key),
    };
    localStorage.setItem(KEY, JSON.stringify({ model: 'm', apiKey: 'sk-plain' }));
    const store = await createStore();
    expect(store.load().apiKey).toBe('sk-plain');
    expect(sealed.get(`${KEY}.api-key`)).toBe('sk-plain');
    expect(allLocalStorage()).not.toContain('sk-plain');

    store.save({ model: 'm', apiKey: 'sk-next', rememberApiKey: true });
    expect(sealed.get(`${KEY}.api-key`)).toBe('sk-next');
    expect(allLocalStorage()).not.toContain('sk-next');
  });
});
