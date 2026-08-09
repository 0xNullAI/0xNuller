import { hashPassword, verifyPassword } from './password';
import { DM_DIGEST_MAX_ROOMS, DM_TICKET_TTL_MS, dmRoomCode, signDmTicket } from './dm-ticket';

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

export interface Env extends Cloudflare.Env {
  /**
   * Pepper for ip_hash. Kept separate from every other use — it must never be
   * rotated, or every rate-limit record becomes worthless.
   */
  IP_PEPPER: string;
  /**
   * Signing key for direct-message tickets, shared with Chat's Worker.
   *
   * Optional so a deployment without it answers 503 on DM endpoints instead of
   * failing unrelated account features. **It must never be rotated** —
   * the conversation id is keyed with it, so a new value moves every conversation
   * to a different Durable Object and orphans its history. See dm-ticket.ts.
   */
  DM_TICKET_SECRET?: string;
  /**
   * Chat's Worker, for pushing a revocation when a block severs a conversation.
   *
   * This is the *only* thing this service ever asks of another Worker, and it is a
   * push rather than a pull on purpose: this service owns the fact that two people
   * may no longer talk, so it owns delivering the consequence. Optional, and a
   * failure here is swallowed — a block that cannot reach Chat still removes the
   * follows, which stops the next ticket from being minted, so the conversation
   * dies within the ticket TTL instead of instantly.
   */
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
/** Album ceiling on a profile view. The editor pages its own list separately. */
const MAX_ALBUM_PHOTOS = 60;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_CAPTION = 200;
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const CONTENT_PAGE_SIZE = 500;
const CONTENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SYNC_NAMESPACES = new Set(['llm', 'device-safety', 'proxy', 'ui']);
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_CONTENT_PAYLOAD_BYTES = 512 * 1024;

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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    // Authorization must be on the allowlist: leave it out and the browser blocks
    // the request outright at the preflight stage, which shows up as "the request
    // never even went out" rather than a catchable 401.
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Photo-Caption,X-Photo-Visibility',
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

async function readBodyBounded(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

/** Delete every object under a prefix without reusing a cursor after mutating the listing. */
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  while (true) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    if (listed.objects.length === 0) return;
    await bucket.delete(listed.objects.map((o) => o.key));
  }
}

interface ContentCursor {
  updatedAt: number;
  id: string;
}

