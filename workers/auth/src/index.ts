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
  /**
   * Bucket for profile photos. Optional so the worker still runs without it —
   * the photo endpoints degrade rather than the whole service failing to boot.
   */
  PHOTOS?: R2Bucket;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_USERNAME = 8;
const MAX_FAILS_PER_IP = 30;
const MIN_PASSWORD_LEN = 10;

/**
 * Contact list paging. The cap is the point: without it a single request can
 * ask for an entire follower graph, which is both a slow query and a bulk
 * export of who is connected to whom.
 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
/**
 * Blocks are returned in one shot rather than paged. The list is only useful as
 * "everyone I have blocked, so I can unblock someone", and a page boundary in
 * the middle of that is a worse answer than a ceiling nobody reaches.
 */
const MAX_BLOCKS = 200;

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

/** Age in whole years. Used only to refuse an under-18 birth date. */
function ageFrom(birthDate: string): number {
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() ||
    (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function publicProfile(row: Record<string, unknown>) {
  return {
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    birthDate: row.birth_date ?? null,
    location: row.location ?? null,
    links: row.links ? (JSON.parse(String(row.links)) as string[]) : [],
    visibility: row.visibility === 'public' ? 'public' : 'private',
  };
}

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, displayName: u.display_name };
}

/**
 * A contact list row. `mutual` is what makes a contact — both follow rows
 * exist. It is computed rather than stored; see 0004_contacts.sql.
 */
function contactRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    username: String(r.username),
    displayName: String(r.display_name),
    followedAt: Number(r.followed_at),
    mutual: Number(r.mutual) === 1,
  };
}

/**
 * Clamp the paging parameters. Neither carries personal data, which is why
 * paging is offset-based here: a keyset cursor would have to encode the last
 * row's user id, and user ids do not go in query strings — those end up in
 * access logs, referrer headers and browser history.
 */
function pageParams(url: URL): { limit: number; offset: number } {
  const requested = Number(url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE;
  return {
    limit: Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE),
    offset: Math.max(Math.trunc(Number(url.searchParams.get('offset')) || 0), 0),
  };
}

/**
 * Is there a block in either direction between these two users?
 *
 * Blocks are stored directionally so their owner can undo them, but they are
 * always read symmetrically: if either party blocked the other, they are
 * invisible to each other. Checking only one direction would leave the blocked
 * person free to keep watching the blocker.
 */
async function blockedBetween(env: Env, a: string, b: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
  )
    .bind(a, b, b, a)
    .first();
  return row != null;
}

async function follows(env: Env, followerId: string, followeeId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?',
  )
    .bind(followerId, followeeId)
    .first();
  return row != null;
}

/**
 * Both contact lists are the same query read from opposite ends of the row, so
 * they are built from one place rather than kept in sync by hand.
 *
 * `mutual` is the same sub-select either way round: does a row exist pointing
 * back along this one. The NOT EXISTS drops anyone in a block relationship with
 * the viewer — the write path already refuses to create such a follow, but a
 * read path that trusted that would fail silently the day a new call site
 * forgets, and the failure looks like a blocked person reappearing in a list.
 *
 * The interpolated names are column identifiers chosen here from a closed set,
 * never request input.
 */
