import { afterEach, expect, it, vi } from 'vitest';
import {
  androidPushEnabled,
  pendingAndroidPushRevocation,
  setAndroidPushEnabled,
  setPendingAndroidPushRevocation,
} from '@0xnullai/settings';

const auth = vi.hoisted(() => ({
  accountId: null as string | null,
  beforeLogout: null as null | (() => Promise<void> | void),
}));
vi.mock('@0xnullai/auth', () => ({
  authRequestHeaders: () => ({ Authorization: 'Bearer test' }),
  currentAuthUserId: () => auth.accountId,
  subscribeAuthChanges: () => () => undefined,
  registerBeforeLogout: (listener: () => Promise<void> | void) => {
    auth.beforeLogout = listener;
    return () => {
      auth.beforeLogout = null;
    };
  },
}));

import { installAndroidPush, type AndroidPushBridge } from './android-push';

afterEach(() => {
  auth.accountId = null;
  auth.beforeLogout = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('does not register again when a pending retry settles during logout', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  auth.accountId = 'push-logout-race';
  setAndroidPushEnabled(auth.accountId, true);
  setPendingAndroidPushRevocation(auth.accountId, 'fid-1234567890123456');
  vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
  let releaseFirst!: () => void;
  const firstDelete = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'DELETE' && fetch.mock.calls.length === 1) await firstDelete;
    return { ok: true, status: 200 };
  });
  vi.stubGlobal('fetch', fetch);
  const bridge: AndroidPushBridge = {
    isPushConfigured: () => true,
    hasNotificationPermission: () => true,
    requestNotificationPermission: vi.fn(),
    ensurePushChannels: vi.fn(),
    setPushAccountId: vi.fn(),
    registerPush: vi.fn(),
    unregisterPush: vi.fn(),
    getPushRegistrationId: () => 'fid-1234567890123456',
    consumePushRoute: () => '',
  };
  const uninstall = installAndroidPush(bridge);
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const logout = Promise.resolve(auth.beforeLogout?.());
    releaseFirst();
    await logout;
    await vi.waitFor(() => expect(pendingAndroidPushRevocation('push-logout-race')).toBeNull());
    expect(fetch.mock.calls.every(([, init]) => init.method === 'DELETE')).toBe(true);
    expect(bridge.registerPush).not.toHaveBeenCalled();
  } finally {
    uninstall();
  }
});

it('retries a failed registration when connectivity returns without a focus change', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  auth.accountId = 'push-online-retry';
  setAndroidPushEnabled(auth.accountId, true);
  expect(androidPushEnabled(auth.accountId)).toBe(true);
  vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  const bridge: AndroidPushBridge = {
    isPushConfigured: () => true,
    hasNotificationPermission: () => true,
    requestNotificationPermission: vi.fn(),
    ensurePushChannels: vi.fn(),
    setPushAccountId: vi.fn(),
    registerPush: vi.fn(),
    unregisterPush: vi.fn(),
    getPushRegistrationId: () => 'fid-1234567890123456',
    consumePushRoute: () => '',
  };
  const uninstall = installAndroidPush(bridge);
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/auth/push/registrations'),
      expect.objectContaining({ method: 'PUT' }),
    );
  } finally {
    uninstall();
  }
});

it('binds a refreshed native FID while the app stays foregrounded', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  auth.accountId = 'push-fid-refresh';
  setAndroidPushEnabled(auth.accountId, true);
  vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
  const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetch);
  let installationId = 'fid-1234567890123456';
  const bridge: AndroidPushBridge = {
    isPushConfigured: () => true,
    hasNotificationPermission: () => true,
    requestNotificationPermission: vi.fn(),
    ensurePushChannels: vi.fn(),
    setPushAccountId: vi.fn(),
    registerPush: vi.fn(),
    unregisterPush: vi.fn(),
    getPushRegistrationId: () => installationId,
    consumePushRoute: () => '',
  };
  const uninstall = installAndroidPush(bridge);
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    installationId = 'fid-2234567890123456';
    window.dispatchEvent(new Event('0xnullai:push-registration'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/auth/push/registrations'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          provider: 'fcm-fid',
          platform: 'android',
          installationId: 'fid-2234567890123456',
        }),
      }),
    );
  } finally {
    uninstall();
  }
});
