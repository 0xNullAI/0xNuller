/**
 * 账号客户端。
 *
 * **它刻意不提供任何与设备相关的接口。** 这是结构性保证而不是约定：账号只管身份与
 * 数据归属，设备控制权的授予始终是当面的、显式的、可随时撤销的，与「谁登录了」无关。
 * 盗号在这个产品里意味着控制他人身体——所以哪怕是你自己的另一台设备登录了同一账号，
 * 也不能远程控制你正在用的郊狼。
 *
 * 两种会话载体：网页端用 HttpOnly cookie（同一注册域下各模块共用），安卓端用 Bearer
 * ——Tauri WebView 的 origin 是本地 scheme，永远拿不到网页域的 cookie。
 */

import { apiBaseUrl } from '@0xnullai/settings';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

// 账号接口挂在统一域的 `/api/auth` 下（路径写在各个调用点），所以这里只要 origin：
// 网页端是空串走同源，Tauri 壳拿不到同源、由 apiBaseUrl() 给出绝对地址。

/** 安卓端把 token 存这里；网页端为空，靠 cookie。 */
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
    // 隐私模式下存不下：本次会话内仍可用（内存里的 state 还在），刷新后需重新登录。
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

/** 硬删除账号。这个品类的用户对「能不能真的删掉」极其敏感，所以不是标记而是真删。 */
export async function deleteAccount(): Promise<void> {
  await call('/api/auth/account', { method: 'DELETE' });
  setStoredToken(null);
}
