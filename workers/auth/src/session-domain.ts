import { hashPassword, verifyPassword } from './password';
import { err, json } from './http';
import { readToken, sessionCookie } from './session-credentials';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_USERNAME = 8;
const MAX_FAILS_PER_IP = 30;

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
  banned_at: number | null;
  ban_reason: string | null;
  role: 'user' | 'admin';
  email: string | null;
  email_verified_at: number | null;
}

export interface SessionEnv {
  DB: D1Database;
  EMAIL?: SendEmail;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function publicUser(user: UserRow) {
  return { id: user.id, username: user.username, displayName: user.display_name };
}

export function sessionUser(user: UserRow, emailAvailable = false) {
  return {
    ...publicUser(user),
    role: user.role,
    email: user.email,
    emailVerified: Boolean(user.email_verified_at),
    emailAvailable,
  };
}

export async function currentUser(request: Request, env: SessionEnv): Promise<UserRow | null> {
  const token = readToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = u.id)`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<UserRow>();
  return row ?? null;
}

export async function login(
  request: Request,
  env: SessionEnv,
  ipHash: string,
  cors: HeadersInit,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return err('缺少用户名或密码', 400, cors);

  const since = Date.now() - LOGIN_WINDOW_MS;
  const [byName, byIp] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ok = 0 AND created_at >= ?',
    )
      .bind(username, since)
      .first<{ n: number }>(),
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash = ? AND ok = 0 AND created_at >= ?',
    )
      .bind(ipHash, since)
      .first<{ n: number }>(),
  ]);
  if ((byName?.n ?? 0) >= MAX_FAILS_PER_USERNAME || (byIp?.n ?? 0) >= MAX_FAILS_PER_IP) {
    return err('尝试过于频繁，请稍后再试', 429, cors);
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first<UserRow>();
  const record = (ok: boolean) =>
    env.DB.prepare(
      'INSERT INTO login_attempts (username, ip_hash, ok, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(username, ipHash, ok ? 1 : 0, Date.now())
      .run();

  if (!user) {
    await hashPassword(password);
    await record(false);
    return err('用户名或密码错误', 401, cors);
  }
  if (user.banned_at) {
    return err(`账号已被封禁：${user.ban_reason ?? '未说明原因'}`, 403, cors);
  }

  const { ok, needsUpgrade } = await verifyPassword(password, user.password_hash);
  await record(ok);
  if (!ok) return err('用户名或密码错误', 401, cors);
  if (needsUpgrade) {
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(await hashPassword(password), user.id)
      .run();
  }

  const token = newToken();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      await sha256Hex(token),
      user.id,
      Date.now(),
      Date.now() + SESSION_TTL_MS,
      request.headers.get('User-Agent')?.slice(0, 200) ?? null,
    )
    .run();

  return json({ user: sessionUser(user, Boolean(env.EMAIL)), token }, 200, {
    ...cors,
    'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
  });
}

export async function logout(
  request: Request,
  env: SessionEnv,
  cors: HeadersInit,
): Promise<Response> {
  const token = readToken(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
  }
  return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
}