function contactListSql(direction: 'following' | 'followers'): string {
  // "Following" filters on my end being the follower and shows the followee;
  // "followers" is the mirror image.
  const mine = direction === 'following' ? 'follower_id' : 'followee_id';
  const other = direction === 'following' ? 'followee_id' : 'follower_id';
  return `SELECT u.id, u.username, u.display_name, f.created_at AS followed_at,
       EXISTS (SELECT 1 FROM user_follows m
                WHERE m.follower_id = f.followee_id AND m.followee_id = f.follower_id) AS mutual
  FROM user_follows f
  JOIN users u ON u.id = f.${other}
 WHERE f.${mine} = ?
   AND NOT EXISTS (SELECT 1 FROM user_blocks x
                    WHERE (x.blocker_id = f.follower_id AND x.blocked_id = f.followee_id)
                       OR (x.blocker_id = f.followee_id AND x.blocked_id = f.follower_id))
 ORDER BY f.created_at DESC
 LIMIT ? OFFSET ?`;
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

      // ── Profile ──
      //
      // Every field is optional; an account that fills in nothing has to work
      // exactly as well. Two deliberate limits, for this product's users
      // rather than out of caution: `location` is region-level and capped
      // short, because a street address in a leaked database is a physical
      // risk here and no feature needs one; and visibility defaults to
      // private, because information like this cannot be un-seen once it has
      // been shown.
      if (path === '/api/auth/profile' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const row = await env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?')
          .bind(user.id)
          .first<Record<string, unknown>>();
        return json({ profile: row ? publicProfile(row) : null }, 200, cors);
      }

      if (path === '/api/auth/profile' && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json()) as Record<string, unknown>;

        const birthDate = typeof body.birthDate === 'string' ? body.birthDate.trim() : '';
        if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
          return err('生日格式应为 YYYY-MM-DD', 400, cors);
        }
        // An adult-only product: a birth date that is present and under 18 is
        // rejected outright rather than stored and checked later.
        if (birthDate && ageFrom(birthDate) < 18) {
          return err('本产品仅面向成年人', 400, cors);
        }

        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO user_profiles (user_id, avatar_url, bio, birth_date, location, links, visibility, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             avatar_url = excluded.avatar_url, bio = excluded.bio,
             birth_date = excluded.birth_date, location = excluded.location,
             links = excluded.links, visibility = excluded.visibility,
             updated_at = excluded.updated_at`,
        )
          .bind(
            user.id,
            typeof body.avatarUrl === 'string' ? body.avatarUrl.slice(0, 500) : null,
            typeof body.bio === 'string' ? body.bio.slice(0, 500) : null,
            birthDate || null,
            // Region-level. The cap is the point, not a guess at a sane length.
            typeof body.location === 'string' ? body.location.slice(0, 60) : null,
            Array.isArray(body.links) ? JSON.stringify(body.links.slice(0, 5)) : null,
            body.visibility === 'public' ? 'public' : 'private',
            now,
          )
          .run();
        return json({ ok: true, updatedAt: now }, 200, cors);
      }

      // ── Photos ──
      //
      // Rows reference R2 objects; the image itself is never in D1. A delete
      // has to remove the object too — otherwise "deleted" only means gone
      // from the list, and for this kind of content that is not deletion.
      if (path === '/api/auth/photos' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const rows = await env.DB.prepare(
          'SELECT id, object_key, caption, visibility, created_at FROM user_photos WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
        )
          .bind(user.id)
          .all();
        return json({ photos: rows.results ?? [] }, 200, cors);
      }

      if (path.startsWith('/api/auth/photos/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const id = decodeURIComponent(path.slice('/api/auth/photos/'.length));
        const row = await env.DB.prepare(
          'SELECT object_key FROM user_photos WHERE id = ? AND user_id = ?',
        )
          .bind(id, user.id)
          .first<{ object_key: string }>();
        if (!row) return err('不存在', 404, cors);
        // The object first: a row without its file is a broken thumbnail, a
        // file without its row is content the user believes they deleted.
        if (env.PHOTOS) await env.PHOTOS.delete(row.object_key);
        await env.DB.prepare('DELETE FROM user_photos WHERE id = ? AND user_id = ?')
          .bind(id, user.id)
          .run();
        return json({ ok: true }, 200, cors);
      }

      // ── Settings sync ──
      //
      // Namespaced JSON blobs. The server never interprets the payload; it
      // stores it and owns the version. That keeps a settings change from
      // needing a migration, and it is why the API-key exclusion has to be
      // enforced on the client — the server cannot tell what it is holding.
      //
      // The version is optimistic-concurrency, not decoration: a mismatch
      // means another device wrote first, and the client is told rather than
      // silently overwritten with a value that may be days old.
      if (path.startsWith('/api/auth/settings/') && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const namespace = decodeURIComponent(path.slice('/api/auth/settings/'.length));
        const row = await env.DB.prepare(
          'SELECT payload, version, updated_at FROM user_settings WHERE user_id = ? AND namespace = ?',
        )
          .bind(user.id, namespace)
          .first<{ payload: string; version: number; updated_at: number }>();
        if (!row) return json({ payload: null, version: 0 }, 200, cors);
        return json(
          { payload: JSON.parse(row.payload), version: row.version, updatedAt: row.updated_at },
          200,
          cors,
        );
      }

      if (path.startsWith('/api/auth/settings/') && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const namespace = decodeURIComponent(path.slice('/api/auth/settings/'.length));
        const body = (await request.json()) as { payload?: unknown; version?: number };
        if (body.payload === undefined) return err('缺少 payload', 400, cors);

        const now = Date.now();
        const current = await env.DB.prepare(
          'SELECT version FROM user_settings WHERE user_id = ? AND namespace = ?',
        )
          .bind(user.id, namespace)
          .first<{ version: number }>();
        const currentVersion = current?.version ?? 0;
        // A client that did not send a version is doing a first push; one that
        // did must match, or it is writing over something it never saw.
        if (body.version !== undefined && body.version !== currentVersion) {
          return json({ error: '版本冲突', version: currentVersion }, 409, cors);
        }
        const nextVersion = currentVersion + 1;
        await env.DB.prepare(
          `INSERT INTO user_settings (user_id, namespace, payload, version, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, namespace)
           DO UPDATE SET payload = excluded.payload, version = excluded.version, updated_at = excluded.updated_at`,
        )
          .bind(user.id, namespace, JSON.stringify(body.payload), nextVersion, now)
          .run();
        return json({ version: nextVersion, updatedAt: now }, 200, cors);
      }

      // ── Content library (waveforms / scenes) ──
      //
      // One row per item rather than one blob per library: when two devices
      // each add something, a whole-library blob can only keep one of them.
      //
      // `since` makes the pull incremental, and deletions come back as
      // tombstones — a hard delete would let the item reappear the next time
      // a device that had not synced pushed its own full list.
      if (path === '/api/auth/content' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const kind = url.searchParams.get('kind') ?? '';
        const since = Number(url.searchParams.get('since') ?? '0') || 0;
        const rows = await env.DB.prepare(
          `SELECT id, kind, name, payload, created_at, updated_at, deleted_at
             FROM user_content
            WHERE user_id = ? AND (? = '' OR kind = ?) AND updated_at > ?
            ORDER BY updated_at ASC
            LIMIT 500`,
        )
          .bind(user.id, kind, kind, since)
          .all();
        return json(
          {
            items: (rows.results ?? []).map((r) => {
              const row = r as Record<string, unknown>;
              return {
                id: row.id,
                kind: row.kind,
                name: row.name,
                payload: JSON.parse(String(row.payload)),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                deleted: row.deleted_at != null,
              };
            }),
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/content' && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json()) as {
          items?: { id: string; kind: string; name: string; payload: unknown; deleted?: boolean }[];
        };
        const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
        if (items.length === 0) return json({ ok: true, written: 0 }, 200, cors);

        const now = Date.now();
        const statements = items.map((item) =>
          env.DB.prepare(
            `INSERT INTO user_content (id, user_id, kind, name, payload, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, id)
             DO UPDATE SET name = excluded.name, payload = excluded.payload,
                           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
          ).bind(
            String(item.id),
            user.id,
            String(item.kind),
            String(item.name ?? '').slice(0, 200),
            JSON.stringify(item.payload ?? null),
            now,
            now,
            item.deleted ? now : null,
          ),
        );
        await env.DB.batch(statements);
        return json({ ok: true, written: items.length, updatedAt: now }, 200, cors);
      }

      // ── Market ownership ──
      //
      // The item itself lives in Market's own D1, in another Worker. This
      // only records who claimed what, so "things I uploaded" survives losing
      // the anonymous edit key that Market issues per device.
      if (path === '/api/auth/market-claims' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const rows = await env.DB.prepare(
          'SELECT item_id, claimed_at FROM market_claims WHERE user_id = ? ORDER BY claimed_at DESC LIMIT 500',
        )
          .bind(user.id)
          .all();
        return json({ claims: rows.results ?? [] }, 200, cors);
      }

      if (path === '/api/auth/market-claims' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json()) as { itemId?: string; editKeyHash?: string };
        if (!body.itemId) return err('缺少 itemId', 400, cors);
        // First claim wins. Re-claiming someone else's item must not be a way
        // to take it over; Market's edit key stays the authority on editing.
        await env.DB.prepare(
          `INSERT INTO market_claims (item_id, user_id, edit_key_hash, claimed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (item_id) DO NOTHING`,
        )
          .bind(String(body.itemId), user.id, body.editKeyHash ?? null, Date.now())
          .run();
        return json({ ok: true }, 200, cors);
      }

      // ── Contacts ──
      //
      // Following is directional; a "contact" is both directions existing. See
      // 0004_contacts.sql for why there is no friendship table.
      //
      // Three rules are enforced here rather than in the UI, because the UI is
      // not the only caller and never will be: you cannot follow yourself,
      // following someone who blocked you fails, and blocking removes the
      // follow in both directions. Anything checked only in the client is a
      // rule that holds until somebody uses curl.
      if (path === '/api/auth/follow' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const targetId = typeof body.userId === 'string' ? body.userId : '';
        if (!targetId) return err('缺少 userId', 400, cors);
        if (targetId === user.id) return err('不能关注自己', 400, cors);

        const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
          .bind(targetId)
          .first<{ id: string }>();
        if (!target) return err('用户不存在', 404, cors);

        const blocks = await env.DB.prepare(
          `SELECT blocker_id FROM user_blocks
            WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        )
          .bind(user.id, targetId, targetId, user.id)
          .all();
        const blockRows = (blocks.results ?? []) as { blocker_id: string }[];
        if (blockRows.some((r) => r.blocker_id === user.id)) {
          // The user's own block, so saying so plainly is useful rather than a leak.
          return err('你已拉黑该用户，请先解除拉黑', 400, cors);
        }
        if (blockRows.length > 0) {
          // Blocked by the target. Deliberately the same answer as a nonexistent
          // user: confirming "you have been blocked" tells someone exactly who to
          // go after, and in this product that means targeted harassment. It also
          // keeps the block from being usable as a presence probe.
          return err('用户不存在', 404, cors);
        }

        await env.DB.prepare(
          `INSERT INTO user_follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        )
          .bind(user.id, targetId, Date.now())
          .run();

        return json({ ok: true, mutual: await follows(env, targetId, user.id) }, 200, cors);
      }

      // Idempotent: "I do not follow this person" is equally true whether or not a
      // row was there, so a repeat unfollow is a success, not a 404.
      if (path.startsWith('/api/auth/follow/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const targetId = decodeURIComponent(path.slice('/api/auth/follow/'.length));
        await env.DB.prepare('DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?')
          .bind(user.id, targetId)
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (
        (path === '/api/auth/following' || path === '/api/auth/followers') &&
        request.method === 'GET'
      ) {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const { limit, offset } = pageParams(url);
        const rows = await env.DB.prepare(
          contactListSql(path === '/api/auth/following' ? 'following' : 'followers'),
        )
          .bind(user.id, limit, offset)
          .all();
        const users = (rows.results ?? []).map((r) => contactRow(r as Record<string, unknown>));
        return json(
          // A short page means the end of the list; no extra count query, and no
          // total either — a follower count is a number people scrape.
          { users, nextOffset: users.length === limit ? offset + limit : null },
          200,
          cors,
        );
      }

      if (path === '/api/auth/block' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const targetId = typeof body.userId === 'string' ? body.userId : '';
        if (!targetId) return err('缺少 userId', 400, cors);
        if (targetId === user.id) return err('不能拉黑自己', 400, cors);

        const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
          .bind(targetId)
          .first<{ id: string }>();
        if (!target) return err('用户不存在', 404, cors);

        // The block goes in first, then the follows come out. If the second
        // statement fails, the block is already in force and the read paths filter
        // the stale follow anyway. The other order would leave a window with the
        // follows gone and no block — the user gets the weaker half of what they
        // asked for and no error to explain it.
        await env.DB.prepare(
          `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        )
          .bind(user.id, targetId, Date.now())
          .run();
        await env.DB.prepare(
          `DELETE FROM user_follows
            WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)`,
        )
          .bind(user.id, targetId, targetId, user.id)
          .run();

        return json({ ok: true }, 200, cors);
      }

      // Unblocking does not restore the follows the block removed — they were
      // deleted by an intentional act, and bringing one back silently is a worse
      // surprise than having to follow again.
      if (path.startsWith('/api/auth/block/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const targetId = decodeURIComponent(path.slice('/api/auth/block/'.length));
        await env.DB.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?')
          .bind(user.id, targetId)
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (path === '/api/auth/blocks' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const rows = await env.DB.prepare(
          `SELECT u.id, u.username, u.display_name, b.created_at AS blocked_at
             FROM user_blocks b JOIN users u ON u.id = b.blocked_id
            WHERE b.blocker_id = ?
            ORDER BY b.created_at DESC
            LIMIT ?`,
        )
          .bind(user.id, MAX_BLOCKS)
          .all();
        return json(
          {
            users: (rows.results ?? []).map((r) => {
              const row = r as Record<string, unknown>;
              return {
                id: String(row.id),
                username: String(row.username),
                displayName: String(row.display_name),
                blockedAt: Number(row.blocked_at),
              };
            }),
          },
          200,
          cors,
        );
      }

      // ── Another user's public view ──
      //
      // Looked up by username because that is the only handle a person can type;
      // it goes in the path, never a query string.
      //
      // `user_profiles.visibility` decides the profile body and it is honoured
      // literally: private means nobody but the owner, following or not. Following
      // someone is not a grant of access to them — treating it as one would mean a
      // profile silently becomes visible to whoever presses a button.
      //
      // What a private profile still returns is the identity that was already
      // public: the username the caller just typed, and the display name attached
      // to it. Without that there is no way to confirm you found the right person
      // before following them, and the username was never the secret.
      if (path.startsWith('/api/auth/users/') && request.method === 'GET') {
        // Signed-out callers are allowed here; the account is optional and a public
        // profile is public. What they cannot get is any relationship state, and a
        // block cannot apply to a viewer with no identity.
        const viewer = await currentUser(request, env);
        const username = decodeURIComponent(path.slice('/api/auth/users/'.length)).toLowerCase();
        if (!username) return err('用户不存在', 404, cors);

        const target = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
          .bind(username)
          .first<UserRow>();
        if (!target) return err('用户不存在', 404, cors);

        const isSelf = viewer?.id === target.id;
        if (viewer && !isSelf && (await blockedBetween(env, viewer.id, target.id))) {
          return err('用户不存在', 404, cors);
        }

        const row = await env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?')
          .bind(target.id)
          .first<Record<string, unknown>>();
        const profile = row ? publicProfile(row) : null;
        const visible = isSelf || profile?.visibility === 'public';

        // The birth date never leaves its owner's own view. The profile editor
        // tells users in so many words that it is collected to confirm they are
        // an adult and that the date itself is not shown — marking a profile
        // public is consent to the bio and the region, not to that. A promise
        // made in the UI has to be kept by the endpoint, or it is not a promise.
        const shown =
          !visible || !profile ? null : isSelf ? profile : { ...profile, birthDate: null };

        const [following, followedBy] =
          viewer && !isSelf
            ? await Promise.all([
                follows(env, viewer.id, target.id),
                follows(env, target.id, viewer.id),
              ])
            : [false, false];

        return json({ user: publicUser(target), profile: shown, following, followedBy }, 200, cors);
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