function encodeContentCursor(cursor: ContentCursor): string {
  return btoa(JSON.stringify([cursor.updatedAt, cursor.id]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeContentCursor(value: string | null): ContentCursor | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const updatedAt = Number(parsed[0]);
    const id = parsed[1];
    return Number.isSafeInteger(updatedAt) && updatedAt >= 0 && typeof id === 'string'
      ? { updatedAt, id }
      : null;
  } catch {
    return null;
  }
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
  created_at: number;
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
 * Follower / following counts for one user.
 *
 * `column` is chosen here from a closed pair of identifiers, never from request
 * input: counting rows where the user is the followee gives their followers,
 * and where they are the follower gives who they follow.
 *
 * No block filter, unlike contactListSql. Blocking deletes the follow rows in
 * both directions, so a block and a follow cannot coexist to begin with; the
 * NOT EXISTS over there is defence for a list that would otherwise show a
 * blocked person by name, which a bare number cannot do.
 */
async function countFollows(
  env: Env,
  column: 'follower_id' | 'followee_id',
  userId: string,
): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM user_follows WHERE ${column} = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * The album as somebody else may see it.
 *
 * Per-photo visibility is a second gate **inside** an already-visible profile,
 * not an alternative to it — the caller checks the profile first. The owner
 * sees their own private photos here so the editor and the public view read
 * from one place and cannot disagree about what exists.
 *
 * No R2 bucket is bound yet, so in practice this returns an empty list: there
 * is no upload path, therefore no rows. The gating is written now because it is
 * the part that fails silently later, when uploads land and nobody re-derives
 * who was supposed to see what.
 */
async function visiblePhotos(env: Env, userId: string, isSelf: boolean): Promise<unknown[]> {
  const rows = await env.DB.prepare(
    `SELECT id, caption, visibility, created_at FROM user_photos
      WHERE user_id = ?${isSelf ? '' : " AND visibility = 'public'"}
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, MAX_ALBUM_PHOTOS)
    .all();
  return (rows.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      caption: (row.caption as string | null) ?? null,
      visibility: row.visibility === 'public' ? 'public' : 'private',
      createdAt: Number(row.created_at),
      // The object key never leaves the server. It is an R2 path, and handing
      // it out would let anyone who learns the bucket's layout guess at
      // neighbouring keys; the id is the only handle a client needs.
      url: `/api/auth/photos/${encodeURIComponent(String(row.id))}/content`,
    };
  });
}

/**
 * The admission rule for a direct message: both follow rows exist.
 *
 * A one-way follow is deliberately not enough. Following someone is a decision one
 * person makes about the other's posts; being messageable is a decision about who
 * may reach you, and only both directions express that both people agreed. In this
 * product an inbox anyone can write to is an open harassment channel, and it cannot
 * be closed again afterwards — the messages have already been read.
 *
 * Blocks are not consulted here because they cannot survive one: blocking deletes
 * the follows in both directions, so a blocked pair is never mutual. The callers
 * still check separately, to answer with the right status.
 */
async function mutualFollow(env: Env, a: string, b: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM user_follows f
      WHERE f.follower_id = ? AND f.followee_id = ?
        AND EXISTS (SELECT 1 FROM user_follows m
                     WHERE m.follower_id = f.followee_id AND m.followee_id = f.follower_id)`,
  )
    .bind(a, b)
    .first();
  return row != null;
}

/**
 * Tell Chat that a conversation is over.
 *
 * Deleting the follows already stops the *next* ticket from being minted, so a
 * blocked pair cannot reconnect once the one in flight expires. This closes the
 * gap in between: the sockets that are open right now, and the ticket somebody is
 * still holding. Without it, blocking someone mid-conversation would let them keep
 * reading and writing for as long as their tab stayed open, which is the "gone
 * means hidden" that 0004_contacts.sql refuses.
 *
 * Best effort on purpose. If Chat is unreachable the block still took effect here,
 * and the conversation dies when the ticket expires instead of instantly — a
 * degraded outcome, not a wrong one, and far better than failing the block itself
 * because a different Worker had a bad minute.
 *
 * Skipped entirely when the two never opened a conversation, so unfollowing
 * somebody you have never messaged does not create a Durable Object to tell it that
 * nothing is happening.
 */
async function severDm(env: Env, a: string, b: string): Promise<void> {
  const secret = env.DM_TICKET_SECRET;
  if (!secret || !env.CHAT) return;
  try {
    const thread = await env.DB.prepare(
      'SELECT 1 FROM dm_threads WHERE user_id = ? AND peer_id = ?',
    )
      .bind(a, b)
      .first();
    if (!thread) return;
    const now = Date.now();
    const token = await signDmTicket(secret, {
      aud: 'revoke',
      sub: a,
      room: await dmRoomCode(secret, a, b),
      iat: now,
      exp: now + DM_TICKET_TTL_MS,
    });
    // The hostname is ignored by a service binding; the path is what routes.
    await env.CHAT.fetch('https://chat.internal/api/dm/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    /* see above: the block stands either way */
  }
}

/** Remember that these two have a conversation, from both sides — see 0005_dm_threads.sql. */
async function rememberDmThread(env: Env, a: string, b: string, now: number): Promise<void> {
  const insert = (user: string, peer: string) =>
    env.DB.prepare(
      `INSERT INTO dm_threads (user_id, peer_id, started_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, peer_id) DO NOTHING`,
    )
      .bind(user, peer, now)
      .run();
  await insert(a, b);
  await insert(b, a);
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
      if (path === '/api/auth/photos' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);

        const mime = (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim();
        if (!ALLOWED_PHOTO_TYPES.has(mime)) return err('不支持的图片格式', 415, cors);
        const count = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM user_photos WHERE user_id = ?',
        )
          .bind(user.id)
          .first<{ n: number }>();
        if (Number(count?.n ?? 0) >= MAX_ALBUM_PHOTOS) return err('相册已达到上限', 409, cors);

        const bytes = await readBodyBounded(request, MAX_PHOTO_BYTES);
        if (bytes == null) return err('图片过大', 413, cors);
        if (bytes.byteLength === 0) return err('图片为空', 400, cors);

        const id = crypto.randomUUID();
        const objectKey = `users/${user.id}/photos/${id}`;
        let caption = '';
        try {
          caption = decodeURIComponent(request.headers.get('x-photo-caption') ?? '')
            .trim()
            .slice(0, MAX_PHOTO_CAPTION);
        } catch {
          return err('照片说明编码无效', 400, cors);
        }
        const visibility =
          request.headers.get('x-photo-visibility') === 'public' ? 'public' : 'private';
        const createdAt = Date.now();

        await env.PHOTOS.put(objectKey, bytes, { httpMetadata: { contentType: mime } });
        try {
          await env.DB.prepare(
            `INSERT INTO user_photos (id, user_id, object_key, caption, visibility, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
            .bind(id, user.id, objectKey, caption || null, visibility, createdAt)
            .run();
        } catch (error) {
          // Compensate the object write: a failed row insert must not create an R2 orphan.
          await env.PHOTOS.delete(objectKey);
          throw error;
        }
        return json(
          {
            photo: {
              id,
              caption: caption || null,
              visibility,
              createdAt,
              url: `/api/auth/photos/${encodeURIComponent(id)}/content`,
            },
          },
          201,
          cors,
        );
      }

      if (path === '/api/auth/photos' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        return json({ photos: await visiblePhotos(env, user.id, true) }, 200, cors);
      }

      /**
       * Serve one photo's bytes.
       *
       * The gate is re-derived here from scratch rather than trusting that the
       * caller got this URL from a profile they were allowed to see. URLs get
       * copied, pasted and kept after a profile is switched back to private,
       * so the only safe assumption is that whoever is asking found the id
       * somewhere else.
       *
       * Every refusal is the same 404. "Exists but you may not see it" would
       * confirm the photo — and by extension the account and its activity —
       * to precisely the person the owner shut out.
       */
      if (
        path.startsWith('/api/auth/photos/') &&
        path.endsWith('/content') &&
        request.method === 'GET'
      ) {
        const id = decodeURIComponent(path.slice('/api/auth/photos/'.length, -'/content'.length));
        const photo = await env.DB.prepare(
          'SELECT user_id, object_key, visibility FROM user_photos WHERE id = ?',
        )
          .bind(id)
          .first<{ user_id: string; object_key: string; visibility: string }>();
        if (!photo) return err('不存在', 404, cors);

        const viewer = await currentUser(request, env);
        const isOwner = viewer?.id === photo.user_id;
        if (!isOwner) {
          if (photo.visibility !== 'public') return err('不存在', 404, cors);
          if (viewer && (await blockedBetween(env, viewer.id, photo.user_id))) {
            return err('不存在', 404, cors);
          }
          // The owning profile has to be public too. A public photo inside a
          // profile its owner has since made private is not public any more.
          const owner = await env.DB.prepare(
            'SELECT visibility FROM user_profiles WHERE user_id = ?',
          )
            .bind(photo.user_id)
            .first<{ visibility: string }>();
          if (owner?.visibility !== 'public') return err('不存在', 404, cors);
        }

        const object = await env.PHOTOS.get(photo.object_key);
        if (!object) return err('不存在', 404, cors);
        return new Response(object.body, {
          headers: {
            ...cors,
            'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
            // Private so shared caches never hold a photo that a block or a
            // visibility change should have taken away.
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          },
        });
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
        await env.PHOTOS.delete(row.object_key);
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
        if (!SYNC_NAMESPACES.has(namespace)) return err('同步命名空间不存在', 404, cors);
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
        if (!SYNC_NAMESPACES.has(namespace)) return err('同步命名空间不存在', 404, cors);
        const body = (await request.json()) as { payload?: unknown; version?: number };
        if (body.payload === undefined) return err('缺少 payload', 400, cors);
        const encodedPayload = JSON.stringify(body.payload);
        if (new TextEncoder().encode(encodedPayload).byteLength > MAX_SETTINGS_BYTES) {
          return err('同步设置过大', 413, cors);
        }

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
          .bind(user.id, namespace, encodedPayload, nextVersion, now)
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
        if (kind && kind !== 'waveform' && kind !== 'scene') {
          return err('内容类型不存在', 400, cors);
        }
        const since = Number(url.searchParams.get('since') ?? '0') || 0;
        const rawCursor = url.searchParams.get('cursor');
        const cursor = decodeContentCursor(rawCursor);
        if (rawCursor && !cursor) return err('同步游标无效', 400, cors);
        const afterUpdatedAt = cursor?.updatedAt ?? Math.max(0, Math.trunc(since));
        const afterId = cursor?.id ?? '';
        const select = `SELECT id, kind, name, payload, created_at, updated_at, deleted_at
                          FROM user_content`;
        const rows = kind
          ? await env.DB.prepare(
              `${select}
                WHERE user_id = ? AND kind = ?
                  AND (updated_at > ? OR (updated_at = ? AND id > ?))
                ORDER BY updated_at ASC, id ASC
                LIMIT ?`,
            )
              .bind(user.id, kind, afterUpdatedAt, afterUpdatedAt, afterId, CONTENT_PAGE_SIZE)
              .all()
          : await env.DB.prepare(
              `${select}
                WHERE user_id = ?
                  AND (updated_at > ? OR (updated_at = ? AND id > ?))
                ORDER BY updated_at ASC, id ASC
                LIMIT ?`,
            )
              .bind(user.id, afterUpdatedAt, afterUpdatedAt, afterId, CONTENT_PAGE_SIZE)
              .all();
        const resultRows = rows.results ?? [];
        const last = resultRows.at(-1) as Record<string, unknown> | undefined;
        return json(
          {
            items: resultRows.map((r) => {
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
            nextCursor:
              resultRows.length === CONTENT_PAGE_SIZE && last
                ? encodeContentCursor({ updatedAt: Number(last.updated_at), id: String(last.id) })
                : null,
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

        for (const item of items) {
          if (!CONTENT_ID.test(String(item.id ?? ''))) return err('内容 id 无效', 400, cors);
          if (item.kind !== 'waveform' && item.kind !== 'scene') {
            return err('内容类型不存在', 400, cors);
          }
          if (!String(item.name ?? '').trim()) return err('内容名称不能为空', 400, cors);
          const payload = JSON.stringify(item.payload ?? null);
          if (new TextEncoder().encode(payload).byteLength > MAX_CONTENT_PAYLOAD_BYTES) {
            return err('内容数据过大', 413, cors);
          }
        }

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
            item.kind,
            String(item.name).trim().slice(0, 200),
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
        // The pair is no longer mutual, so it may no longer be talking. Unfollowing is a
        // milder act than blocking and the conversation is kept — it reappears if the follow
        // does — but a live socket has to close, or "mutual follow is required" would only be
        // true of conversations that had not started yet.
        await severDm(env, user.id, targetId);
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

        // A block has to end the conversation, not hide it. The order matters: the push goes
        // out while the thread row still exists (severDm reads it to avoid waking a Durable
        // Object for two people who never spoke), and the row goes afterwards so the
        // conversation leaves both sidebars.
        await severDm(env, user.id, targetId);
        await env.DB.prepare(
          `DELETE FROM dm_threads
            WHERE (user_id = ? AND peer_id = ?) OR (user_id = ? AND peer_id = ?)`,
        )
          .bind(user.id, targetId, targetId, user.id)
          .run();

        return json({ ok: true }, 200, cors);
      }

      // ── Direct messages ──
      //
      // A DM is a two-person conversation living in Chat's Durable Object, addressed by an id
      // derived from the two account ids. This service never sees a message; what it owns is
      // the question Chat cannot answer — may these two talk at all — and the only thing it
      // hands over is a signed, short-lived statement that they may.
      //
      // Accounts are optional everywhere else in this product and deliberately required here.
      // A group can be anonymous because you chose to walk into it; "who is allowed to message
      // me" is a question only an account can hold an answer to.
      if (path === '/api/auth/dm/ticket' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const secret = env.DM_TICKET_SECRET;
        if (!secret) return err('私聊尚未启用', 503, cors);

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const targetId = typeof body.userId === 'string' ? body.userId : '';
        if (!targetId) return err('缺少 userId', 400, cors);
        if (targetId === user.id) return err('不能和自己私聊', 400, cors);

        const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
          .bind(targetId)
          .first<{ id: string }>();
        // Same answer for "no such account" and "one of you blocked the other", for the same
        // reason the follow endpoint gives: a distinguishable answer turns a block into a way
        // to confirm you found the right person to go after.
        if (!target || (await blockedBetween(env, user.id, targetId))) {
          return err('用户不存在', 404, cors);
        }
        if (!(await mutualFollow(env, user.id, targetId))) {
          return err('需要互相关注才能私聊', 403, cors);
        }

        const now = Date.now();
        const room = await dmRoomCode(secret, user.id, targetId);
        const ticket = await signDmTicket(secret, {
          aud: 'dm',
          sub: user.id,
          peer: targetId,
          room,
          iat: now,
          exp: now + DM_TICKET_TTL_MS,
        });
        // Minting is the moment a conversation starts existing, and it is recorded for both
        // sides: the person being written to has to find the conversation in their own list
        // without having done anything first.
        await rememberDmThread(env, user.id, targetId, now);
        return json({ ticket, room, expiresAt: now + DM_TICKET_TTL_MS }, 200, cors);
      }

      // The DM list, re-authorized on every read rather than cached anywhere: a conversation
      // whose follow went away simply stops being returned, so the sidebar cannot outlive the
      // permission behind it. The digest ticket is what lets Chat answer unread counts for
      // exactly these conversations and no others.
      if (path === '/api/auth/dm/conversations' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const secret = env.DM_TICKET_SECRET;
        if (!secret) return err('私聊尚未启用', 503, cors);

        const rows = await env.DB.prepare(
          `SELECT u.id, u.username, u.display_name, t.started_at
             FROM dm_threads t
             JOIN users u ON u.id = t.peer_id
            WHERE t.user_id = ?
              AND EXISTS (SELECT 1 FROM user_follows f
                           WHERE f.follower_id = t.user_id AND f.followee_id = t.peer_id)
              AND EXISTS (SELECT 1 FROM user_follows f
                           WHERE f.follower_id = t.peer_id AND f.followee_id = t.user_id)
              AND NOT EXISTS (SELECT 1 FROM user_blocks x
                               WHERE (x.blocker_id = t.user_id AND x.blocked_id = t.peer_id)
                                  OR (x.blocker_id = t.peer_id AND x.blocked_id = t.user_id))
            ORDER BY t.started_at DESC
            LIMIT ?`,
        )
          .bind(user.id, DM_DIGEST_MAX_ROOMS)
          .all();

        const now = Date.now();
        const conversations = await Promise.all(
          (rows.results ?? []).map(async (r) => {
            const row = r as Record<string, unknown>;
            const id = String(row.id);
            return {
              id,
              username: String(row.username),
              displayName: String(row.display_name),
              startedAt: Number(row.started_at),
              room: await dmRoomCode(secret, user.id, id),
            };
          }),
        );
        const ticket = await signDmTicket(secret, {
          aud: 'digest',
          sub: user.id,
          rooms: conversations.map((c) => c.room),
          iat: now,
          exp: now + DM_TICKET_TTL_MS,
        });
        return json({ conversations, ticket, expiresAt: now + DM_TICKET_TTL_MS }, 200, cors);
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

        // Everything below is gated on the same `visible` flag as the profile
        // body. Follower counts and a join date are not identity — they are
        // profile content, and a private profile that still reported "312
        // followers, joined 2023" would be leaking exactly the presence and
        // popularity signals it was set to private to withhold. Counts also
        // make a private account probe-able: watching the number move tells
        // you who just followed them.
        const [followerCount, followingCount] = visible
          ? await Promise.all([
              countFollows(env, 'followee_id', target.id),
              countFollows(env, 'follower_id', target.id),
            ])
          : [0, 0];

        // Only the owner's public photos, and only on a visible profile — a
        // per-photo visibility of 'public' inside a private profile is still
        // inside a private profile.
        const photos = visible ? await visiblePhotos(env, target.id, isSelf) : [];

        return json(
          {
            user: publicUser(target),
            profile: shown,
            following,
            followedBy,
            // null rather than 0: the client has to be able to tell "not
            // allowed to know" from "nobody follows them", or it will render a
            // confident zero for a profile it cannot see.
            counts: visible ? { followers: followerCount, following: followingCount } : null,
            createdAt: visible ? Number(target.created_at) : null,
            photos,
          },
          200,
          cors,
        );
      }

      // ── Delete account ──
      // Users in this category are extremely sensitive about whether the data is
      // really gone, so this is a hard delete rather than a flag, and sessions has
      // ON DELETE CASCADE so every device is logged out immediately.
      if (path === '/api/auth/account' && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        // Delete the whole prefix, not only rows D1 still knows about: a previously
        // compensated/failed write may have left an object without a row. R2 first,
        // so a bucket failure leaves the account retryable instead of orphaning bytes.
        await deleteR2Prefix(env.PHOTOS, `users/${user.id}/photos/`);
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
        return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
      }

      return err('接口不存在', 404, cors);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'auth_request_failed',
          method: request.method,
          path,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return err('服务器错误', 500, cors);
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const now = Date.now();
    const keepLoginAttemptsAfter = now - 24 * 60 * 60 * 1000;
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
        env.DB.prepare('DELETE FROM login_attempts WHERE created_at < ?').bind(
          keepLoginAttemptsAfter,
        ),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
