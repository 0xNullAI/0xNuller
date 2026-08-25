import { hashPassword } from './password';
import {
  DM_DIGEST_MAX_ROOMS,
  DM_TICKET_TTL_MS,
  dmRoomCode,
  signDmTicket,
  verifyDmTicket,
} from './dm-ticket';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { registrationConflict, validateCredentials } from './account-validation';
import { decodeContentCursor, encodeContentCursor } from './content-cursor';
import { corsHeaders, err, json, readBodyBounded } from './http';
import { sessionCookie } from './session-credentials';
import {
  currentUser,
  login,
  logout,
  newToken,
  publicUser,
  sessionUser,
  sha256Hex,
  type UserRow,
} from './session-domain';

export { registrationConflict } from './account-validation';

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
 * 3. **New accounts require an email address.** It is normalized and reserved for
 *    the recovery flow; existing accounts created before this rule remain valid.
 */

export interface Env extends Cloudflare.Env {
  EMAIL: SendEmail;
  /**
   * Pepper for ip_hash. Kept separate from every other use — it must never be
   * rotated, or every rate-limit record becomes worthless.
   */
  IP_PEPPER: string;
  /**
   * Signing key for direct-message tickets, shared with Chat's Worker.
   *
   * Deployment is blocked when this is absent. **It must never be rotated** —
   * the conversation id is keyed with it, so a new value moves every conversation
   * to a different Durable Object and orphans its history. See dm-ticket.ts.
   */
  DM_TICKET_SECRET: string;
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
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS_PER_IP = 5;
const MIN_PASSWORD_LEN = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 30 * 60 * 1000;
const EMAIL_ACTION_COOLDOWN_MS = 60 * 1000;
const VOICE_TICKET_TTL_MS = 25 * 60 * 1000;

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
const STALE_PHOTO_UPLOAD_MS = 60 * 60 * 1000;
const MAINTENANCE_BATCH_SIZE = 100;
const ACCOUNT_DELETION_BATCH_SIZE = 25;
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const CONTENT_PAGE_SIZE = 500;
const CONTENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SYNC_NAMESPACES = new Set(['llm', 'device-safety', 'proxy', 'ui']);
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_CONTENT_PAYLOAD_BYTES = 512 * 1024;
const MAX_AGENT_SESSION_BYTES = 2 * 1024 * 1024;
const AGENT_SESSION_PAGE_SIZE = 200;
const CHAT_ROOM_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CHAT_ROOM_NAME = 80;

/** Delete every object under a prefix without reusing a cursor after mutating the listing. */
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  while (true) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    if (listed.objects.length === 0) return;
    await bucket.delete(listed.objects.map((o) => o.key));
  }
}

interface PendingPhotoRow {
  id: string;
  object_key: string;
}

/** R2 first, row second: a failed delete always leaves a durable retry record. */
async function cleanupPendingPhoto(env: Env, row: PendingPhotoRow): Promise<void> {
  await env.PHOTOS.delete(row.object_key);
  await env.DB.prepare("DELETE FROM user_photos WHERE id = ? AND status = 'uploading'")
    .bind(row.id)
    .run();
}

async function reservePhotoSlot(
  env: Env,
  params: {
    id: string;
    userId: string;
    objectKey: string;
    caption: string | null;
    visibility: 'public' | 'private';
    purpose: 'album' | 'avatar';
    createdAt: number;
  },
): Promise<boolean> {
  await env.DB.prepare(
    `WITH RECURSIVE slots(slot) AS (
       VALUES(0) UNION ALL SELECT slot + 1 FROM slots WHERE slot < 59
     )
     INSERT INTO user_photos
       (id, user_id, object_key, caption, visibility, purpose, created_at, slot, status)
     SELECT ?, ?, ?, ?, ?, ?, ?, slots.slot, 'uploading'
       FROM slots
      WHERE NOT EXISTS (
              SELECT 1 FROM user_photos p WHERE p.user_id = ? AND p.slot = slots.slot
            )
        AND NOT EXISTS (
              SELECT 1 FROM account_deletions d WHERE d.user_id = ?
            )
      ORDER BY slots.slot
      LIMIT 1`,
  )
    .bind(
      params.id,
      params.userId,
      params.objectKey,
      params.caption,
      params.visibility,
      params.purpose,
      params.createdAt,
      params.userId,
      params.userId,
    )
    .run();
  return (
    (await env.DB.prepare("SELECT 1 FROM user_photos WHERE id = ? AND status = 'uploading'")
      .bind(params.id)
      .first()) != null
  );
}

async function finishPhotoUpload(env: Env, id: string, userId: string): Promise<boolean> {
  await env.DB.prepare(
    `UPDATE user_photos SET status = 'ready'
      WHERE id = ? AND user_id = ? AND status = 'uploading'
        AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = ?)`,
  )
    .bind(id, userId, userId)
    .run();
  return (
    (await env.DB.prepare("SELECT 1 FROM user_photos WHERE id = ? AND status = 'ready'")
      .bind(id)
      .first()) != null
  );
}

