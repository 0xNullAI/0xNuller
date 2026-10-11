import { describe, expect, it, vi } from 'vitest';
import {
  AndroidPushCoordinator,
  accountPushApi,
  openPushRoute,
  pushRoute,
  safePushRoute,
  type AndroidPushBridge,
  type PushRegistrationApi,
} from './android-push';
import { pendingAndroidPushRevocation, setPendingAndroidPushRevocation } from '@0xnullai/settings';

function fakeBridge(overrides: Partial<AndroidPushBridge> = {}) {
  return {
    isPushConfigured: vi.fn(() => true),
    hasNotificationPermission: vi.fn(() => true),
    requestNotificationPermission: vi.fn(),
    ensurePushChannels: vi.fn(),
    setPushAccountId: vi.fn(),
    registerPush: vi.fn(),
    unregisterPush: vi.fn(),
    getPushRegistrationId: vi.fn(() => 'fid-1234567890123456'),
    consumePushRoute: vi.fn(() => ''),
    ...overrides,
  };
}

function fakeApi() {
  return { register: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined) };
}

describe('Android push destinations', () => {
  it('routes only AI, private, and group messages to the matching inbox', () => {
    expect(pushRoute('ai', 'session-1')).toBe('/agent?conversation=session-1');
    expect(pushRoute('dm', 'peer_2')).toBe('/chat?dm=peer_2');
    expect(pushRoute('group', 'room-3')).toBe('/chat?room=room-3');
    expect(pushRoute('ai', 'legacy.session:1')).toBe('/agent?conversation=legacy.session%3A1');
    expect(pushRoute('dm', 'account.name:1')).toBe('/chat?dm=account.name%3A1');
    expect(pushRoute('group', 'room.name')).toBeNull();
    expect(pushRoute('dm', '../control')).toBeNull();
    expect(safePushRoute('//evil.example')).toBeNull();
    expect(safePushRoute('/control?command=start')).toBeNull();
    expect(safePushRoute('/chat?dm=peer&room=room')).toBeNull();
  });

  it('opens a push target in the current document without reloading the device host', () => {
    const push = vi.spyOn(window.history, 'pushState');
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    try {
      expect(openPushRoute('/chat?dm=account.name%3A1')).toBe(true);
      expect(window.location.pathname + window.location.search).toBe('/chat?dm=account.name%3A1');
      expect(push).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls.some(([event]) => event.type === 'popstate')).toBe(true);
      dispatch.mockClear();
      expect(openPushRoute('/chat?dm=account.name%3A1')).toBe(true);
      expect(push).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls.some(([event]) => event.type === 'popstate')).toBe(true);
      expect(openPushRoute('/control?command=start')).toBe(false);
    } finally {
      push.mockRestore();
      dispatch.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('AndroidPushCoordinator', () => {
  it('binds a granted installation to the signed-in account', async () => {
    const bridge = fakeBridge();
    const api = fakeApi();
    const coordinator = new AndroidPushCoordinator(bridge, api);
    await coordinator.setAccount('account-a');
    expect(bridge.ensurePushChannels).toHaveBeenCalledOnce();
    expect(bridge.setPushAccountId).toHaveBeenLastCalledWith('account-a');
    expect(bridge.registerPush).toHaveBeenCalledOnce();
    expect(api.register).toHaveBeenCalledWith('fid-1234567890123456', undefined, undefined);
  });

  it('sends the stable native installation key and prior FID during rotation', async () => {
    const bridge = fakeBridge({
      getPushRegistrationId: vi.fn(() => 'fid-2234567890123456'),
      getPushInstallationKey: vi.fn(() => 'stable-installation-key-001'),
      getPreviousPushRegistrationId: vi.fn(() => 'fid-1234567890123456'),
    });
    const api = fakeApi();
    await new AndroidPushCoordinator(bridge, api).setAccount('account-a');
    expect(api.register).toHaveBeenCalledWith(
      'fid-2234567890123456',
      'stable-installation-key-001',
      'fid-1234567890123456',
    );
  });

  it('revokes a rotated destination by key and preceding FID before logout', async () => {
    const bridge = fakeBridge({
      getPushRegistrationId: vi.fn(() => 'fid-2234567890123456'),
      getPushInstallationKey: vi.fn(() => 'stable-installation-key-001'),
      getPreviousPushRegistrationId: vi.fn(() => 'fid-1234567890123456'),
    });
    const api = fakeApi();
    const coordinator = new AndroidPushCoordinator(bridge, api);
    await coordinator.setAccount('account-a');
    await coordinator.revokeBeforeLogout();
    expect(api.revoke).toHaveBeenCalledWith(
      'fid-2234567890123456',
      'stable-installation-key-001',
      'fid-1234567890123456',
    );
  });

  it('does not ask permission or register when Firebase is not configured', async () => {
    const bridge = fakeBridge({ isPushConfigured: vi.fn(() => false) });
    const coordinator = new AndroidPushCoordinator(bridge, fakeApi());
    await coordinator.setAccount('account-a');
    expect(bridge.requestNotificationPermission).not.toHaveBeenCalled();
    expect(bridge.registerPush).not.toHaveBeenCalled();
  });

  it('suppresses local delivery immediately on logout', async () => {
    const bridge = fakeBridge();
    const api = fakeApi();
    const coordinator = new AndroidPushCoordinator(bridge, api);
    await coordinator.setAccount('account-a');
    await coordinator.setAccount(null);
    expect(bridge.setPushAccountId).toHaveBeenLastCalledWith('');
    expect(bridge.unregisterPush).toHaveBeenCalledOnce();
    expect(api.register).toHaveBeenCalledOnce();
  });

  it('does not register an old account after permission resolves late', async () => {
    let release!: () => void;
    const delay = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const bridge = fakeBridge({ hasNotificationPermission: vi.fn(() => false) });
    const api = fakeApi();
    const coordinator = new AndroidPushCoordinator(bridge, api, delay);
    const pending = coordinator.setAccount('account-a', { askPermission: true });
    await coordinator.setAccount(null);
    release();
    await pending;
    expect(bridge.registerPush).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('asks for notification permission only on an explicit opt-in', async () => {
    const bridge = fakeBridge({ hasNotificationPermission: vi.fn(() => false) });
    const coordinator = new AndroidPushCoordinator(bridge, fakeApi(), async () => {});
    await coordinator.setAccount('account-a');
    expect(bridge.requestNotificationPermission).not.toHaveBeenCalled();
    expect(bridge.registerPush).not.toHaveBeenCalled();
    await coordinator.setAccount('account-a', { askPermission: true });
    expect(bridge.requestNotificationPermission).toHaveBeenCalledOnce();
  });

  it('unregisters once while push stays off instead of on every focus', async () => {
    const bridge = fakeBridge();
    const coordinator = new AndroidPushCoordinator(bridge, fakeApi(), async () => {});
    await coordinator.setAccount(null);
    await coordinator.setAccount(null);
    await coordinator.setAccount(null);
    expect(bridge.unregisterPush).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight old account registration before binding the new account', async () => {
    let finishOld!: () => void;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const oldRequest = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    let signedInAccount = 'account-a';
    const boundAccounts: string[] = [];
    const api: PushRegistrationApi = {
      register: vi.fn().mockImplementation(() => {
        boundAccounts.push(signedInAccount);
        if (boundAccounts.length === 1) {
          oldStarted();
          return oldRequest;
        }
        return Promise.resolve();
      }),
      revoke: vi.fn(async () => undefined),
    };
    const coordinator = new AndroidPushCoordinator(fakeBridge(), api);
    const oldRegistration = coordinator.setAccount('account-a');
    await started;
    signedInAccount = 'account-b';
    const newRegistration = coordinator.setAccount('account-b');
    expect(api.register).toHaveBeenCalledTimes(1);
    finishOld();
    await Promise.all([oldRegistration, newRegistration]);
    expect(boundAccounts).toEqual(['account-a', 'account-b']);
  });

  it('waits for an in-flight registration before revoking on logout', async () => {
    let finishRegistration!: () => void;
    let registrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const api: PushRegistrationApi = {
      register: vi.fn(() => {
        registrationStarted();
        return registration;
      }),
      revoke: vi.fn(async () => undefined),
    };
    const bridge = fakeBridge();
    const coordinator = new AndroidPushCoordinator(bridge, api);
    const pending = coordinator.setAccount('account-a');
    await started;
    const logout = coordinator.revokeBeforeLogout();
    expect(bridge.setPushAccountId).toHaveBeenLastCalledWith('');
    expect(api.revoke).not.toHaveBeenCalled();
    finishRegistration();
    await Promise.all([pending, logout]);
    expect(api.revoke).toHaveBeenCalledWith('fid-1234567890123456', undefined, undefined);
  });

  it('can bind the next account after a failed old registration', async () => {
    const api: PushRegistrationApi = {
      register: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
      revoke: vi.fn(async () => undefined),
    };
    const coordinator = new AndroidPushCoordinator(fakeBridge(), api);
    await expect(coordinator.setAccount('account-a')).rejects.toThrow('offline');
    await expect(coordinator.setAccount('account-b')).resolves.toBeUndefined();
    expect(api.register).toHaveBeenCalledTimes(2);
  });

  it('revokes while the outgoing account can still authenticate', async () => {
    const bridge = fakeBridge();
    const api: PushRegistrationApi = fakeApi();
    const coordinator = new AndroidPushCoordinator(bridge, api);
    await coordinator.setAccount('account-a');
    await coordinator.revokeBeforeLogout();
    expect(bridge.setPushAccountId).toHaveBeenLastCalledWith('');
    expect(bridge.unregisterPush).toHaveBeenCalled();
    expect(api.revoke).toHaveBeenCalledWith('fid-1234567890123456', undefined, undefined);
  });

  it('revokes a persisted native FID when opt-out races initial account reconciliation', async () => {
    const bridge = fakeBridge();
    const api = fakeApi();
    const coordinator = new AndroidPushCoordinator(bridge, api);
    // On a warm Android launch the native FID survives, while the JS account
    // binding can still be waiting for its first async retry to settle.
    await coordinator.revokeBeforeLogout('warm-launch-account');
    expect(bridge.setPushAccountId).toHaveBeenLastCalledWith('');
    expect(bridge.unregisterPush).toHaveBeenCalledOnce();
    expect(api.revoke).toHaveBeenCalledWith('fid-1234567890123456', undefined, undefined);
    expect(pendingAndroidPushRevocation('warm-launch-account')).toBeNull();
  });

  it('retries an earlier failed DELETE at logout even when native FID was already cleared', async () => {
    const accountId = 'push-logout-retry';
    setPendingAndroidPushRevocation(accountId, 'fid-1234567890123456');
    const api = fakeApi();
    const coordinator = new AndroidPushCoordinator(
      fakeBridge({ getPushRegistrationId: vi.fn(() => '') }),
      api,
    );
    await coordinator.revokeBeforeLogout(accountId);
    expect(api.revoke).toHaveBeenCalledWith('fid-1234567890123456', undefined, undefined);
    expect(pendingAndroidPushRevocation(accountId)).toBeNull();
  });

  it('retains a failed revocation for the same account and retries after reauthentication', async () => {
    const accountId = 'push-retry-account';
    const api: PushRegistrationApi = {
      register: vi.fn(async () => undefined),
      revoke: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
    };
    const coordinator = new AndroidPushCoordinator(fakeBridge(), api);
    await coordinator.setAccount(accountId);
    await expect(coordinator.revokeBeforeLogout()).rejects.toThrow('offline');
    expect(pendingAndroidPushRevocation(accountId)).toBe('fid-1234567890123456');
    await coordinator.retryPendingRevocation(accountId);
    expect(api.revoke).toHaveBeenCalledTimes(2);
    expect(pendingAndroidPushRevocation(accountId)).toBeNull();
  });
});

it.each([
  {
    label: 'a bare FID',
    args: ['fid-1234567890123456'] as [string, string?, string?],
    body: { provider: 'fcm-fid', platform: 'android', installationId: 'fid-1234567890123456' },
  },
  {
    label: 'a stable installation key and previous FID from the native shell',
    args: ['fid-2234567890123456', 'stable-installation-key-001', 'fid-1234567890123456'] as [
      string,
      string?,
      string?,
    ],
    body: {
      provider: 'fcm-fid',
      platform: 'android',
      installationId: 'fid-2234567890123456',
      installationKey: 'stable-installation-key-001',
      previousInstallationId: 'fid-1234567890123456',
    },
  },
])(
  'sends FID registration using the agreed account API shape with $label',
  async ({ args, body }) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await accountPushApi.register(...args);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/push/registrations'),
        expect.objectContaining({ method: 'PUT', body: JSON.stringify(body) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it('sends account-scoped rotated destination cleanup on DELETE', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetch);
  try {
    await accountPushApi.revoke(
      'fid-2234567890123456',
      'stable-installation-key-001',
      'fid-1234567890123456',
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      installationKey: 'stable-installation-key-001',
      previousInstallationId: 'fid-1234567890123456',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
