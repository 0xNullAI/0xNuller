import { hashPassword, verifyPassword } from './password';

/**
 * 0xNullAI 账号服务。
 *
 * 三条设计约束，都不是随手定的：
 *
 * 1. **账号是可选增强，不是准入门槛。** 逛市场、进房间、纯本地用 Agent、自带 key
 *    用 Voice——一个都不需要登录。这个品类的用户对匿名性极度敏感，而且老版本的
 *    安卓 App 永远只会发匿名请求。
 *
 * 2. **账号永远不能仅凭登录态获得设备控制权。** 这是最重要的一条。盗号在这个产品
 *    里意味着控制他人身体，跟盗游戏装备完全不是一个量级。所以：设备控制权的授予
 *    始终是当面的、显式的、可随时撤销的，与「谁登录了」无关——哪怕是你自己的另一
 *    台设备登录了同一账号，也不能远程控制你正在用的郊狼。本服务因此**不提供任何
 *    与设备相关的接口**，这是结构性的保证，不是约定。
 *
 * 3. **邮箱可选。** 要求真实邮箱对成人向产品是一道实质门槛。不填则忘记密码等于
 *    失去账号，注册时明确告知。
 */

export interface Env {
  DB: D1Database;
  /** ip_hash 的 pepper。与任何其他用途分开——它必须永不轮换，否则限流记录全部失效。 */
  IP_PEPPER: string;
  /** 允许携带凭据的来源，逗号分隔。 */
  ALLOWED_ORIGINS: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
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

/** 回显具体 origin 而不是 `*`——带凭据的请求与通配 origin 不能共存。 */
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
    // Authorization 必须在白名单里：漏了它，浏览器会在 preflight 阶段直接拦掉，
    // 表现是「请求根本没发出去」而不是可捕获的 401。
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
 * 取会话 token。两种载体：
 * - Cookie —— 网页端，同一注册域下的各模块共用
 * - Bearer —— 安卓端。Tauri WebView 的 origin 是本地 scheme，拿不到网页域的 cookie，
 *   所以会话层从一开始就必须支持两种载体，不能只做 cookie。
 */
function readToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const cookie = request.headers.get('Cookie') ?? '';
  const m = /(?:^|;\s*)0xn_session=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

function sessionCookie(token: string, maxAgeSec: number): string {
  // Domain 覆盖各子域，让四个模块共用登录态。SameSite=Lax 足够——同一注册域下的
  // 子域间请求算 same-site，跨站请求则带不上，正是我们要的。
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
      // ── 注册 ──
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

      // ── 登录 ──
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
        // 双维度限流：只按用户名限，攻击者可以换名继续撞；只按 IP 限，分布式撞库绕得过。
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
          // 用户不存在时也走一次哈希，避免用响应时间区分「用户不存在」与「密码错误」。
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
          // 提高轮数后，老密码在下次成功登录时静默升级——不需要用户改密码。
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

      // ── 当前用户 ──
      if (path === '/api/auth/me' && request.method === 'GET') {
        const user = await currentUser(request, env);
        return json({ user: user ? publicUser(user) : null }, 200, cors);
      }

      // ── 登出 ──
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const token = readToken(request);
        if (token) {
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
            .bind(await sha256Hex(token))
            .run();
        }
        return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
      }

      // ── 注销账号 ──
      // 这个品类的用户对「能不能真的删掉」极其敏感，所以是硬删除而不是标记，
      // 且 sessions 有 ON DELETE CASCADE，所有设备立即登出。
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