async function finalizeAccountDeletion(env: Env, userId: string): Promise<void> {
  await deleteR2Prefix(env.PHOTOS, `users/${userId}/photos/`);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

async function recordDeletionFailure(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_deletions
        SET attempts = attempts + 1, last_error_at = ?
      WHERE user_id = ?`,
  )
    .bind(Date.now(), userId)
    .run();
}

/** Exported for deterministic local tests; production calls it from the daily cron. */
export async function runAuthMaintenance(env: Env, now = Date.now()): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT id, object_key FROM user_photos
      WHERE status = 'uploading' AND created_at < ?
      ORDER BY created_at, id LIMIT ?`,
  )
    .bind(now - STALE_PHOTO_UPLOAD_MS, MAINTENANCE_BATCH_SIZE)
    .all<PendingPhotoRow>();
  for (const row of stale.results ?? []) {
    try {
      await cleanupPendingPhoto(env, row);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'photo_cleanup_retry_failed',
          photoId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const deletions = await env.DB.prepare(
    `SELECT user_id FROM account_deletions
      ORDER BY requested_at, user_id LIMIT ?`,
  )
    .bind(ACCOUNT_DELETION_BATCH_SIZE)
    .all<{ user_id: string }>();
  for (const row of deletions.results ?? []) {
    try {
      await finalizeAccountDeletion(env, row.user_id);
    } catch (error) {
      await recordDeletionFailure(env, row.user_id);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'account_deletion_retry_failed',
          userId: row.user_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export interface MarketClaimCredentials {
  authorization: string | null;
  cookie: string | null;
}

export type MarketClaimResult = 'ok' | 'unauthorized' | 'conflict';
export type MarketClaimProof = 'market-upload';
export type MarketAccessResult = 'admin' | 'owner' | 'user' | 'unauthorized';
export type MarketAccountAccessResult = 'admin' | 'user' | 'unauthorized';
export interface AiQuotaResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export interface VoiceTicketQuotaResult extends AiQuotaResult {
  subject: string;
}

function requestFromClaimCredentials(credentials: MarketClaimCredentials): Request {
  const headers = new Headers();
  if (credentials.authorization) headers.set('Authorization', credentials.authorization);
  if (credentials.cookie) headers.set('Cookie', credentials.cookie);
  return new Request('https://auth.internal/market-claim', { headers });
}

/**
 * Private RPC entrypoint used only by Market after it has proved control of an item.
 *
 * A caller on the public Internet cannot address a named WorkerEntrypoint. Keeping the
 * write here (instead of a hidden-looking HTTP path) makes the trust boundary structural:
 * Market owns item proof, Auth owns session identity and the durable account relation.
 */
export class AuthOwnershipService extends WorkerEntrypoint<Env> {
  async consumeAiQuota(
    credentials: MarketClaimCredentials,
    kind: 'text' | 'voice',
    units = 1,
  ): Promise<AiQuotaResult | 'unauthorized'> {
    return consumeAiQuotaForCredentials(this.env, credentials, kind, units);
  }

  async authorizeVoiceTicket(ticket: string): Promise<VoiceTicketQuotaResult | 'unauthorized'> {
    return voiceTicketQuota(this.env, ticket, 0);
  }

  async consumeVoiceTicket(
    ticket: string,
    minutes: number,
  ): Promise<VoiceTicketQuotaResult | 'unauthorized'> {
    return voiceTicketQuota(this.env, ticket, minutes);
  }

  async claimMarketItems(
    credentials: MarketClaimCredentials,
    itemIds: string[],
    proof: MarketClaimProof,
  ): Promise<MarketClaimResult> {
    return claimMarketItemsForCredentials(this.env, credentials, itemIds, proof);
  }

  async marketItemAccess(
    credentials: MarketClaimCredentials,
    itemId: string,
  ): Promise<MarketAccessResult> {
    return marketItemAccessForCredentials(this.env, credentials, itemId);
  }

  async marketAccountAccess(
    credentials: MarketClaimCredentials,
  ): Promise<MarketAccountAccessResult> {
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    if (!user) return 'unauthorized';
    return user.role === 'admin' ? 'admin' : 'user';
  }
}

export async function voiceTicketQuota(
  env: Env,
  ticket: string,
  minutes: number,
): Promise<VoiceTicketQuotaResult | 'unauthorized'> {
  const claims = await verifyDmTicket(env.DM_TICKET_SECRET, ticket, Date.now());
  if (!claims || claims.aud !== 'voice') return 'unauthorized';
  const user = await env.DB.prepare(
    `SELECT id FROM users
      WHERE id = ? AND banned_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = users.id)`,
  )
    .bind(claims.sub)
    .first<{ id: string }>();
  if (!user) return 'unauthorized';

  const day = new Date().toISOString().slice(0, 10);
  const existing = await env.DB.prepare(
    `SELECT units FROM ai_usage_daily
      WHERE user_id = ? AND usage_day = ? AND kind = 'voice'`,
  )
    .bind(user.id, day)
    .first<{ units: number }>();
  if (minutes <= 0) {
    const used = existing?.units ?? 0;
    return { subject: user.id, allowed: used < 60, remaining: Math.max(0, 60 - used), limit: 60 };
  }

  const safeMinutes = Math.max(1, Math.min(Math.trunc(minutes), 60));
  const result = await consumeAiQuotaForUserId(env, user.id, 'voice', safeMinutes);
  return { subject: user.id, ...result };
}

export async function consumeAiQuotaForCredentials(
  env: Env,
  credentials: MarketClaimCredentials,
  kind: 'text' | 'voice',
  units = 1,
): Promise<AiQuotaResult | 'unauthorized'> {
  const user = await currentUser(requestFromClaimCredentials(credentials), env);
  if (!user) return 'unauthorized';
  return consumeAiQuotaForUserId(env, user.id, kind, units);
}

async function consumeAiQuotaForUserId(
  env: Env,
  userId: string,
  kind: 'text' | 'voice',
  units: number,
): Promise<AiQuotaResult> {
  const safeUnits = Math.max(1, Math.min(Math.trunc(units), kind === 'voice' ? 60 : 10));
  const limit = kind === 'voice' ? 60 : 100;
  const day = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const updated = await env.DB.prepare(
    `INSERT INTO ai_usage_daily (user_id, usage_day, kind, units, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, usage_day, kind) DO UPDATE SET
         units = units + excluded.units, updated_at = excluded.updated_at
       WHERE units + excluded.units <= ?
       RETURNING units`,
  )
    .bind(userId, day, kind, safeUnits, now, limit)
    .first<{ units: number }>();
  const used = updated?.units ?? limit;
  return {
    allowed: Boolean(updated),
    remaining: Math.max(0, limit - used),
    limit,
  };
}

/** Resolve Market permissions without exposing account roles on a public endpoint. */
export async function marketItemAccessForCredentials(
  env: Env,
  credentials: MarketClaimCredentials,
  itemId: string,
): Promise<MarketAccessResult> {
  const user = await currentUser(requestFromClaimCredentials(credentials), env);
  if (!user) return 'unauthorized';
  if (user.role === 'admin') return 'admin';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) return 'user';
  const claim = await env.DB.prepare(
    `SELECT 1 FROM market_claims
      WHERE item_id = ? AND user_id = ? AND verified_at IS NOT NULL`,
  )
    .bind(itemId, user.id)
    .first();
  return claim ? 'owner' : 'user';
}

/** The RPC implementation separated for deterministic D1 tests. */
export async function claimMarketItemsForCredentials(
  env: Env,
  credentials: MarketClaimCredentials,
  itemIds: string[],
  proof: MarketClaimProof,
): Promise<MarketClaimResult> {
  const user = await currentUser(requestFromClaimCredentials(credentials), env);
  if (!user) return 'unauthorized';
  const ids = [...new Set(itemIds)].filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)).slice(0, 50);
  if (ids.length !== itemIds.length || ids.length === 0) return 'conflict';

  const now = Date.now();
  const requested = ids.map(() => '(?)').join(',');
  // One statement is the transaction boundary: if any requested id is already verified
  // by another account, the NOT EXISTS guard makes the entire INSERT select zero rows.
  // That prevents a conflicting batch from leaving claims for its otherwise-free ids.
  await env.DB.prepare(
    `WITH requested(item_id) AS (VALUES ${requested})
     INSERT INTO market_claims
       (item_id, user_id, edit_key_hash, claimed_at, verified_at, proof_method)
     SELECT requested.item_id, ?, NULL, ?, ?, ?
       FROM requested
      WHERE NOT EXISTS (
        SELECT 1
          FROM market_claims existing
          JOIN requested candidate ON candidate.item_id = existing.item_id
         WHERE existing.verified_at IS NOT NULL AND existing.user_id <> ?
      )
     ON CONFLICT (item_id) DO UPDATE SET
       user_id = excluded.user_id,
       edit_key_hash = NULL,
       claimed_at = excluded.claimed_at,
       verified_at = excluded.verified_at,
       proof_method = excluded.proof_method
     WHERE market_claims.verified_at IS NULL OR market_claims.user_id = excluded.user_id`,
  )
    .bind(...ids, user.id, now, now, proof, user.id)
    .run();

  const placeholders = ids.map(() => '?').join(',');
  const conflict = await env.DB.prepare(
    `SELECT 1 FROM market_claims
        WHERE item_id IN (${placeholders}) AND verified_at IS NOT NULL AND user_id <> ?
        LIMIT 1`,
  )
    .bind(...ids, user.id)
    .first();
  return conflict ? 'conflict' : 'ok';
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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}

async function createEmailAction(
  env: Env,
  userId: string,
  purpose: 'verify' | 'reset',
  ttlMs: number,
): Promise<string> {
  const token = newToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_action_tokens WHERE user_id = ? AND purpose = ?').bind(
      userId,
      purpose,
    ),
    env.DB.prepare(
      `INSERT INTO email_action_tokens
       (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(await sha256Hex(token), userId, purpose, now, now + ttlMs),
  ]);
  return token;
}

async function emailActionCoolingDown(
  env: Env,
  userId: string,
  purpose: 'verify' | 'reset',
): Promise<boolean> {
  const recent = await env.DB.prepare(
    `SELECT 1 FROM email_action_tokens
     WHERE user_id = ? AND purpose = ? AND created_at > ? LIMIT 1`,
  )
    .bind(userId, purpose, Date.now() - EMAIL_ACTION_COOLDOWN_MS)
    .first();
  return Boolean(recent);
}

async function sendAccountEmail(
  env: Env,
  to: string,
  kind: 'verify' | 'reset',
  token: string,
): Promise<void> {
  if (!env.EMAIL) throw new Error('email sending is not enabled');
  const url = new URL('https://0xnullai.com/settings');
  url.searchParams.set(kind, token);
  const action = kind === 'verify' ? '验证邮箱' : '重置密码';
  const expiry = kind === 'verify' ? '24 小时' : '30 分钟';
  const safeUrl = escapeHtml(url.toString());
  await env.EMAIL.send({
    to,
    from: { email: 'no-reply@0xnullai.com', name: '0xNuller' },
    subject: `0xNuller ${action}`,
    text: `${action}：${url.toString()}\n链接将在 ${expiry}后失效。若非本人操作，请忽略。`,
    html: `<p>请点击下方链接完成${action}：</p><p><a href="${safeUrl}">${action}</a></p><p>链接将在 ${expiry}后失效。若非本人操作，请忽略。</p>`,
  });
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
      WHERE user_id = ? AND status = 'ready' AND purpose = 'album'${isSelf ? '' : " AND visibility = 'public'"}
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env.ALLOWED_ORIGINS);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const ipHash = await sha256Hex(
      (request.headers.get('CF-Connecting-IP') ?? '0.0.0.0') + ':' + env.IP_PEPPER,
    );

    try {
      // ── Register ──
      if (path === '/api/auth/register' && request.method === 'POST') {
        const registrationCount = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM registration_attempts WHERE ip_hash = ? AND created_at >= ?',
        )
          .bind(ipHash, Date.now() - REGISTER_WINDOW_MS)
          .first<{ n: number }>();
        if ((registrationCount?.n ?? 0) >= MAX_REGISTRATIONS_PER_IP) {
          return err('注册请求过于频繁，请稍后再试', 429, cors);
        }
        await env.DB.prepare(
          'INSERT INTO registration_attempts (ip_hash, created_at) VALUES (?, ?)',
        )
          .bind(ipHash, Date.now())
          .run();
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const invalid = validateCredentials(body.username, body.password);
        if (invalid) return err(invalid, 400, cors);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
          return err('请输入有效邮箱', 400, cors);
        }

        const username = (body.username as string).toLowerCase();
        const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?')
          .bind(username)
          .first();
        if (exists) return err('用户名已被占用', 409, cors);
        const emailExists = await env.DB.prepare('SELECT 1 FROM users WHERE lower(email) = ?')
          .bind(email)
          .first();
        if (emailExists) return err('邮箱已被注册', 409, cors);

        const id = crypto.randomUUID();
        try {
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
              email,
              Date.now(),
            )
            .run();
        } catch (cause) {
          const conflict = registrationConflict(cause);
          if (conflict === 'username') return err('用户名已被占用', 409, cors);
          if (conflict === 'email') return err('邮箱已被注册', 409, cors);
          throw cause;
        }

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

        const verificationToken = await createEmailAction(env, id, 'verify', VERIFY_EMAIL_TTL_MS);
        try {
          await sendAccountEmail(env, email, 'verify', verificationToken);
        } catch (cause) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'verification_email_failed',
              userId: id,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          );
        }

        return json(
          {
            user: {
              id,
              username,
              displayName: username,
              role: 'user',
              email,
              emailVerified: false,
              emailAvailable: Boolean(env.EMAIL),
            },
            token,
          },
          201,
          {
            ...cors,
            'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
          },
        );
      }

      // ── Email verification and password recovery ──
      if (path === '/api/auth/email/verification/request' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email) return err('账户尚未设置邮箱', 400, cors);
        if (user.email_verified_at) return json({ ok: true, alreadyVerified: true }, 200, cors);
        if (await emailActionCoolingDown(env, user.id, 'verify')) {
          return err('验证邮件刚刚已发送，请稍后再试', 429, cors);
        }
        const actionToken = await createEmailAction(env, user.id, 'verify', VERIFY_EMAIL_TTL_MS);
        await sendAccountEmail(env, user.email, 'verify', actionToken);
        return json({ ok: true }, 202, cors);
      }

      if (path === '/api/auth/email/verification/confirm' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const actionToken = typeof body.token === 'string' ? body.token : '';
        if (!actionToken) return err('验证链接无效', 400, cors);
        const tokenHash = await sha256Hex(actionToken);
        const action = await env.DB.prepare(
          `SELECT user_id FROM email_action_tokens
           WHERE token_hash = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > ?`,
        )
          .bind(tokenHash, Date.now())
          .first<{ user_id: string }>();
        if (!action) return err('验证链接无效或已过期', 400, cors);
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').bind(
            now,
            action.user_id,
          ),
          env.DB.prepare('UPDATE email_action_tokens SET used_at = ? WHERE token_hash = ?').bind(
            now,
            tokenHash,
          ),
        ]);
        return json({ ok: true }, 200, cors);
      }

      if (path === '/api/auth/password/forgot' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (email && EMAIL_PATTERN.test(email)) {
          const user = await env.DB.prepare('SELECT id, email FROM users WHERE lower(email) = ?')
            .bind(email)
            .first<{ id: string; email: string }>();
          if (user) {
            if (await emailActionCoolingDown(env, user.id, 'reset')) {
              return json({ ok: true }, 202, cors);
            }
            const actionToken = await createEmailAction(
              env,
              user.id,
              'reset',
              RESET_PASSWORD_TTL_MS,
            );
            try {
              await sendAccountEmail(env, user.email, 'reset', actionToken);
            } catch (cause) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'password_reset_email_failed',
                  userId: user.id,
                  error: cause instanceof Error ? cause.message : String(cause),
                }),
              );
            }
          }
        }
        return json({ ok: true }, 202, cors);
      }

      if (path === '/api/auth/password/reset' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const actionToken = typeof body.token === 'string' ? body.token : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (password.length < MIN_PASSWORD_LEN) return err('密码至少 8 位', 400, cors);
        const tokenHash = await sha256Hex(actionToken);
        const action = await env.DB.prepare(
          `SELECT user_id FROM email_action_tokens
           WHERE token_hash = ? AND purpose = 'reset' AND used_at IS NULL AND expires_at > ?`,
        )
          .bind(tokenHash, Date.now())
          .first<{ user_id: string }>();
        if (!action) return err('重置链接无效或已过期', 400, cors);
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(
            await hashPassword(password),
            action.user_id,
          ),
          env.DB.prepare('UPDATE email_action_tokens SET used_at = ? WHERE token_hash = ?').bind(
            now,
            tokenHash,
          ),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(action.user_id),
        ]);
        return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
      }

      // ── Login ──
      if (path === '/api/auth/login' && request.method === 'POST') {
        return login(request, env, ipHash, cors);
      }

      // ── Current user ──
      if (path === '/api/auth/me' && request.method === 'GET') {
        const user = await currentUser(request, env);
        return json({ user: user ? sessionUser(user, Boolean(env.EMAIL)) : null }, 200, cors);
      }

      if (path === '/api/auth/ai-usage' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const day = new Date().toISOString().slice(0, 10);
        const rows = await env.DB.prepare(
          'SELECT kind, units FROM ai_usage_daily WHERE user_id = ? AND usage_day = ?',
        )
          .bind(user.id, day)
          .all<{ kind: 'text' | 'voice'; units: number }>();
        const used = Object.fromEntries(rows.results.map((row) => [row.kind, row.units]));
        return json(
          {
            day,
            text: { used: used.text ?? 0, limit: 100 },
            voice: { used: used.voice ?? 0, limit: 60 },
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/voice/ticket' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!env.DM_TICKET_SECRET) return err('语音体验尚未启用', 503, cors);
        const now = Date.now();
        const ticket = await signDmTicket(env.DM_TICKET_SECRET, {
          aud: 'voice',
          sub: user.id,
          iat: now,
          exp: now + VOICE_TICKET_TTL_MS,
        });
        return json({ ticket, expiresAt: now + VOICE_TICKET_TTL_MS }, 200, cors);
      }

      if (path === '/api/auth/chat/ticket' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        if (!env.DM_TICKET_SECRET) return err('Chat 尚未启用', 503, cors);
        const now = Date.now();
        const ticket = await signDmTicket(env.DM_TICKET_SECRET, {
          aud: 'chat',
          sub: user.id,
          iat: now,
          exp: now + DM_TICKET_TTL_MS,
        });
        return json({ ticket, expiresAt: now + DM_TICKET_TTL_MS }, 200, cors);
      }

      if (path === '/api/auth/admin/stats' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const now = Date.now();
        const day = new Date(now).toISOString().slice(0, 10);
        const [users, verified, sessions, registrations, usage] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>(),
          env.DB.prepare(
            'SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL',
          ).first<{ n: number }>(),
          env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?')
            .bind(now)
            .first<{ n: number }>(),
          env.DB.prepare('SELECT COUNT(*) AS n FROM registration_attempts WHERE created_at >= ?')
            .bind(now - 24 * 60 * 60 * 1000)
            .first<{ n: number }>(),
          env.DB.prepare(
            'SELECT kind, COALESCE(SUM(units), 0) AS units FROM ai_usage_daily WHERE usage_day = ? GROUP BY kind',
          )
            .bind(day)
            .all<{ kind: 'text' | 'voice'; units: number }>(),
        ]);
        const used = Object.fromEntries(usage.results.map((row) => [row.kind, row.units]));
        return json(
          {
            generatedAt: now,
            users: users?.n ?? 0,
            verifiedUsers: verified?.n ?? 0,
            activeSessions: sessions?.n ?? 0,
            registrationAttempts24h: registrations?.n ?? 0,
            textUnitsToday: used.text ?? 0,
            voiceUnitsToday: used.voice ?? 0,
          },
          200,
          cors,
        );
      }

      // ── Logout ──
      if (path === '/api/auth/logout' && request.method === 'POST') {
        return logout(request, env, cors);
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

        let avatarUrl: string | null = null;
        if (typeof body.avatarUrl === 'string' && body.avatarUrl.trim()) {
          const match = body.avatarUrl.trim().match(/^\/api\/auth\/photos\/([^/]+)\/content$/);
          if (!match) return err('头像地址无效', 400, cors);
          const photoId = decodeURIComponent(match[1]!);
          const owned = await env.DB.prepare(
            "SELECT 1 FROM user_photos WHERE id = ? AND user_id = ? AND status = 'ready'",
          )
            .bind(photoId, user.id)
            .first();
          if (!owned) return err('头像不存在', 400, cors);
          avatarUrl = `/api/auth/photos/${encodeURIComponent(photoId)}/content`;
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
            avatarUrl,
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
        const purpose = request.headers.get('x-photo-purpose') === 'avatar' ? 'avatar' : 'album';
        const createdAt = Date.now();

        const reserved = await reservePhotoSlot(env, {
          id,
          userId: user.id,
          objectKey,
          caption: caption || null,
          visibility,
          purpose,
          createdAt,
        });
        if (!reserved) return err('相册已达到上限或账号正在删除', 409, cors);

        try {
          await env.PHOTOS.put(objectKey, bytes, { httpMetadata: { contentType: mime } });
          if (!(await finishPhotoUpload(env, id, user.id))) {
            throw new Error('photo reservation was cancelled');
          }
        } catch (error) {
          // Keep the uploading row when R2 cleanup fails: cron can see and retry it.
          try {
            await cleanupPendingPhoto(env, { id, object_key: objectKey });
          } catch (cleanupError) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'photo_upload_compensation_failed',
                photoId: id,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              }),
            );
          }
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
          "SELECT user_id, object_key, visibility FROM user_photos WHERE id = ? AND status = 'ready'",
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

      if (path.startsWith('/api/auth/photos/') && request.method === 'PATCH') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const id = decodeURIComponent(path.slice('/api/auth/photos/'.length));
        const body = (await request.json()) as Record<string, unknown>;
        if (body.visibility !== 'public' && body.visibility !== 'private') {
          return err('可见范围无效', 400, cors);
        }
        const owned = await env.DB.prepare(
          "SELECT 1 FROM user_photos WHERE id = ? AND user_id = ? AND status = 'ready'",
        )
          .bind(id, user.id)
          .first();
        if (!owned) return err('不存在', 404, cors);
        await env.DB.prepare('UPDATE user_photos SET visibility = ? WHERE id = ? AND user_id = ?')
          .bind(body.visibility, id, user.id)
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (path.startsWith('/api/auth/photos/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const id = decodeURIComponent(path.slice('/api/auth/photos/'.length));
        const row = await env.DB.prepare(
          "SELECT object_key FROM user_photos WHERE id = ? AND user_id = ? AND status = 'ready'",
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
      if (path === '/api/auth/chat-rooms' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        const rows = await env.DB.prepare(
          `SELECT code, name, owner_key, joined_at, updated_at FROM user_chat_rooms
           WHERE user_id = ? ORDER BY updated_at DESC`,
        )
          .bind(user.id)
          .all<{
            code: string;
            name: string;
            owner_key: string | null;
            joined_at: number;
            updated_at: number;
          }>();
        return json(
          {
            rooms: rows.results.map((room) => ({
              code: room.code,
              name: room.name,
              joinedAt: room.joined_at,
              updatedAt: room.updated_at,
              ...(room.owner_key ? { ownerKey: room.owner_key } : {}),
            })),
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/chat-rooms' && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const name =
          typeof body.name === 'string' ? body.name.trim().slice(0, MAX_CHAT_ROOM_NAME) : '';
        const ownerKey = typeof body.ownerKey === 'string' && body.ownerKey ? body.ownerKey : null;
        if (!CHAT_ROOM_CODE.test(code)) return err('房间号无效', 400, cors);
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO user_chat_rooms (user_id, code, name, owner_key, joined_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, code) DO UPDATE SET
             name = CASE WHEN excluded.name = '' THEN user_chat_rooms.name ELSE excluded.name END,
             owner_key = COALESCE(excluded.owner_key, user_chat_rooms.owner_key),
             updated_at = excluded.updated_at`,
        )
          .bind(user.id, code, name, ownerKey, now, now)
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (
        path.startsWith('/api/auth/chat-rooms/') &&
        path.endsWith('/close') &&
        request.method === 'POST'
      ) {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        const code = decodeURIComponent(
          path.slice('/api/auth/chat-rooms/'.length, -'/close'.length),
        );
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const ownerKey = typeof body.ownerKey === 'string' ? body.ownerKey : '';
        const owner = await env.DB.prepare(
          'SELECT 1 FROM user_chat_rooms WHERE user_id = ? AND code = ? AND owner_key = ?',
        )
          .bind(user.id, code, ownerKey)
          .first();
        if (!owner || !ownerKey) return err('无权关闭房间', 403, cors);
        await env.DB.prepare('DELETE FROM user_chat_rooms WHERE code = ?').bind(code).run();
        return json({ ok: true }, 200, cors);
      }

      if (path.startsWith('/api/auth/chat-rooms/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        const code = decodeURIComponent(path.slice('/api/auth/chat-rooms/'.length));
        if (!CHAT_ROOM_CODE.test(code)) return err('房间号无效', 400, cors);
        await env.DB.prepare('DELETE FROM user_chat_rooms WHERE user_id = ? AND code = ?')
          .bind(user.id, code)
          .run();
        return json({ ok: true }, 200, cors);
      }

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

      // Agent history is row-based rather than a settings namespace: a single
      // account can exceed the settings blob limit, and independent sessions
      // must merge instead of making one device overwrite every other chat.
      if (path === '/api/auth/agent-sessions' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const since = Math.max(0, Math.trunc(Number(url.searchParams.get('since') ?? '0') || 0));
        const rows = await env.DB.prepare(
          `SELECT id, payload, client_updated_at, updated_at, deleted_at
             FROM agent_sessions
            WHERE user_id = ? AND updated_at > ?
            ORDER BY updated_at ASC, id ASC
            LIMIT ?`,
        )
          .bind(user.id, since, AGENT_SESSION_PAGE_SIZE)
          .all();
        const resultRows = rows.results ?? [];
        return json(
          {
            sessions: resultRows.map((raw) => {
              const row = raw as Record<string, unknown>;
              return {
                id: row.id,
                session: row.deleted_at == null ? JSON.parse(String(row.payload)) : null,
                clientUpdatedAt: row.client_updated_at,
                updatedAt: row.updated_at,
                deleted: row.deleted_at != null,
              };
            }),
            hasMore: resultRows.length === AGENT_SESSION_PAGE_SIZE,
            cursor: resultRows.length
              ? Number((resultRows.at(-1) as Record<string, unknown>).updated_at)
              : since,
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/agent-sessions' && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json()) as {
          sessions?: {
            id: string;
            session?: unknown;
            clientUpdatedAt?: number;
            deleted?: boolean;
          }[];
        };
        const sessions = Array.isArray(body.sessions) ? body.sessions.slice(0, 100) : [];
        if (sessions.length === 0) return json({ ok: true, written: 0 }, 200, cors);
        for (const item of sessions) {
          if (!CONTENT_ID.test(String(item.id ?? ''))) return err('会话 id 无效', 400, cors);
          const payload = JSON.stringify(item.session ?? null);
          if (new TextEncoder().encode(payload).byteLength > MAX_AGENT_SESSION_BYTES) {
            return err('会话记录过大', 413, cors);
          }
        }
        const now = Date.now();
        const statements = sessions.map((item) => {
          const clientUpdatedAt = Math.max(0, Math.trunc(Number(item.clientUpdatedAt) || now));
          return env.DB.prepare(
            `INSERT INTO agent_sessions
               (user_id, id, payload, client_updated_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, id) DO UPDATE SET
               payload = CASE WHEN excluded.client_updated_at >= agent_sessions.client_updated_at
                              THEN excluded.payload ELSE agent_sessions.payload END,
               client_updated_at = MAX(agent_sessions.client_updated_at, excluded.client_updated_at),
               updated_at = excluded.updated_at,
               deleted_at = CASE WHEN excluded.client_updated_at >= agent_sessions.client_updated_at
                                 THEN excluded.deleted_at ELSE agent_sessions.deleted_at END`,
          ).bind(
            user.id,
            String(item.id),
            JSON.stringify(item.session ?? null),
            clientUpdatedAt,
            now,
            item.deleted ? now : null,
          );
        });
        await env.DB.batch(statements);
        return json({ ok: true, written: sessions.length, updatedAt: now }, 200, cors);
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
        const select = `SELECT r.client_id AS id, e.kind, e.name, e.payload,
                               r.sort_order, r.hidden_at, r.created_at,
                               r.updated_at, r.deleted_at
                          FROM user_content_refs r
                          JOIN content_entities e ON e.id = r.content_id`;
        const rows = kind
          ? await env.DB.prepare(
              `${select}
                WHERE r.user_id = ? AND e.kind = ?
                  AND (r.updated_at > ? OR (r.updated_at = ? AND r.client_id > ?))
                ORDER BY r.updated_at ASC, r.client_id ASC
                LIMIT ?`,
            )
              .bind(user.id, kind, afterUpdatedAt, afterUpdatedAt, afterId, CONTENT_PAGE_SIZE)
              .all()
          : await env.DB.prepare(
              `${select}
                WHERE r.user_id = ?
                  AND (r.updated_at > ? OR (r.updated_at = ? AND r.client_id > ?))
                ORDER BY r.updated_at ASC, r.client_id ASC
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
                hidden: row.hidden_at != null,
                order: row.sort_order,
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
          items?: {
            id: string;
            kind: string;
            name: string;
            payload: unknown;
            deleted?: boolean;
            hidden?: boolean;
            order?: number;
          }[];
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
        const statements = items.flatMap((item) => {
          const clientId = String(item.id);
          const entityId = `${user.id}:${clientId}`;
          return [
            env.DB.prepare(
              `INSERT INTO content_entities (id, owner_id, kind, name, payload, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET name = excluded.name, payload = excluded.payload,
                 updated_at = excluded.updated_at
               WHERE content_entities.owner_id = excluded.owner_id AND ? = 0`,
            ).bind(
              entityId,
              user.id,
              item.kind,
              String(item.name).trim().slice(0, 200),
              JSON.stringify(item.payload ?? null),
              now,
              now,
              item.deleted ? 1 : 0,
            ),
            env.DB.prepare(
              `INSERT INTO user_content_refs
                 (user_id, content_id, client_id, sort_order, hidden_at, deleted_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (user_id, client_id) DO UPDATE SET
                 content_id = excluded.content_id, sort_order = excluded.sort_order,
                 hidden_at = excluded.hidden_at, deleted_at = excluded.deleted_at,
                 updated_at = excluded.updated_at`,
            ).bind(
              user.id,
              entityId,
              clientId,
              Number.isFinite(item.order) ? Math.trunc(item.order!) : 0,
              item.hidden ? now : null,
              item.deleted ? now : null,
              now,
              now,
            ),
          ];
        });
        await env.DB.batch(statements);
        return json({ ok: true, written: items.length, updatedAt: now }, 200, cors);
      }

      const contentPreferencesMatch = path.match(
        /^\/api\/auth\/content-preferences\/(waveform|scene)$/,
      );
      if (contentPreferencesMatch && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const row = await env.DB.prepare(
          `SELECT selected_id, hidden_builtin_ids, updated_at FROM user_content_preferences
           WHERE user_id = ? AND kind = ?`,
        )
          .bind(user.id, contentPreferencesMatch[1])
          .first<Record<string, unknown>>();
        return json(
          row
            ? {
                selectedId: row.selected_id ?? undefined,
                hiddenBuiltinIds: JSON.parse(String(row.hidden_builtin_ids)),
                updatedAt: row.updated_at,
              }
            : { hiddenBuiltinIds: [], updatedAt: 0 },
          200,
          cors,
        );
      }
      if (contentPreferencesMatch && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = (await request.json()) as {
          selectedId?: unknown;
          hiddenBuiltinIds?: unknown;
        };
        const hidden = Array.isArray(body.hiddenBuiltinIds)
          ? [
              ...new Set(
                body.hiddenBuiltinIds.filter((id): id is string => typeof id === 'string'),
              ),
            ].slice(0, 200)
          : [];
        const selected = typeof body.selectedId === 'string' ? body.selectedId.slice(0, 200) : null;
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO user_content_preferences
             (user_id, kind, selected_id, hidden_builtin_ids, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, kind) DO UPDATE SET selected_id = excluded.selected_id,
             hidden_builtin_ids = excluded.hidden_builtin_ids, updated_at = excluded.updated_at`,
        )
          .bind(user.id, contentPreferencesMatch[1], selected, JSON.stringify(hidden), now)
          .run();
        return json({ ok: true, updatedAt: now }, 200, cors);
      }

      // ── Market ownership ──
      //
      // The item itself lives in Market's own D1, in another Worker. This
      // records the durable account ownership created during upload.
      if (path === '/api/auth/market-claims' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const rows = await env.DB.prepare(
          `SELECT item_id, claimed_at FROM market_claims
            WHERE user_id = ? AND verified_at IS NOT NULL
            ORDER BY claimed_at DESC LIMIT 500`,
        )
          .bind(user.id)
          .all();
        return json({ claims: rows.results ?? [] }, 200, cors);
      }

      if (path === '/api/auth/market-claims' && request.method === 'POST') {
        return err('归属必须由市场验证编辑凭证', 405, cors);
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
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
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
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
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
        await env.DB.prepare(
          `INSERT INTO account_deletions (user_id, requested_at)
           VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING`,
        )
          .bind(user.id, Date.now())
          .run();
        try {
          await finalizeAccountDeletion(env, user.id);
          return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie('', 0) });
        } catch {
          // The marker makes the account immediately unusable and the cron finishes the
          // cross-service delete. Sessions are removed now so every device is logged out.
          await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
          await recordDeletionFailure(env, user.id);
          return json({ ok: false, pending: true }, 202, {
            ...cors,
            'Set-Cookie': sessionCookie('', 0),
          });
        }
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
      Promise.all([
        env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
          env.DB.prepare('DELETE FROM login_attempts WHERE created_at < ?').bind(
            keepLoginAttemptsAfter,
          ),
          env.DB.prepare('DELETE FROM registration_attempts WHERE created_at < ?').bind(
            now - REGISTER_WINDOW_MS,
          ),
          env.DB.prepare('DELETE FROM email_action_tokens WHERE expires_at < ?').bind(now),
        ]),
        runAuthMaintenance(env, now),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
