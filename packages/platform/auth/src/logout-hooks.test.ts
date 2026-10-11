// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { authRequestHeaders, logout, registerBeforeLogout } from './index';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('releases native registrations before clearing the account bearer', async () => {
  localStorage.setItem('0xnullai.auth-token', 'current-account-token');
  const order: string[] = [];
  const unregister = registerBeforeLogout(async () => {
    order.push('revoke');
    expect(authRequestHeaders()).toEqual({ Authorization: 'Bearer current-account-token' });
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      order.push('logout');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer current-account-token' });
      return new Response('{}', { status: 200 });
    }),
  );

  try {
    await logout();
    expect(order).toEqual(['revoke', 'logout']);
    expect(authRequestHeaders()).toEqual({});
  } finally {
    unregister();
  }
});

it('still signs out when optional native cleanup fails', async () => {
  localStorage.setItem('0xnullai.auth-token', 'current-account-token');
  const unregister = registerBeforeLogout(() => {
    throw new Error('push unavailable');
  });
  const request = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', request);
  try {
    await logout();
    expect(request).toHaveBeenCalledOnce();
    expect(authRequestHeaders()).toEqual({});
  } finally {
    unregister();
  }
});

it('does not leave logout waiting indefinitely for native cleanup', async () => {
  localStorage.setItem('0xnullai.auth-token', 'current-account-token');
  const unregister = registerBeforeLogout(() => new Promise<void>(() => {}));
  const request = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', request);
  vi.useFakeTimers();
  try {
    const pending = logout();
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(request).toHaveBeenCalledOnce();
    expect(authRequestHeaders()).toEqual({});
  } finally {
    unregister();
  }
});
