import { hashPassword, verifyPassword } from './password';

/**
 * 0xNullAI account service.
 *
 * Three design constraints, none of them casually chosen:
 *
 * 1. **An account is an optional enhancement, not a gate.** Browsing the market,
 *    joining a room, using Agent purely locally, using Voice with your own key —
 *    none of these require a login. Users in this category are extremely
 *    sensitive about anonymity, and old Android app builds will only ever send
 *    anonymous requests.
 *
 * 2. **An account must never obtain device control from a login alone.** This is
 *    the most important one. Account theft in this product means controlling
 *    someone else's body; that is not remotely the same order of magnitude as
 *    stolen game items. So: device control is always granted in person,
 *    explicitly, and revocably at any time, independent of "who is logged in" —
 *    even another of your own devices logged into the same account cannot
 *    remotely control the 郊狼 you are currently using. This service therefore
 *    **exposes no device-related endpoint at all**; that is a structural
 *    guarantee, not a convention.
 *
 * 3. **Email is optional.** Requiring a real email address is a substantial
 *    barrier for an adult-oriented product. If it is left blank, forgetting the
 *    password means losing the account — say so plainly at registration.
 */

export interface Env {
  DB: D1Database;
  /**
   * Pepper for ip_hash. Kept separate from every other use — it must never be
   * rotated, or every rate-limit record becomes worthless.
   */
  IP_PEPPER: string;
  /** Origins allowed to send credentials, comma separated. */
  ALLOWED_ORIGINS: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_USERNAME = 8;
const MAX_FAILS_PER_IP = 30;
const MIN_PASSWORD_LEN = 10;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function err(message: string, status: number, headers: HeadersInit = {}): Response {
  return json({ error: message }, status, headers);
}

/**
 * Echo the concrete origin rather than `*` — credentialed requests and a wildcard
 * origin cannot coexist.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    // Authorization must be on the allowlist: leave it out and the browser blocks
    // the request outright at the preflight stage, which shows up as "the request
    // never even went out" rather than a catchable 401.
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    Vary: 'Origin',
  };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Read the session token. Two carriers:
 * - Cookie — the web side, shared by every module under the same registrable domain
 * - Bearer — the Android side. The Tauri WebView's origin is a local scheme, so it
 *   cannot get cookies for the web domain; the session layer therefore has to
 *   support both carriers from the start and cannot be cookie-only.
 */
function readToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const cookie = request.headers.get('Cookie') ?? '';
  const m = /(?:^|;\s*)0xn_session=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

function sessionCookie(token: string, maxAgeSec: number): string {
  // Domain spans the subdomains so the four modules share one login state.
  // SameSite=Lax is enough — requests between subdomains of the same registrable
  // domain count as same-site, while cross-site requests do not carry it, which is
  // exactly what we want.
  return [
    `0xn_session=${token}`,
    'Path=/',
    'Domain=.0xnullai.com',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  banned_at: number | null;
  ban_reason: string | null;
}

async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = readToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<UserRow>();
  return row ?? null;
}

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, displayName: u.display_name };
}

function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
    return '用户名需为 3–24 位字母、数字、下划线或连字符';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return `密码至少 ${MIN_PASSWORD_LEN} 位`;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const ipHash = await sha256Hex(
      (request.headers.get('CF-Connecting-IP') ?? '0.0.0.0') + ':' + env.IP_PEPPER,
    );

    try {
      // ── Register ──
      if (path === '/api/auth/register' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const invalid = validateCredentials(body.username, body.password);
        if (invalid) return err(invalid, 400, cors);

        const username = (body.username as string).toLowerCase();
        const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?')
          .bind(username)
          .first();
        if (exists) return err('用户名已被占用', 409, cors);

        const id = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO users (id, username, display_name, password_hash, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            username,
            typeof body.displayName === 'string' && body.displayName.trim()
              ? body.displayName.trim().slice(0, 24)
              : (body.username as string),
            await hashPassword(body.password as string),
            typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
            Date.now(),
          )
          .run();

        const token = newToken();
        await env.DB.prepare(
          'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(
            await sha256Hex(token),
            id,
            Date.now(),
            Date.now() + SESSION_TTL_MS,
            request.headers.get('User-Agent')?.slice(0, 200) ?? null,
          )
          .run();

        return json({ user: { id, username, displayName: username }, token }, 201, {
          ...cors,
          'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
        });
      }

      // ── Login ──
      if (path === '/api/auth/login' && request.method === 'POST') {
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
        // Two-dimensional rate limiting: limit by username only and the attacker
        // just switches names and keeps hammering; limit by IP only and distributed
        // credential stuffing walks straight around it.
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
          // Run a hash even when the user does not exist, so response time cannot
          // be used to tell "no such user" apart from "wrong password".
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
          // Once the iteration count is raised, old hashes are silently upgraded on
          // the next successful login — the user never has to change their password.
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

        return json({ user: publicUser(user), token }, 200, {
          ...cors,
          'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
        });
      }

      // ── Current user ──
      if (path === '/api/auth/me' && request.method === 'GET') {
        const user = await currentUser(request, env);
        return json({ user: user ? publicUser(user) : null }, 200, cors);
      }

      // ── Logout ──
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const token = readToken(request);
        if (token) {
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
            .bind(await sha256Hex(token))
            .run();
        }
        return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
      }

      // ── Delete account ──
      // Users in this category are extremely sensitive about whether the data is
      // really gone, so this is a hard delete rather than a flag, and sessions has
      // ON DELETE CASCADE so every device is logged out immediately.
      if (path === '/api/auth/account' && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
        return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
      }

      return err('接口不存在', 404, cors);
    } catch (e) {
      return err(`服务器错误：${(e as Error).message}`, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;
