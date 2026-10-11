import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  accountId: null as string | null,
  listener: null as null | ((user: { id: string } | null) => void),
}));

vi.mock('@0xnullai/auth', () => ({
  authRequestHeaders: () => ({}),
  currentAuthUserId: () => auth.accountId,
  subscribeAuthChanges: (listener: (user: { id: string } | null) => void) => {
    auth.listener = listener;
    return () => {
      auth.listener = null;
    };
  },
  registerBeforeLogout: () => () => undefined,
}));

import { installAndroidPush, parsePushTarget, type AndroidPushBridge } from './android-push';

function bridge(accountId: string, route: string) {
  const target = JSON.stringify({ accountId, route });
  const consumePushTarget = vi.fn(() => target);
  const native: AndroidPushBridge = {
    isPushConfigured: () => true,
    hasNotificationPermission: () => true,
    requestNotificationPermission: vi.fn(),
    ensurePushChannels: vi.fn(),
    setPushAccountId: vi.fn(),
    registerPush: vi.fn(),
    unregisterPush: vi.fn(),
    getPushRegistrationId: () => '',
    consumePushRoute: vi.fn(() => route),
    consumePushTarget,
  };
  return { native, consumePushTarget };
}

afterEach(() => {
  auth.accountId = null;
  auth.listener = null;
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

describe('Android notification opening', () => {
  it('waits for the verified auth result on a cold start, then opens the matching AI chat', () => {
    vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
    const { native, consumePushTarget } = bridge('account-a', '/agent?conversation=ai-1');
    const uninstall = installAndroidPush(native);
    try {
      expect(consumePushTarget).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/');
      auth.accountId = 'account-a';
      auth.listener?.({ id: 'account-a' });
      expect(consumePushTarget).toHaveBeenCalledOnce();
      expect(window.location.pathname + window.location.search).toBe('/agent?conversation=ai-1');
    } finally {
      uninstall();
    }
  });

  it('drops a stale-account notification after account switch and opens a current group target', () => {
    vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
    const { native, consumePushTarget } = bridge('account-a', '/chat?dm=peer-1');
    const uninstall = installAndroidPush(native);
    try {
      auth.accountId = 'account-b';
      auth.listener?.({ id: 'account-b' });
      expect(consumePushTarget).toHaveBeenCalledOnce();
      expect(window.location.pathname).toBe('/');
    } finally {
      uninstall();
    }

    const next = bridge('account-b', '/chat?room=room-1');
    const stop = installAndroidPush(next.native);
    try {
      window.dispatchEvent(new Event('0xnullai:push-open'));
      expect(window.location.pathname + window.location.search).toBe('/chat?room=room-1');
    } finally {
      stop();
    }
  });

  it('does not consume a notification after signed-out validation', () => {
    vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
    const { native, consumePushTarget } = bridge('account-a', '/chat?dm=peer-1');
    const uninstall = installAndroidPush(native);
    try {
      auth.listener?.(null);
      expect(consumePushTarget).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/');
    } finally {
      uninstall();
    }
  });

  it('rejects malformed, non-chat, and route-only legacy targets', () => {
    expect(parsePushTarget('{')).toBeNull();
    expect(parsePushTarget(JSON.stringify({ accountId: 'a', route: '/control' }))).toBeNull();
    expect(parsePushTarget(JSON.stringify({ accountId: '../x', route: '/chat?dm=b' }))).toBeNull();
    vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
    const { native } = bridge('account-a', '/chat?dm=peer-1');
    delete native.consumePushTarget;
    const consumeLegacy = vi.spyOn(native, 'consumePushRoute');
    const uninstall = installAndroidPush(native);
    try {
      auth.accountId = 'account-a';
      auth.listener?.({ id: 'account-a' });
      expect(consumeLegacy).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/');
    } finally {
      uninstall();
    }
  });
});
