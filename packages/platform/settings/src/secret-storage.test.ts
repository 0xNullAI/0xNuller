import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SecretStorage from './secret-storage';

type SecretModule = typeof SecretStorage;

class FakeSecureStore {
  readonly values = new Map<string, string>();
  refuseWrites = false;
  secureGet = vi.fn((key: string) => this.values.get(key) ?? null);
  secureSet = vi.fn((key: string, value: string) => {
    if (this.refuseWrites) return false;
    this.values.set(key, value);
    return true;
  });
  secureRemove = vi.fn((key: string) => this.values.delete(key));
}

type BridgeWindow = Window & { AndroidSystem?: unknown };

// The module keeps a per-session cache; every case starts from a fresh copy.
async function load(): Promise<SecretModule> {
  vi.resetModules();
  return import('./secret-storage');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  delete (window as BridgeWindow).AndroidSystem;
  localStorage.clear();
});

describe('secret storage on the web', () => {
  it('keeps secrets in localStorage', async () => {
    const secrets = await load();
    expect(secrets.secretsUseDeviceStore()).toBe(false);
    secrets.writeSecret(secrets.AUTH_TOKEN_SECRET, 'web-token');
    expect(localStorage.getItem('0xnullai.auth-token')).toBe('web-token');
    expect(secrets.readSecret(secrets.AUTH_TOKEN_SECRET)).toBe('web-token');
    secrets.writeSecret(secrets.AUTH_TOKEN_SECRET, null);
    expect(localStorage.getItem('0xnullai.auth-token')).toBeNull();
  });

  it('treats an APK without every secure method as the web', async () => {
    (window as BridgeWindow).AndroidSystem = { secureGet: () => 'native', getSdkInt: () => 34 };
    const secrets = await load();
    localStorage.setItem('k', 'plain');
    expect(secrets.secretsUseDeviceStore()).toBe(false);
    expect(secrets.readSecret('k')).toBe('plain');
  });
});

describe('secret storage on Android', () => {
  let store: FakeSecureStore;
  beforeEach(() => {
    store = new FakeSecureStore();
    (window as BridgeWindow).AndroidSystem = store;
  });

  it('writes to the device store and never to localStorage', async () => {
    const secrets = await load();
    expect(secrets.secretsUseDeviceStore()).toBe(true);
    expect(secrets.writeSecret('0xnullai.auth-token', 'token-1')).toBe(true);
    expect(store.values.get('0xnullai.auth-token')).toBe('token-1');
    expect(localStorage.getItem('0xnullai.auth-token')).toBeNull();
    expect(secrets.readSecret('0xnullai.auth-token')).toBe('token-1');
  });

  it('moves an existing plaintext value into the device store once', async () => {
    localStorage.setItem('0xnullai.auth-token', 'legacy-token');
    const secrets = await load();
    expect(secrets.readSecret('0xnullai.auth-token')).toBe('legacy-token');
    expect(store.values.get('0xnullai.auth-token')).toBe('legacy-token');
    expect(localStorage.getItem('0xnullai.auth-token')).toBeNull();

    const fresh = await load();
    expect(fresh.readSecret('0xnullai.auth-token')).toBe('legacy-token');
    expect(store.secureSet).toHaveBeenCalledTimes(1);
  });

  it('deletes a leftover plaintext copy when the device store already holds the value', async () => {
    store.values.set('k', 'sealed');
    localStorage.setItem('k', 'stale-plain');
    const secrets = await load();
    expect(secrets.readSecret('k')).toBe('sealed');
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('removes the secret from both stores', async () => {
    const secrets = await load();
    secrets.writeSecret('k', 'v');
    localStorage.setItem('k', 'plain');
    secrets.removeSecret('k');
    expect(store.values.has('k')).toBe(false);
    expect(localStorage.getItem('k')).toBeNull();
    expect(secrets.readSecret('k')).toBeNull();
  });

  it('falls back to localStorage when the Keystore refuses a write, so nobody is signed out', async () => {
    store.refuseWrites = true;
    const secrets = await load();
    expect(secrets.writeSecret('k', 'v')).toBe(true);
    expect(localStorage.getItem('k')).toBe('v');
    expect(secrets.readSecret('k')).toBe('v');
    expect(secrets.secretsUseDeviceStore()).toBe(false);
  });

  it('keeps a plaintext value readable when migration fails', async () => {
    store.refuseWrites = true;
    localStorage.setItem('k', 'plain');
    const secrets = await load();
    expect(secrets.readSecret('k')).toBe('plain');
    expect(localStorage.getItem('k')).toBe('plain');
  });

  it('reads a throwing bridge as an empty store', async () => {
    store.secureGet.mockImplementation(() => {
      throw new Error('bridge gone');
    });
    const secrets = await load();
    expect(secrets.readSecret('k')).toBeNull();
  });
});
