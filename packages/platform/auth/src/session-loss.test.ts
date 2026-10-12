// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { authRequestHeaders, getCreditBalance, logout, subscribeAuthChanges } from './index';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('clears a session the account service rejects and tells subscribers', async () => {
  localStorage.setItem('0xnullai.auth-token', 'revoked-token');
  const changes: unknown[] = [];
  const unsubscribe = subscribeAuthChanges((user) => changes.push(user));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: '未登录' }, { status: 401 })),
  );
  try {
    await expect(getCreditBalance()).rejects.toThrow('未登录');
    expect(authRequestHeaders()).toEqual({});
    expect(changes).toEqual([null]);
  } finally {
    unsubscribe();
  }
});

it('keeps the session on a server or network failure', async () => {
  localStorage.setItem('0xnullai.auth-token', 'live-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'down' }, { status: 503 })),
  );
  await expect(getCreditBalance()).rejects.toThrow();
  expect(authRequestHeaders()).toEqual({ Authorization: 'Bearer live-token' });
});

it('does not clear a newer sign-in when an older request comes back 401', async () => {
  localStorage.setItem('0xnullai.auth-token', 'old-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      localStorage.setItem('0xnullai.auth-token', 'new-token');
      return Response.json({ error: '未登录' }, { status: 401 });
    }),
  );
  await expect(getCreditBalance()).rejects.toThrow();
  expect(authRequestHeaders()).toEqual({ Authorization: 'Bearer new-token' });
});

it('signs out locally even when the logout request cannot reach the server', async () => {
  localStorage.setItem('0xnullai.auth-token', 'current-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new TypeError('offline'))),
  );
  await expect(logout()).rejects.toThrow('offline');
  expect(authRequestHeaders()).toEqual({});
});
