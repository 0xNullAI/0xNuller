/**
 * Account client.
 *
 * It deliberately exposes no device-related API. This is a structural
 * guarantee, not a convention: accounts handle identity and data ownership
 * only, while device control is always granted in person, explicitly, and
 * revocably — independent of who is logged in. A stolen account in this
 * product would otherwise mean control over someone's body, so even your
 * own second device logged into the same account cannot remotely control
 * the Coyote you are using.
 *
 * Two session carriers: the web uses HttpOnly cookies (shared across
 * modules under one registrable domain); Android uses Bearer tokens — the
 * Tauri WebView's origin is a local scheme and can never receive the web
 * domain's cookies.
 */

import { apiBaseUrl } from '@0xnullai/settings';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

// Auth endpoints live under `/api/auth` on the unified domain (paths are
// written at each call site), so only the origin is needed here: empty
// string on the web (same-origin); the Tauri shell gets an absolute origin
// from apiBaseUrl().

/** Android stores the token here; empty on the web, which relies on cookies. */
const TOKEN_KEY = '0xnullai.auth-token';

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing may reject the write: the session still works (the
    // in-memory state remains) but a refresh will require logging in again.
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = storedToken();
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `请求失败（${res.status}）`);
  return data as T;
}

export async function register(input: {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
}): Promise<AuthUser> {
  const r = await call<{ user: AuthUser; token: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setStoredToken(r.token);
  return r.user;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const r = await call<{ user: AuthUser; token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setStoredToken(r.token);
  return r.user;
}

export async function me(): Promise<AuthUser | null> {
  const r = await call<{ user: AuthUser | null }>('/api/auth/me');
  return r.user;
}

export async function logout(): Promise<void> {
  await call('/api/auth/logout', { method: 'POST' });
  setStoredToken(null);
}

/** Hard-delete the account. Users of this product category care intensely about whether deletion is real — so it is a real delete, not a flag. */
export async function deleteAccount(): Promise<void> {
  await call('/api/auth/account', { method: 'DELETE' });
  setStoredToken(null);
}
