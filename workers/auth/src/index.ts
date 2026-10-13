import {
  ReservationContextRejected,
  reserveWithContext,
  type ReservationContext,
} from './reservation-context';
import { handleVoiceBillingReview } from './voice-billing-review';
import { handleTextBillingReview } from './text-billing-review';
import { handleMediaBillingReview } from './media-billing-review';
import { validManagedTextReservation } from './managed-vision-reservation';
import {
  heartbeatTextBilling,
  registerTextBilling,
  checkpointTextBilling,
  finalizeTextBilling,
  inspectTextBilling,
  runTextBilling,
} from './text-billing-outbox';
import { handleAutoMemory, runAutoMemory } from './auto-memory';
import { runConversationDigest } from './run-conversation-digest';
import { handleConversationDigestPreference } from './conversation-digest-preference';
import { handleAccountMemoryAccess } from './account-memory-access';
import { handleBillingOrders } from './billing-orders';
import { handleCharacterAppearance } from './character-appearance';
import { handleCharacterDrafts } from './character-drafts';
import { handleCompanionSchedules, runCompanionSchedules } from './companion-schedules';
import { handleRetiredPushRegistrations } from './retired-push';
import { handleAgentWorkspace } from './agent-workspace';
import { handleAgentRuns, runAgentRunMaintenance } from './agent-runs';
import { handleCompanionLife } from './companion-life';
import { handleCreditActivity } from './credit-activity';
import { handleMediaJobs, runMediaJobs } from './media-jobs';
import { hashPassword } from './password';
import { handleMemoryContext } from './memory-context';
import { normalizeProfileLink, safeProfileLinks } from '@0xnullai/auth/profile-links';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';
import { handleMemoryFacts } from './memory-facts';
import { expireStagedVideoReplies, handleServerConversations } from './server-conversations';
import {
  handleConversationAttachments,
  runConversationAttachmentCleanup,
} from './conversation-attachments';
import {
  handleAsrBillingReview,
  handleVoiceAttachmentAsr,
  recoverVoiceAttachmentAsr,
} from './voice-attachment-asr';
import { handleManagedTts, recoverManagedTts } from './managed-tts';
import { handleAuthChatBackupExport } from './chat-backup-export';
import { handleCharacterRelationships } from './character-relationships';
import { expireMediumMemories, handlePersonalMemories } from './personal-memory';
import {
  publicMarketCreator,
  publicMarketCreatorItems,
  publicMarketCreatorsForItems,
} from './public-market-creator';
import {
  finalizeVoiceReservation as finalizeManagedVoiceReservation,
  type VoiceFinalization,
} from './voice-credit-domain';
import {
  DM_DIGEST_MAX_ROOMS,
  DM_TICKET_TTL_MS,
  dmRoomCode,
  signDmTicket,
  verifyDmTicket,
} from './dm-ticket';
import { validCharacterId, verifyGroupAiTicket } from './group-ai-ticket';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { withServerErrorCounting } from '@0xnullai/observability';
import {
  handleRuntimeMonitoring,
  monitoringRetentionStatements,
  recordServerErrors,
  runRuntimeMonitoring,
} from './runtime-monitoring';
import { registrationConflict, validateCredentials } from './account-validation';
import { decodeContentCursor, encodeContentCursor } from './content-cursor';
import {
  chatRoomAccountHash,
  decodeChatRoomCursor,
  encodeChatRoomCursor,
} from './chat-room-cursor';
import { RequestError, corsHeaders, err, json, readBodyBounded, readJson } from './http';
import { readToken, sessionCookie } from './session-credentials';
import {
  cleanupPendingPhoto,
  finalizeAccountDeletion,
  finishPhotoUpload,
  recordDeletionFailure,
  reservePhotoSlot,
  runAuthMaintenance,
  runPendingAccountDeletions,
} from './photo-lifecycle';
import { sanitizePhoto } from '@0xnullai/auth/photo-sanitizer';
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
export { runAuthMaintenance } from './photo-lifecycle';
export { runPendingAccountDeletions } from './photo-lifecycle';

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
  MARKET: Fetcher;
  /** Volcengine Ark key for background text and image generation. */
  VOLC_ARK_API_KEY?: string;
  /** Doubao speech (TTS, recorded-clip ASR); one key sent as `X-Api-Key`. */
  VOLC_SPEECH_API_KEY?: string;
  /** Managed AI model ids and Credit prices; see @0xnullai/ai-pricing. */
  AI_PRICE_TABLE?: string;
  AUTH_BACKUP_TOKEN?: string;
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
  /** Comma-separated admin addresses for runtime alerts (Cloudflare secret); unset disables. */
  ALERT_EMAIL?: string;
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
const REFERRAL_REWARD_CREDITS = 500;
// Product decision (2026-10-11): a verified new account can reply on the default platform
// tier at once. 100 Credit is roughly 30–50 balanced-tier replies. Granted once per account,
// at email verification, so a registration flood without mailboxes earns nothing.
const WELCOME_CREDITS = 100;
const WELCOME_REFERENCE = 'welcome';
const CREDIT_PRICE_VERSION = 'credits-2026-09';
const REFERRAL_CODE = /^[A-Z0-9_-]{8,32}$/;
const REPORT_REASONS = new Set(['spam', 'harassment', 'impersonation', 'unsafe', 'other']);
const MAX_REPORT_DETAILS = 500;
const MAX_FEEDBACK_MESSAGE = 4000;
const MAX_FEEDBACK_CONTACT = 254;
const FEEDBACK_RECIPIENT = 'leonardoshen@icloud.com';
const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
const MAX_FEEDBACK_PER_WINDOW = 5;

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
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONTENT_PAGE_SIZE = 500;
const CONTENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SYNC_NAMESPACES = new Set(['llm', 'device-safety', 'proxy', 'ui']);
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_CONTENT_PAYLOAD_BYTES = 512 * 1024;
const MAX_AGENT_SESSION_BYTES = 2 * 1024 * 1024;
/** Whole sync batch body; each item keeps its own cap above. Bounds the JSON parsed in memory. */
const MAX_SYNC_BATCH_BYTES = 16 * 1024 * 1024;
const AGENT_SESSION_PAGE_SIZE = 200;
const CHAT_ROOM_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CHAT_ROOM_NAME = 80;

export interface MarketClaimCredentials {
  authorization: string | null;
  cookie: string | null;
}

export type MarketClaimResult = 'ok' | 'unauthorized' | 'conflict';
export type MarketClaimProof = 'market-upload';
export type MarketAccessResult = 'admin' | 'owner' | 'user' | 'unauthorized';
export type MarketAccountAccessResult = 'admin' | 'user' | 'unauthorized';
/**
 * `ok` and `capped` both mean a first download by an eligible account (only `ok` paid the author);
 * Market counts a download only for those two.
 */
export type MarketRewardResult =
  'ok' | 'capped' | 'unauthorized' | 'ineligible' | 'not_found' | 'duplicate' | 'invalid';
/**
 * Paid downloads per author per rolling day. Each reward needs a distinct verified account, but
 * accounts are cheap; the cap bounds what a ring of them can mint for one author.
 */
const MARKET_DOWNLOAD_REWARDS_PER_AUTHOR_DAY = 100;
export interface VoiceTicketQuotaResult extends CreditBalance {
  subject: string;
}

export interface CreditBalance {
  total: number;
  reserved: number;
  available: number;
}

export interface CreditReservationResult extends CreditBalance {
  allowed: boolean;
  /** Internal proof that this invocation inserted the reservation. */
  created?: boolean;
  status: 'pending' | 'settled' | 'released' | 'insufficient' | 'rejected';
  charged: number | null;
}

const CREDIT_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

export async function creditBalance(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<CreditBalance> {
  const [ledger, reservations] = await Promise.all([
    env.DB.prepare(
      'SELECT COALESCE(SUM(amount_credits), 0) AS total FROM credit_ledger WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(reserved_credits), 0) AS reserved
         FROM credit_reservations
        WHERE user_id = ? AND status = 'pending' AND updated_at > ?`,
    )
      .bind(userId, now - CREDIT_RESERVATION_TTL_MS)
      .first<{ reserved: number }>(),
  ]);
  const total = Number(ledger?.total ?? 0);
  const reserved = Number(reservations?.reserved ?? 0);
  return { total, reserved, available: Math.max(0, total - reserved) };
}

/** The account still has this character as its own (a live, undeleted relationship). */
async function hasCharacter(env: Env, userId: string, characterId: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    'SELECT 1 AS ok FROM character_relationships WHERE user_id=? AND character_id=? AND deleted_at IS NULL LIMIT 1',
  )
    .bind(userId, characterId)
    .first());
}

export async function reserveCredits(
  env: Env,
  userId: string,
  input: {
    idempotencyKey: string;
    usageKind: 'agent' | 'video' | 'voice';
    modelId: string;
    credits: number;
  },
): Promise<CreditReservationResult> {
  const credits = input.credits;
  if (
    !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey) ||
    !Number.isSafeInteger(credits) ||
    credits < 1 ||
    credits > 1_000_000
  ) {
    const balance = await creditBalance(env, userId);
    return { ...balance, allowed: false, status: 'insufficient', charged: null };
  }
  const now = Date.now();
  const created = await env.DB.prepare(
    `INSERT INTO credit_reservations
       (idempotency_key, user_id, usage_kind, model_id, reserved_credits, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'pending', ?, ?
      WHERE ? <= (
        SELECT COALESCE((SELECT SUM(amount_credits) FROM credit_ledger WHERE user_id = ?), 0)
             - COALESCE((SELECT SUM(reserved_credits) FROM credit_reservations
                          WHERE user_id = ? AND status = 'pending' AND updated_at > ?), 0)
      )
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
  )
    .bind(
      input.idempotencyKey,
      userId,
      input.usageKind,
      input.modelId.slice(0, 160),
      credits,
      now,
      now,
      credits,
      userId,
      userId,
      now - CREDIT_RESERVATION_TTL_MS,
    )
    .first<{ idempotency_key: string }>();
  const row = await env.DB.prepare(
    `SELECT user_id, usage_kind, model_id, reserved_credits, charged_credits, status
       FROM credit_reservations WHERE idempotency_key = ?`,
  )
    .bind(input.idempotencyKey)
    .first<Record<string, unknown>>();
  const balance = await creditBalance(env, userId, now);
  if (
    !row ||
    row.user_id !== userId ||
    row.usage_kind !== input.usageKind ||
    row.model_id !== input.modelId.slice(0, 160) ||
    Number(row.reserved_credits) !== credits
  ) {
    return { ...balance, allowed: false, status: 'insufficient', charged: null };
  }
  const status = row.status as 'pending' | 'settled' | 'released';
  return {
    ...balance,
    allowed: status === 'pending' && created != null,
    created: created != null,
    status,
    charged: row.charged_credits == null ? null : Number(row.charged_credits),
  };
}

export async function settleCredits(
  env: Env,
  userId: string,
  idempotencyKey: string,
  chargedCredits: number,
  metadata: Record<string, unknown>,
): Promise<CreditReservationResult> {
  const reservation = await env.DB.prepare(
    `SELECT reserved_credits, charged_credits, status, usage_kind, model_id, created_at FROM credit_reservations
      WHERE idempotency_key = ? AND user_id = ?`,
  )
    .bind(idempotencyKey, userId)
    .first<{
      usage_kind: string;
      model_id: string;
      created_at: number;
      reserved_credits: number;
      charged_credits: number | null;
      status: 'pending' | 'settled' | 'released';
    }>();
  // Legacy Voice RPCs share the same TTL and audit boundary as the durable finalizer.
  if (reservation?.usage_kind === 'voice') {
    const final = await finalizeManagedVoiceReservation(
      env,
      userId,
      idempotencyKey,
      {
        action: 'settle',
        durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : NaN,
      },
      CREDIT_PRICE_VERSION,
    );
    return {
      ...(await creditBalance(env, userId)),
      allowed: false,
      // Older clients understand released; review evidence remains in the audit/timeline.
      status:
        final.status === 'needs_review' || final.status === 'missing' ? 'released' : final.status,
      charged: final.charged,
    };
  }
  // Recorded ASR uses the legacy agent wallet enum, but must not inherit the
  // generic text path's ability to settle an expired, reusable hold.
  if (
    // Older ids stay listed for holds created before the speech provider changed.
    ['voice-asr', 'managed-tts', 'qwen3-asr-flash', 'cosyvoice-v3-flash'].includes(
      reservation?.model_id ?? '',
    ) &&
    reservation?.status === 'pending' &&
    reservation.created_at <= Date.now() - CREDIT_RESERVATION_TTL_MS
  )
    return releaseCredits(env, userId, idempotencyKey);
  const charge = Math.max(1, Math.trunc(chargedCredits));
  if (reservation?.status === 'pending' && charge > reservation.reserved_credits) {
    return releaseCredits(env, userId, idempotencyKey);
  }
  if (!reservation || reservation.status === 'released') {
    const balance = await creditBalance(env, userId);
    return { ...balance, allowed: false, status: 'released', charged: null };
  }
  if (reservation.status === 'pending') {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO credit_ledger
          (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
         SELECT ?, ?, 'usage', ?, ?, ?, ? FROM credit_reservations
         WHERE idempotency_key=? AND user_id=? AND status='pending'
         ON CONFLICT (user_id, kind, reference_id) DO NOTHING`,
      ).bind(
        userId,
        -charge,
        idempotencyKey,
        CREDIT_PRICE_VERSION,
        JSON.stringify(metadata).slice(0, 4000),
        now,
        idempotencyKey,
        userId,
      ),
      env.DB.prepare(
        `UPDATE credit_reservations SET charged_credits = ?, status = 'settled', updated_at = ?
          WHERE idempotency_key = ? AND user_id = ? AND status = 'pending'`,
      ).bind(charge, now, idempotencyKey, userId),
    ]);
  }
  const final = await env.DB.prepare(
    'SELECT status,charged_credits FROM credit_reservations WHERE idempotency_key=? AND user_id=?',
  )
    .bind(idempotencyKey, userId)
    .first<{ status: 'pending' | 'settled' | 'released'; charged_credits: number | null }>();
  const balance = await creditBalance(env, userId);
  return {
    ...balance,
    allowed: false,
    status: final?.status ?? 'released',
    charged: final?.charged_credits ?? null,
  };
}

export async function releaseCredits(
  env: Env,
  userId: string,
  idempotencyKey: string,
): Promise<CreditReservationResult> {
  await env.DB.prepare(
    `UPDATE credit_reservations SET status = 'released', updated_at = ?
      WHERE idempotency_key = ? AND user_id = ? AND status = 'pending'`,
  )
    .bind(Date.now(), idempotencyKey, userId)
    .run();
  const row = await env.DB.prepare(
    'SELECT status, charged_credits FROM credit_reservations WHERE idempotency_key = ? AND user_id = ?',
  )
    .bind(idempotencyKey, userId)
    .first<{ status: 'pending' | 'settled' | 'released'; charged_credits: number | null }>();
  const balance = await creditBalance(env, userId);
  return {
    ...balance,
    allowed: false,
    status: row?.status ?? 'released',
    charged: row?.charged_credits ?? null,
  };
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
  /** Coalesced error counts from Market, Voice and the LLM proxy; malformed input is ignored. */
  async recordServerErrors(report: unknown): Promise<boolean> {
    return recordServerErrors(this.env, report);
  }

  async creditBalance(
    credentials: MarketClaimCredentials,
  ): Promise<CreditBalance | 'unauthorized'> {
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    return user ? creditBalance(this.env, user.id) : 'unauthorized';
  }

  async reserveCredits(
    credentials: MarketClaimCredentials,
    input: {
      idempotencyKey: string;
      usageKind: 'agent' | 'video' | 'voice';
      modelId: string;
      credits: number;
    },
  ): Promise<CreditReservationResult | 'unauthorized'> {
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    return user ? reserveCredits(this.env, user.id, input) : 'unauthorized';
  }

  async reserveManagedTextCredits(
    credentials: MarketClaimCredentials,
    input: {
      idempotencyKey: string;
      usageKind: 'agent' | 'video';
      modelId: string;
      credits: number;
      context?: ReservationContext;
      bodyHash?: string;
    },
  ) {
    const vision = input.modelId === 'vision' || input.modelId === 'chat-vision';
    if (!validManagedTextReservation(input)) return { allowed: false, status: 'rejected' };
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    if (!user) return 'unauthorized';
    let result: CreditReservationResult;
    try {
      result = await reserveWithContext(
        this.env,
        user.id,
        input.idempotencyKey,
        input.context,
        () => reserveCredits(this.env, user.id, input),
      );
    } catch (error) {
      if (!(error instanceof ReservationContextRejected)) throw error;
      return {
        ...(await creditBalance(this.env, user.id)),
        allowed: false,
        status: 'rejected' as const,
        charged: null,
      };
    }
    if (!result.allowed) return result;
    const capability = await registerTextBilling(
      this.env,
      input.idempotencyKey,
      user.id,
      vision ? input.bodyHash : undefined,
    );
    // The proxy rate-limits per account (not per shared IP) with this; it never leaves the proxy.
    return { ...result, capability, subject: user.id };
  }
  /** Chat-only signed turn: the account that brought the AI into the group pays. */
  async authorizeManagedGroupText(
    ticket: string,
    input: { idempotencyKey: string; modelId: string; bodyHash: string },
  ): Promise<{ payer: string } | 'unauthorized'> {
    const claim = await verifyGroupAiTicket(this.env.DM_TICKET_SECRET, ticket, {
      reservationKey: input.idempotencyKey,
      modelId: input.modelId,
      bodyHash: input.bodyHash,
    });
    return claim ? { payer: claim.payer } : 'unauthorized';
  }

  /** Final reservation re-verifies the ticket; no unsigned payer ID is accepted. */
  async reserveManagedGroupTextCredits(
    ticket: string,
    input: { idempotencyKey: string; modelId: string; credits: number; bodyHash: string },
  ) {
    const claim = await verifyGroupAiTicket(this.env.DM_TICKET_SECRET, ticket, {
      reservationKey: input.idempotencyKey,
      modelId: input.modelId,
      bodyHash: input.bodyHash,
    });
    if (!claim) return 'unauthorized';
    const active = await this.env.DB.prepare(
      `SELECT id FROM users WHERE id=? AND banned_at IS NULL AND email_verified_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id=users.id)`,
    )
      .bind(claim.payer)
      .first<{ id: string }>();
    if (!active) return 'unauthorized';
    // A group AI is the owner's own character; deleting that character retires it everywhere.
    if (
      claim.characterId !== undefined &&
      !(await hasCharacter(this.env, claim.payer, claim.characterId))
    )
      return 'unauthorized';
    const result = await reserveCredits(this.env, claim.payer, {
      idempotencyKey: input.idempotencyKey,
      usageKind: 'agent',
      modelId: input.modelId,
      credits: input.credits,
    });
    if (!result.allowed) return result;
    try {
      const saved = await this.env.DB.prepare(
        `INSERT INTO group_ai_reservation_context
          (reservation_key,user_id,room_id,trigger_id,role_id,created_at)
         SELECT ?,r.user_id,?,?,?,? FROM credit_reservations r
         WHERE r.idempotency_key=? AND r.user_id=? AND r.status='pending'
         ON CONFLICT(reservation_key) DO NOTHING RETURNING reservation_key`,
      )
        .bind(
          input.idempotencyKey,
          claim.room,
          claim.triggerId,
          claim.roleId,
          Date.now(),
          input.idempotencyKey,
          claim.payer,
        )
        .first();
      if (!saved) throw new Error('group_credit_context_not_saved');
    } catch (error) {
      // No model request has begun. Do not leave a chargeable hold without its signed origin.
      await this.env.DB.prepare(
        "UPDATE credit_reservations SET status='released',updated_at=? WHERE idempotency_key=? AND user_id=? AND status='pending'",
      )
        .bind(Date.now(), input.idempotencyKey, claim.payer)
        .run()
        .catch(() => console.error('Group Credit context cleanup deferred'));
      throw error;
    }
    const capability = await registerTextBilling(this.env, input.idempotencyKey, claim.payer);
    return {
      ...result,
      capability,
      groupContext: {
        room: claim.room,
        triggerId: claim.triggerId,
        roleId: claim.roleId,
        payer: claim.payer,
      },
    };
  }
  async checkpointManagedText(
    key: string,
    capability: string,
    charge: number,
    metadata: Record<string, unknown>,
  ) {
    return checkpointTextBilling(this.env, key, capability, charge, metadata);
  }
  async finalizeManagedText(key: string, capability: string, action: 'settle' | 'release') {
    return finalizeTextBilling(this.env, key, capability, action);
  }
  async heartbeatManagedText(key: string, capability: string) {
    return heartbeatTextBilling(this.env, key, capability);
  }
  async inspectManagedText(key: string, capability: string) {
    return inspectTextBilling(this.env, key, capability);
  }

  async settleCredits(
    credentials: MarketClaimCredentials,
    idempotencyKey: string,
    chargedCredits: number,
    metadata: Record<string, unknown>,
  ): Promise<CreditReservationResult | 'unauthorized'> {
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    return user
      ? settleCredits(this.env, user.id, idempotencyKey, chargedCredits, metadata)
      : 'unauthorized';
  }

  async releaseCredits(
    credentials: MarketClaimCredentials,
    idempotencyKey: string,
  ): Promise<CreditReservationResult | 'unauthorized'> {
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    return user ? releaseCredits(this.env, user.id, idempotencyKey) : 'unauthorized';
  }

  async authorizeVoiceTicket(ticket: string): Promise<VoiceTicketQuotaResult | 'unauthorized'> {
    const userId = await voiceTicketUser(this.env, ticket);
    if (!userId) return 'unauthorized';
    return { subject: userId, ...(await creditBalance(this.env, userId)) };
  }

  /** Service-binding only: finalization survives expiry of the opening ticket. */
  async finalizeVoiceReservation(
    subject: string,
    reservationKey: string,
    input: VoiceFinalization,
  ) {
    return finalizeManagedVoiceReservation(
      this.env,
      subject,
      reservationKey,
      input,
      CREDIT_PRICE_VERSION,
    );
  }

  async reserveVoiceCredits(
    ticket: string,
    idempotencyKey: string,
    credits: number,
    context?: ReservationContext,
  ): Promise<CreditReservationResult | 'unauthorized'> {
    const userId = await voiceTicketUser(this.env, ticket);
    try {
      return userId
        ? await reserveWithContext(this.env, userId, idempotencyKey, context, () =>
            reserveCredits(this.env, userId, {
              idempotencyKey,
              usageKind: 'voice',
              modelId: 'voice',
              credits,
            }),
          )
        : 'unauthorized';
    } catch (error) {
      if (!(error instanceof ReservationContextRejected) || !userId) throw error;
      return {
        ...(await creditBalance(this.env, userId)),
        allowed: false,
        status: 'rejected',
        charged: null,
      };
    }
  }

  async settleVoiceCredits(
    ticket: string,
    idempotencyKey: string,
    credits: number,
    durationMs: number,
  ): Promise<CreditReservationResult | 'unauthorized'> {
    const userId = await voiceTicketUser(this.env, ticket);
    return userId
      ? settleCredits(this.env, userId, idempotencyKey, credits, {
          model: 'voice',
          durationMs,
          priceVersion: CREDIT_PRICE_VERSION,
        })
      : 'unauthorized';
  }

  async releaseVoiceCredits(
    ticket: string,
    idempotencyKey: string,
  ): Promise<CreditReservationResult | 'unauthorized'> {
    const userId = await voiceTicketUser(this.env, ticket);
    return userId ? releaseCredits(this.env, userId, idempotencyKey) : 'unauthorized';
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

  async marketItemCreator(itemId: string) {
    return publicMarketCreator(this.env.DB, itemId);
  }

  async marketCreatorItems(creatorIds: string[], viewerId?: string) {
    return publicMarketCreatorItems(this.env.DB, creatorIds, viewerId);
  }

  async marketCreatorsForItems(itemIds: string[]) {
    return publicMarketCreatorsForItems(this.env.DB, itemIds);
  }

  async marketAccountAccess(
    credentials: MarketClaimCredentials,
  ): Promise<MarketAccountAccessResult> {
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    if (!user) return 'unauthorized';
    return user.role === 'admin' ? 'admin' : 'user';
  }

  async marketAccountIdentity(credentials: MarketClaimCredentials): Promise<{ id: string } | null> {
    return marketAccountIdentityForCredentials(this.env, credentials);
  }

  /** Service-binding only; Market uses this to purge private R2 originals after account deletion. */
  async marketAccountActive(userId: string): Promise<boolean> {
    return marketAccountActiveForOwner(this.env, userId);
  }

  async rewardMarketDownload(
    credentials: MarketClaimCredentials,
    itemId: string,
  ): Promise<MarketRewardResult> {
    // currentUser already excludes banned and deleted accounts.
    const user = await currentUser(requestFromClaimCredentials(credentials), this.env);
    if (!user) return 'unauthorized';
    if (!user.email_verified_at) return 'ineligible';
    const claim = await this.env.DB.prepare(
      `SELECT m.user_id AS author_id FROM market_claims m JOIN users u ON u.id = m.user_id
       WHERE m.item_id = ? AND m.verified_at IS NOT NULL AND u.banned_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = u.id) LIMIT 1`,
    )
      .bind(itemId)
      .first<{ author_id: string }>();
    if (!claim || claim.author_id === user.id) return claim ? 'invalid' : 'not_found';
    const now = Date.now();
    const inserted = await this.env.DB.prepare(
      `INSERT OR IGNORE INTO market_download_rewards (item_id, downloader_user_id, author_user_id, created_at) VALUES (?, ?, ?, ?) RETURNING item_id`,
    )
      .bind(itemId, user.id, claim.author_id, now)
      .first();
    if (!inserted) return 'duplicate';
    // The cap is checked in the same statement as the payment so concurrent downloads cannot
    // each see room under it.
    const paid = await this.env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
       SELECT ?, 5, 'market_download_reward', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM credit_ledger WHERE user_id = ? AND kind = 'market_download_reward' AND created_at > ?) < ?`,
    )
      .bind(
        claim.author_id,
        `${itemId}:${user.id}`,
        CREDIT_PRICE_VERSION,
        JSON.stringify({ itemId }),
        now,
        claim.author_id,
        now - 24 * 60 * 60 * 1000,
        MARKET_DOWNLOAD_REWARDS_PER_AUTHOR_DAY,
      )
      .run();
    return paid.meta.changes > 0 ? 'ok' : 'capped';
  }

  async tipMarketItem(
    credentials: MarketClaimCredentials,
    itemId: string,
    amount: number,
  ): Promise<MarketRewardResult> {
    return tipMarketItemForCredentials(this.env, credentials, itemId, amount);
  }
}

/** A tip transfers existing Credit; recipient income is gated by the same atomic sender debit. */
export async function tipMarketItemForCredentials(
  env: Env,
  credentials: MarketClaimCredentials,
  itemId: string,
  amount: number,
): Promise<MarketRewardResult> {
  const user = await currentUser(requestFromClaimCredentials(credentials), env);
  if (!user) return 'unauthorized';
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000) return 'invalid';
  const claim = await env.DB.prepare(
    'SELECT user_id AS author_id FROM market_claims WHERE item_id=? AND verified_at IS NOT NULL LIMIT 1',
  )
    .bind(itemId)
    .first<{ author_id: string }>();
  if (!claim || claim.author_id === user.id) return 'invalid';
  const now = Date.now();
  const ref = `${itemId}:${user.id}:${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
   SELECT ?,?,'market_tip',?,?,?,? WHERE ? <= (SELECT COALESCE(SUM(amount_credits),0) FROM credit_ledger WHERE user_id=?) - (SELECT COALESCE(SUM(reserved_credits),0) FROM credit_reservations WHERE user_id=? AND status='pending' AND updated_at>?)
   AND EXISTS(SELECT 1 FROM market_claims m JOIN users u ON u.id=m.user_id WHERE m.item_id=? AND m.user_id=? AND m.verified_at IS NOT NULL AND u.banned_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id IN (?,?))`,
    ).bind(
      user.id,
      -amount,
      ref,
      CREDIT_PRICE_VERSION,
      JSON.stringify({ itemId }),
      now,
      amount,
      user.id,
      user.id,
      now - CREDIT_RESERVATION_TTL_MS,
      itemId,
      claim.author_id,
      user.id,
      claim.author_id,
    ),
    env.DB.prepare(
      `INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
   SELECT ?,?,'market_tip',?,?,?,? WHERE EXISTS(SELECT 1 FROM credit_ledger WHERE user_id=? AND reference_id=? AND kind='market_tip' AND amount_credits=?)`,
    ).bind(
      claim.author_id,
      amount,
      ref,
      CREDIT_PRICE_VERSION,
      JSON.stringify({ itemId }),
      now,
      user.id,
      ref,
      -amount,
    ),
  ]);
  return (await env.DB.prepare(
    "SELECT 1 FROM credit_ledger WHERE user_id=? AND reference_id=? AND kind='market_tip'",
  )
    .bind(user.id, ref)
    .first())
    ? 'ok'
    : 'invalid';
}

async function voiceTicketUser(env: Env, ticket: string): Promise<string | null> {
  const claims = await verifyDmTicket(env.DM_TICKET_SECRET, ticket, Date.now());
  if (!claims || claims.aud !== 'voice') return null;
  const user = await env.DB.prepare(
    `SELECT id FROM users
      WHERE id = ? AND banned_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = users.id)`,
  )
    .bind(claims.sub)
    .first<{ id: string }>();
  return user?.id ?? null;
}

/** Service-binding only: resolve the live account, including deletion and ban checks. */
export async function marketAccountIdentityForCredentials(
  env: Env,
  credentials: MarketClaimCredentials,
): Promise<{ id: string } | null> {
  const user = await currentUser(requestFromClaimCredentials(credentials), env);
  return user ? { id: user.id } : null;
}

export async function marketAccountActiveForOwner(
  env: Pick<Env, 'DB'>,
  userId: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return false;
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 FROM users WHERE id=?
     AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=users.id)`,
    )
      .bind(userId)
      .first(),
  );
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
  let links: unknown;
  try {
    links = row.links ? JSON.parse(String(row.links)) : [];
  } catch {
    links = [];
  }
  return {
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    birthDate: row.birth_date ?? null,
    location: row.location ?? null,
    links: safeProfileLinks(links),
    interests: row.interests ? (JSON.parse(String(row.interests)) as string[]) : [],
    // Discovery listing is the owner's choice (on by default); the profile page itself is
    // readable by every signed-in user either way.
    discoverable:
      row.discoverable === undefined || row.discoverable === null
        ? true
        : Number(row.discoverable) === 1,
    // Legacy visibility is ignored: every profile is readable by signed-in users.
    visibility: 'public' as const,
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

function newReferralCode(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
}

async function referralCodeForUser(env: Env, userId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await env.DB.prepare('SELECT code FROM referral_codes WHERE user_id = ?')
      .bind(userId)
      .first<{ code: string }>();
    if (existing) return existing.code;
    try {
      await env.DB.prepare(
        `INSERT INTO referral_codes (user_id, code, created_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO NOTHING`,
      )
        .bind(userId, newReferralCode(), Date.now())
        .run();
    } catch {
      // A random code collision is extraordinarily unlikely, but retrying here also
      // heals accounts created by the old Worker during the migration/deploy window.
    }
  }
  return (
    (
      await env.DB.prepare('SELECT code FROM referral_codes WHERE user_id = ?')
        .bind(userId)
        .first<{ code: string }>()
    )?.code ?? null
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
    from: { email: 'no-reply@0xnullai.com', name: '猫愿' },
    subject: `猫愿${action}`,
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
 * Per-photo visibility remains independent of the public profile. The owner
 * sees their own private photos here; other viewers see only what the photo
 * itself allows. Old private photos stay private after the profile change.
 *
 * No R2 bucket is bound yet, so in practice this returns an empty list: there
 * is no upload path, therefore no rows. The gating is written now because it is
 * the part that fails silently later, when uploads land and nobody re-derives
 * who was supposed to see what.
 */
async function visiblePhotos(
  env: Env,
  userId: string,
  isSelf: boolean,
  isFriend: boolean,
): Promise<unknown[]> {
  const visibilityFilter = isSelf
    ? ''
    : isFriend
      ? " AND visibility IN ('public', 'friends')"
      : " AND visibility = 'public'";
  const rows = await env.DB.prepare(
    `SELECT id, caption, visibility, created_at FROM user_photos
      WHERE user_id = ? AND status = 'ready' AND purpose = 'album'${visibilityFilter}
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, MAX_ALBUM_PHOTOS)
    .all();
  return (rows.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      caption: (row.caption as string | null) ?? null,
      visibility:
        row.visibility === 'public' || row.visibility === 'friends' ? row.visibility : 'private',
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
function contactListSql(direction: 'following' | 'followers', mutualOnly = false): string {
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
 ${mutualOnly ? 'AND EXISTS (SELECT 1 FROM user_follows z WHERE z.follower_id = f.followee_id AND z.followee_id = f.follower_id)' : ''}
 ORDER BY f.created_at DESC
 LIMIT ? OFFSET ?`;
}

/**
 * Monitoring-only entrypoint for Chat, which needs no ownership or Credit access. Keeping it
 * separate means Chat's binding cannot reach anything but the error counter.
 */
export class AuthMonitoringService extends WorkerEntrypoint<Env> {
  async recordServerErrors(report: unknown): Promise<boolean> {
    return recordServerErrors(this.env, report);
  }
}

const authWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env.ALLOWED_ORIGINS);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const ipHash = await sha256Hex(
      (request.headers.get('CF-Connecting-IP') ?? '0.0.0.0') + ':' + env.IP_PEPPER,
    );

    try {
      const backupResponse = await handleAuthChatBackupExport(request, env);
      if (backupResponse) return backupResponse;
      const autoMemoryResponse = await handleAutoMemory(request, env, cors);
      if (autoMemoryResponse) return autoMemoryResponse;
      const digestPreferenceResponse = await handleConversationDigestPreference(request, env, cors);
      if (digestPreferenceResponse) return digestPreferenceResponse;
      const lifeResponse = await handleCompanionLife(request, env, cors);
      if (lifeResponse) return lifeResponse;
      const voiceBillingReview = await handleVoiceBillingReview(request, env, cors);
      if (voiceBillingReview) return voiceBillingReview;
      const textBillingReview = await handleTextBillingReview(request, env, cors);
      if (textBillingReview) return textBillingReview;
      const mediaBillingReview = await handleMediaBillingReview(request, env, cors);
      if (mediaBillingReview) return mediaBillingReview;
      const asrBillingReview = await handleAsrBillingReview(request, env, cors);
      if (asrBillingReview) return asrBillingReview;
      const billingOrderResponse = await handleBillingOrders(request, env, cors);
      if (billingOrderResponse) return billingOrderResponse;
      const creditActivityResponse = await handleCreditActivity(request, env, cors);
      if (creditActivityResponse) return creditActivityResponse;
      const mediaResponse = await handleMediaJobs(request, env, cors);
      if (mediaResponse) return mediaResponse;
      const workspaceResponse = await handleAgentWorkspace(request, env, cors);
      if (workspaceResponse) return workspaceResponse;
      const agentRunsResponse = await handleAgentRuns(request, env, cors);
      if (agentRunsResponse) return agentRunsResponse;
      const memoryContextResponse = await handleMemoryContext(request, env, cors);
      if (memoryContextResponse) return memoryContextResponse;
      const memoryFactsResponse = await handleMemoryFacts(request, env, cors);
      if (memoryFactsResponse) return memoryFactsResponse;
      const accountMemoryAccessResponse = await handleAccountMemoryAccess(request, env, cors);
      if (accountMemoryAccessResponse) return accountMemoryAccessResponse;
      const asrResponse = await handleVoiceAttachmentAsr(request, env, cors, {
        reserve: (userId, key, credits) =>
          reserveCredits(env, userId, {
            idempotencyKey: key,
            usageKind: 'agent',
            modelId: 'voice-asr',
            credits,
          }),
        settle: (userId, key, charge, metadata) =>
          settleCredits(env, userId, key, charge, metadata),
        release: (userId, key) => releaseCredits(env, userId, key),
      });
      if (asrResponse) return asrResponse;
      const ttsResponse = await handleManagedTts(request, env, cors, {
        reserve: (userId, key, credits) =>
          reserveCredits(env, userId, {
            idempotencyKey: key,
            usageKind: 'agent',
            modelId: 'managed-tts',
            credits,
          }),
        settle: (userId, key, charge, metadata) =>
          settleCredits(env, userId, key, charge, metadata),
        release: (userId, key) => releaseCredits(env, userId, key),
      });
      if (ttsResponse) return ttsResponse;
      const attachmentResponse = await handleConversationAttachments(request, env, cors);
      if (attachmentResponse) return attachmentResponse;
      const conversationResponse = await handleServerConversations(request, env, cors);
      if (conversationResponse) return conversationResponse;
      const appearanceResponse = await handleCharacterAppearance(request, env, cors);
      if (appearanceResponse) return appearanceResponse;
      const draftResponse = await handleCharacterDrafts(request, env, cors);
      if (draftResponse) return draftResponse;
      const relationshipResponse = await handleCharacterRelationships(request, env, cors);
      if (relationshipResponse) return relationshipResponse;
      const scheduleResponse = await handleCompanionSchedules(request, env, cors);
      if (scheduleResponse) return scheduleResponse;
      const pushResponse = handleRetiredPushRegistrations(request, cors);
      if (pushResponse) return pushResponse;
      const monitoringResponse = await handleRuntimeMonitoring(request, env, cors, ipHash);
      if (monitoringResponse) return monitoringResponse;
      const memoryResponse = await handlePersonalMemories(request, env, cors);
      if (memoryResponse) return memoryResponse;
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
        const body = await readJson(request, { lenient: true });
        // Consent to the current 用户协议 is part of the account. A client that
        // predates the consent box sends no version (or an older one) and must be updated first;
        // checked before anything else so that client gets this one clear answer.
        if (body.acceptedTerms !== LEGAL_TERMS_VERSION) {
          return err('请更新到最新版本后注册', 400, cors);
        }
        const invalid = validateCredentials(body.username, body.password);
        if (invalid) return err(invalid, 400, cors);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
          return err('请输入有效邮箱', 400, cors);
        }
        const referralCode =
          typeof body.referralCode === 'string' ? body.referralCode.trim().toUpperCase() : '';
        if (referralCode && !REFERRAL_CODE.test(referralCode)) {
          return err('邀请链接无效', 400, cors);
        }
        const inviter = referralCode
          ? await env.DB.prepare(
              `SELECT u.id FROM referral_codes r
               JOIN users u ON u.id = r.user_id
               WHERE r.code = ? AND u.email_verified_at IS NOT NULL AND u.banned_at IS NULL`,
            )
              .bind(referralCode)
              .first<{ id: string }>()
          : null;
        if (referralCode && !inviter) return err('邀请链接无效或邀请人尚未完成验证', 400, cors);

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
        const now = Date.now();
        try {
          const statements = [
            env.DB.prepare(
              `INSERT INTO users (id, username, display_name, password_hash, email, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            ).bind(
              id,
              username,
              typeof body.displayName === 'string' && body.displayName.trim()
                ? body.displayName.trim().slice(0, 24)
                : (body.username as string),
              await hashPassword(body.password as string),
              email,
              now,
            ),
            env.DB.prepare(
              'INSERT INTO referral_codes (user_id, code, created_at) VALUES (?, ?, ?)',
            ).bind(id, newReferralCode(), now),
            env.DB.prepare(
              'INSERT INTO legal_acceptances (user_id, terms_version, accepted_at) VALUES (?, ?, ?)',
            ).bind(id, LEGAL_TERMS_VERSION, now),
          ];
          if (inviter) {
            statements.push(
              env.DB.prepare(
                `INSERT INTO referrals
                 (invitee_user_id, inviter_user_id, code, status, reward_credits, created_at)
                 VALUES (?, ?, ?, 'pending', ?, ?)`,
              ).bind(id, inviter.id, referralCode, REFERRAL_REWARD_CREDITS, now),
            );
          }
          await env.DB.batch(statements);
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
        const body = await readJson(request, { lenient: true });
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
          env.DB.prepare(
            `INSERT INTO credit_ledger
             (user_id, amount_credits, kind, reference_id, price_version, created_at)
             SELECT inviter_user_id, reward_credits, 'referral_reward', invitee_user_id, ?, ?
             FROM referrals
             WHERE invitee_user_id = ? AND status = 'pending'
             ON CONFLICT (user_id, kind, reference_id) DO NOTHING`,
          ).bind(CREDIT_PRICE_VERSION, now, action.user_id),
          env.DB.prepare(
            `UPDATE referrals SET status = 'rewarded', qualified_at = ?
             WHERE invitee_user_id = ? AND status = 'pending'`,
          ).bind(now, action.user_id),
          // The ledger's (user, kind, reference) key makes the welcome grant one per account.
          env.DB.prepare(
            `INSERT INTO credit_ledger
             (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
             VALUES (?, ?, 'admin_gift', ?, ?, ?, ?)
             ON CONFLICT (user_id, kind, reference_id) DO NOTHING`,
          ).bind(
            action.user_id,
            WELCOME_CREDITS,
            WELCOME_REFERENCE,
            CREDIT_PRICE_VERSION,
            JSON.stringify({ reason: 'welcome' }),
            now,
          ),
        ]);
        return json({ ok: true }, 200, cors);
      }

      // ── Referrals and campaign credit ──
      if (path === '/api/auth/referral' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('完成邮箱验证后即可邀请好友', 403, cors);
        const [code, balance, counts, activity] = await Promise.all([
          referralCodeForUser(env, user.id),
          env.DB.prepare(
            'SELECT COALESCE(SUM(amount_credits), 0) AS credits FROM credit_ledger WHERE user_id = ?',
          )
            .bind(user.id)
            .first<{ credits: number }>(),
          env.DB.prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END), 0) AS rewarded,
               COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
             FROM referrals WHERE inviter_user_id = ?`,
          )
            .bind(user.id)
            .first<{ rewarded: number; pending: number }>(),
          env.DB.prepare(
            `SELECT status, reward_credits, created_at, qualified_at
               FROM referrals
              WHERE inviter_user_id = ?
              ORDER BY created_at DESC
              LIMIT 20`,
          )
            .bind(user.id)
            .all(),
        ]);
        if (!code) return err('邀请功能暂不可用', 503, cors);
        return json(
          {
            code,
            balanceCredits: balance?.credits ?? 0,
            rewardCredits: REFERRAL_REWARD_CREDITS,
            rewardedCount: counts?.rewarded ?? 0,
            pendingCount: counts?.pending ?? 0,
            activity: (activity.results ?? []).map((raw) => {
              const row = raw as Record<string, unknown>;
              return {
                status: row.status,
                rewardCredits: Number(row.reward_credits),
                createdAt: Number(row.created_at),
                qualifiedAt: row.qualified_at == null ? null : Number(row.qualified_at),
              };
            }),
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/password/forgot' && request.method === 'POST') {
        const body = await readJson(request, { lenient: true });
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
        const body = await readJson(request, { lenient: true });
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

      if (path === '/api/auth/credits/balance' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        return json(await creditBalance(env, user.id), 200, cors);
      }

      if (path === '/api/auth/credits/ledger' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const { limit, offset } = pageParams(url);
        const rows = await env.DB.prepare(
          `SELECT amount_credits, kind, reference_id, price_version, created_at
             FROM credit_ledger WHERE user_id = ?
            ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
          .bind(user.id, limit + 1, offset)
          .all<Record<string, unknown>>();
        const entries = rows.results.slice(0, limit).map((row) => ({
          amountCredits: Number(row.amount_credits),
          kind: String(row.kind),
          referenceId: String(row.reference_id),
          priceVersion: row.price_version == null ? null : String(row.price_version),
          createdAt: Number(row.created_at),
        }));
        return json(
          { entries, nextOffset: rows.results.length > limit ? offset + limit : null },
          200,
          cors,
        );
      }

      if (path === '/api/auth/admin/credits/grant' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const body = await readJson(request, { lenient: true });
        const username =
          typeof body.username === 'string'
            ? body.username.trim().replace(/^@+/, '').toLowerCase()
            : '';
        const amountCny = Math.trunc(Number(body.amountCny));
        const externalReference =
          typeof body.externalReference === 'string' ? body.externalReference.trim() : '';
        const packages = new Map([
          [7, 1_000],
          [35, 5_000],
          [70, 10_000],
          [140, 20_000],
        ]);
        const amountCredits = packages.get(amountCny);
        if (!username || !amountCredits || !/^[A-Za-z0-9._:-]{4,128}$/.test(externalReference)) {
          return err('充值用户、固定档位或外部流水号无效', 400, cors);
        }
        const target = await env.DB.prepare(
          'SELECT id, username FROM users WHERE username = ? AND banned_at IS NULL',
        )
          .bind(username)
          .first<{ id: string; username: string }>();
        if (!target) return err('用户不存在', 404, cors);
        const now = Date.now();
        const daily = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount_credits), 0) AS credits
             FROM admin_credit_audit WHERE operator_user_id = ? AND created_at >= ?`,
        )
          .bind(user.id, now - 24 * 60 * 60 * 1000)
          .first<{ credits: number }>();
        if (Number(daily?.credits ?? 0) + amountCredits > 200_000) {
          return err('该管理员 24 小时人工入账已达上限', 429, cors);
        }
        const duplicate = await env.DB.prepare(
          "SELECT 1 FROM credit_ledger WHERE kind = 'manual_purchase' AND reference_id = ?",
        )
          .bind(externalReference)
          .first();
        if (duplicate) return err('该外部流水已经入账', 409, cors);
        try {
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO credit_ledger
                (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
               VALUES (?, ?, 'manual_purchase', ?, ?, ?, ?)`,
            ).bind(
              target.id,
              amountCredits,
              externalReference,
              CREDIT_PRICE_VERSION,
              JSON.stringify({ amountCny, operatorUserId: user.id }),
              now,
            ),
            env.DB.prepare(
              `INSERT INTO admin_credit_audit
                (operator_user_id, target_user_id, action, amount_cny, amount_credits,
                 external_reference, created_at)
               VALUES (?, ?, 'manual_purchase', ?, ?, ?, ?)`,
            ).bind(user.id, target.id, amountCny, amountCredits, externalReference, now),
          ]);
        } catch (cause) {
          if (String(cause).includes('UNIQUE')) return err('该外部流水已经入账', 409, cors);
          throw cause;
        }
        return json(
          { ok: true, username: target.username, amountCny, amountCredits, createdAt: now },
          201,
          cors,
        );
      }

      const adminCreditUser = path.match(/^\/api\/auth\/admin\/credits\/users\/([^/]+)$/);
      if (adminCreditUser && request.method === 'GET') {
        const admin = await currentUser(request, env);
        if (!admin || admin.role !== 'admin') return err('无管理权限', 403, cors);
        const username = decodeURIComponent(adminCreditUser[1] ?? '')
          .trim()
          .replace(/^@+/, '')
          .toLowerCase();
        if (!username) return err('用户不存在', 404, cors);
        const target = await env.DB.prepare(
          'SELECT id, username, display_name, email, email_verified_at, created_at FROM users WHERE username = ? AND banned_at IS NULL',
        )
          .bind(username)
          .first<Record<string, unknown>>();
        if (!target) return err('用户不存在', 404, cors);
        const balance = await creditBalance(env, String(target.id));
        return json(
          {
            user: {
              id: String(target.id),
              username: String(target.username),
              displayName: String(target.display_name ?? ''),
              email: target.email == null ? null : String(target.email),
              emailVerified: target.email_verified_at != null,
            },
            credit: balance,
            createdAt: Number(target.created_at),
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/admin/credits/gift' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const body = await readJson(request, { lenient: true });
        const username =
          typeof body.username === 'string'
            ? body.username.trim().replace(/^@+/, '').toLowerCase()
            : '';
        const amountCredits = Number(body.amountCredits);
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (
          !username ||
          !Number.isSafeInteger(amountCredits) ||
          amountCredits < 1 ||
          amountCredits > 20_000 ||
          reason.length < 2 ||
          reason.length > 200
        ) {
          return err('赠送用户、Credit 数量或原因无效', 400, cors);
        }
        const target = await env.DB.prepare(
          'SELECT id, username FROM users WHERE username = ? AND banned_at IS NULL',
        )
          .bind(username)
          .first<{ id: string; username: string }>();
        if (!target) return err('用户不存在', 404, cors);
        const now = Date.now();
        const daily = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount_credits), 0) AS credits
             FROM admin_credit_audit WHERE operator_user_id = ? AND created_at >= ?`,
        )
          .bind(user.id, now - 24 * 60 * 60 * 1000)
          .first<{ credits: number }>();
        if (Number(daily?.credits ?? 0) + amountCredits > 200_000) {
          return err('该管理员 24 小时人工入账已达上限', 429, cors);
        }
        const referenceId = `gift:${crypto.randomUUID()}`;
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO credit_ledger
              (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
             VALUES (?, ?, 'admin_gift', ?, ?, ?, ?)`,
          ).bind(
            target.id,
            amountCredits,
            referenceId,
            null,
            JSON.stringify({ reason, operatorUserId: user.id }),
            now,
          ),
          env.DB.prepare(
            `INSERT INTO admin_credit_audit
              (operator_user_id, target_user_id, action, amount_cny, amount_credits,
               external_reference, reason, created_at)
             VALUES (?, ?, 'admin_gift', NULL, ?, ?, ?, ?)`,
          ).bind(user.id, target.id, amountCredits, referenceId, reason, now),
        ]);
        return json(
          { ok: true, username: target.username, amountCredits, referenceId, createdAt: now },
          201,
          cors,
        );
      }

      if (path === '/api/auth/voice/ticket' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!env.DM_TICKET_SECRET) return err('语音服务尚未启用', 503, cors);
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

      if (path === '/api/auth/group-agent/ticket' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        if (!env.DM_TICKET_SECRET) return err('Chat 尚未启用', 503, cors);
        let body: { room?: unknown; characterId?: unknown };
        try {
          body = await readJson<typeof body>(request);
        } catch {
          return err('请求无效', 400, cors);
        }
        if (
          typeof body.room !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(body.room) ||
          body.room.startsWith('dm:') ||
          !validCharacterId(body.characterId)
        )
          return err('请求无效', 400, cors);
        if (!(await hasCharacter(env, user.id, body.characterId)))
          return err('只能把自己已有的角色带进群', 403, cors);
        // Group AI always runs on the platform model and bills its owner, so an owner with
        // nothing to spend cannot bring one in. Each reply still reserves on its own.
        if ((await creditBalance(env, user.id)).available <= 0)
          return err('群 AI 使用 Credit，当前余额不足', 402, cors);
        const now = Date.now();
        const ticket = await signDmTicket(env.DM_TICKET_SECRET, {
          aud: 'group-agent',
          sub: user.id,
          room: body.room,
          characterId: body.characterId,
          iat: now,
          exp: now + DM_TICKET_TTL_MS,
        });
        return json({ ticket, expiresAt: now + DM_TICKET_TTL_MS }, 200, cors);
      }

      if (path === '/api/auth/admin/stats' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const now = Date.now();
        const startOfDay = new Date(new Date(now).toISOString().slice(0, 10)).getTime();
        const [users, verified, sessions, registrations, usage, reports] = await Promise.all([
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
            `SELECT
               COALESCE(SUM(CASE WHEN kind = 'usage' THEN -amount_credits ELSE 0 END), 0) AS used,
               COALESCE(SUM(CASE WHEN kind = 'manual_purchase' THEN amount_credits ELSE 0 END), 0) AS purchased
             FROM credit_ledger WHERE created_at >= ?`,
          )
            .bind(startOfDay)
            .first<{ used: number; purchased: number }>(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM user_reports WHERE status = 'open'").first<{
            n: number;
          }>(),
        ]);
        return json(
          {
            generatedAt: now,
            users: users?.n ?? 0,
            verifiedUsers: verified?.n ?? 0,
            activeSessions: sessions?.n ?? 0,
            registrationAttempts24h: registrations?.n ?? 0,
            creditUsedToday: usage?.used ?? 0,
            creditPurchasedToday: usage?.purchased ?? 0,
            openReports: reports?.n ?? 0,
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/admin/reports' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const rows = await env.DB.prepare(
          `SELECT r.id, r.reason, r.details, r.status, r.created_at,
                  reporter.username AS reporter_username,
                  reported.username AS reported_username
             FROM user_reports r
             JOIN users reporter ON reporter.id = r.reporter_user_id
             JOIN users reported ON reported.id = r.reported_user_id
            ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
            LIMIT 100`,
        ).all();
        return json({ reports: rows.results ?? [] }, 200, cors);
      }

      if (path.startsWith('/api/auth/admin/reports/') && request.method === 'PATCH') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const id = decodeURIComponent(path.slice('/api/auth/admin/reports/'.length));
        const body = await readJson(request, { lenient: true });
        const status = body.status;
        if (status !== 'reviewed' && status !== 'dismissed') return err('处理状态无效', 400, cors);
        await env.DB.prepare('UPDATE user_reports SET status = ?, reviewed_at = ? WHERE id = ?')
          .bind(status, Date.now(), id)
          .run();
        return json({ ok: true }, 200, cors);
      }

      // ── Logout ──
      if (path === '/api/auth/sessions' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const token = readToken(request);
        const currentHash = token ? await sha256Hex(token) : '';
        const rows = await env.DB.prepare(
          `SELECT token_hash, created_at, expires_at, user_agent
             FROM sessions WHERE user_id = ? AND expires_at > ?
             ORDER BY created_at DESC`,
        )
          .bind(user.id, Date.now())
          .all();
        return json(
          {
            sessions: (rows.results ?? []).map((raw) => {
              const row = raw as Record<string, unknown>;
              return {
                id: String(row.token_hash),
                createdAt: Number(row.created_at),
                expiresAt: Number(row.expires_at),
                userAgent: row.user_agent == null ? null : String(row.user_agent),
                current: row.token_hash === currentHash,
              };
            }),
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/sessions/others' && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const token = readToken(request);
        if (!token) return err('未登录', 401, cors);
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
          .bind(user.id, await sha256Hex(token))
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (path.startsWith('/api/auth/sessions/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const sessionId = decodeURIComponent(path.slice('/api/auth/sessions/'.length));
        if (!/^[a-f0-9]{64}$/.test(sessionId)) return err('会话不存在', 404, cors);
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash = ?')
          .bind(user.id, sessionId)
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (path === '/api/auth/logout' && request.method === 'POST') {
        return logout(request, env, cors);
      }

      // ── Profile ──
      //
      // Every field is optional; an account that fills in nothing has to work
      // exactly as well. Two deliberate limits, for this product's users
      // rather than out of caution: `location` is region-level and capped
      // short, because a street address in a leaked database is a physical
      // risk here and no feature needs one. Profile visibility is public to
      // signed-in users; legacy visibility values are no longer honored.
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
        const body = await readJson(request);

        const birthDate = typeof body.birthDate === 'string' ? body.birthDate.trim() : '';
        if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
          return err('生日格式应为 YYYY-MM-DD', 400, cors);
        }
        // An adult-only product: a birth date that is present and under 18 is
        // rejected outright rather than stored and checked later.
        if (birthDate && ageFrom(birthDate) < 18) {
          return err('本产品仅面向成年人', 400, cors);
        }

        const interests = Array.isArray(body.interests)
          ? body.interests
              .filter((value): value is string => typeof value === 'string')
              .map((value) => value.trim().slice(0, 24))
              .filter(Boolean)
              .slice(0, 8)
          : [];
        const visibility = 'public';
        const submittedLinks = body.links ?? [];
        if (
          !Array.isArray(submittedLinks) ||
          submittedLinks.length > 5 ||
          submittedLinks.some((link) => normalizeProfileLink(link) === null)
        )
          return err('主页链接须为 HTTP(S) 网址', 400, cors);
        const links = submittedLinks.map((link) => normalizeProfileLink(link));

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
          `INSERT INTO user_profiles
            (user_id, avatar_url, bio, birth_date, location, links, interests, discoverable, visibility, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             avatar_url = excluded.avatar_url, bio = excluded.bio,
             birth_date = excluded.birth_date, location = excluded.location,
             links = excluded.links, interests = excluded.interests,
             discoverable = excluded.discoverable, visibility = excluded.visibility,
             updated_at = excluded.updated_at`,
        )
          .bind(
            user.id,
            avatarUrl,
            typeof body.bio === 'string' ? body.bio.slice(0, 500) : null,
            birthDate || null,
            // Region-level. The cap is the point, not a guess at a sane length.
            typeof body.location === 'string' ? body.location.slice(0, 60) : null,
            JSON.stringify(links),
            JSON.stringify(interests),
            body.discoverable === false ? 0 : 1,
            visibility,
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
        const uploaded = await readBodyBounded(request, MAX_PHOTO_BYTES);
        if (uploaded == null) return err('图片过大', 413, cors);
        if (uploaded.byteLength === 0) return err('图片为空', 400, cors);
        let bytes: Uint8Array;
        try {
          bytes = sanitizePhoto(uploaded, mime);
        } catch {
          return err('图片损坏或尺寸超过 4096 像素', 400, cors);
        }

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
        const requestedVisibility = request.headers.get('x-photo-visibility');
        const visibility =
          requestedVisibility === 'public' || requestedVisibility === 'friends'
            ? requestedVisibility
            : 'private';
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
        return json({ photos: await visiblePhotos(env, user.id, true, false) }, 200, cors);
      }

      /**
       * Serve one photo's bytes.
       *
       * The gate is re-derived here from scratch rather than trusting that the
       * caller got this URL from a profile they were allowed to see. URLs get
       * copied and pasted, so each read rechecks login, block and per-photo
       * visibility before touching R2.
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
        const viewer = await currentUser(request, env);
        if (!viewer) return err('未登录', 401, cors);
        const id = decodeURIComponent(path.slice('/api/auth/photos/'.length, -'/content'.length));
        const photo = await env.DB.prepare(
          "SELECT user_id, object_key, visibility FROM user_photos WHERE id = ? AND status = 'ready'",
        )
          .bind(id)
          .first<{ user_id: string; object_key: string; visibility: string }>();
        if (!photo) return err('不存在', 404, cors);

        const isOwner = viewer.id === photo.user_id;
        if (!isOwner) {
          if (await blockedBetween(env, viewer.id, photo.user_id)) {
            return err('不存在', 404, cors);
          }
          const isFriend = await mutualFollow(env, viewer.id, photo.user_id);
          if (photo.visibility !== 'public' && !(photo.visibility === 'friends' && isFriend)) {
            return err('不存在', 404, cors);
          }
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
        const body = await readJson(request);
        if (
          body.visibility !== 'public' &&
          body.visibility !== 'friends' &&
          body.visibility !== 'private'
        ) {
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
        const paged = url.searchParams.has('limit') || url.searchParams.has('cursor');
        const requestedLimit = Number(url.searchParams.get('limit') ?? '100');
        if (
          paged &&
          (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
        )
          return err('分页大小无效', 400, cors);
        const rawCursor = url.searchParams.get('cursor');
        const cursor = decodeChatRoomCursor(rawCursor);
        if (rawCursor && (!cursor || cursor.accountHash !== (await chatRoomAccountHash(user.id))))
          return err('群聊游标无效', 400, cors);
        const rows = await env.DB.prepare(
          `SELECT code, name, owner_key, joined_at, updated_at FROM user_chat_rooms
           WHERE user_id = ?
             AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND code > ?))
           ORDER BY updated_at DESC, code ASC LIMIT ?`,
        )
          .bind(
            user.id,
            cursor?.updatedAt ?? null,
            cursor?.updatedAt ?? null,
            cursor?.updatedAt ?? null,
            cursor?.code ?? '',
            paged ? requestedLimit + 1 : 1001,
          )
          .all<{
            code: string;
            name: string;
            owner_key: string | null;
            joined_at: number;
            updated_at: number;
          }>();
        const visible = paged ? rows.results.slice(0, requestedLimit) : rows.results;
        const last = visible.at(-1);
        return json(
          {
            rooms: visible.map((room) => ({
              code: room.code,
              name: room.name,
              joinedAt: room.joined_at,
              updatedAt: room.updated_at,
              ...(room.owner_key ? { ownerKey: room.owner_key } : {}),
            })),
            ...(paged
              ? {
                  nextCursor:
                    rows.results.length > requestedLimit && last
                      ? encodeChatRoomCursor({
                          updatedAt: last.updated_at,
                          code: last.code,
                          accountHash: await chatRoomAccountHash(user.id),
                        })
                      : null,
                }
              : {}),
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/chat-rooms' && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, cors);
        const body = await readJson(request, { lenient: true });
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
        const body = await readJson(request, { lenient: true });
        const ownerKey = typeof body.ownerKey === 'string' ? body.ownerKey : '';
        const owner = await env.DB.prepare(
          'SELECT 1 FROM user_chat_rooms WHERE user_id = ? AND code = ? AND owner_key = ?',
        )
          .bind(user.id, code, ownerKey)
          .first();
        if (!owner || !ownerKey) return err('无权关闭房间', 403, cors);
        // The stored owner key is whatever this account once uploaded, so it proves nothing about
        // the room. Only the Chat RoomDO knows the real owner and it closes the room itself; other
        // members' bookmarks then stop resolving there and each client forgets its own on `closed`.
        await env.DB.prepare('DELETE FROM user_chat_rooms WHERE user_id = ? AND code = ?')
          .bind(user.id, code)
          .run();
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
        const body = await readJson<{ payload?: unknown; version?: number }>(request, {
          maxBytes: MAX_SETTINGS_BYTES * 2,
        });
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
        // Newer clients page by the (updated_at, id) tuple, like /content. Older ones only send
        // the numeric `since`, which skips rows sharing the last row's timestamp at a page break.
        const rawCursor = url.searchParams.get('cursor');
        const cursor = decodeContentCursor(rawCursor);
        if (rawCursor && !cursor) return err('同步游标无效', 400, cors);
        const afterUpdatedAt = cursor?.updatedAt ?? since;
        const rows = await env.DB.prepare(
          `SELECT id, payload, client_updated_at, updated_at, deleted_at
             FROM agent_sessions
            WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND ? IS NOT NULL AND id > ?))
            ORDER BY updated_at ASC, id ASC
            LIMIT ?`,
        )
          .bind(
            user.id,
            afterUpdatedAt,
            afterUpdatedAt,
            cursor?.id ?? null,
            cursor?.id ?? '',
            AGENT_SESSION_PAGE_SIZE,
          )
          .all<Record<string, unknown>>();
        const hasMore = (rows.results ?? []).length === AGENT_SESSION_PAGE_SIZE;
        let resultRows = rows.results ?? [];
        // For a numeric-only client, end a full page before the last timestamp group so its
        // `since` cannot split that group; the trimmed rows lead the next page instead.
        if (!cursor && hasMore) {
          const lastUpdatedAt = resultRows.at(-1)!.updated_at;
          const kept = resultRows.filter((row) => row.updated_at !== lastUpdatedAt);
          if (kept.length) resultRows = kept;
        }
        const last = resultRows.at(-1);
        return json(
          {
            sessions: resultRows.map((row) => {
              return {
                id: row.id,
                session: row.deleted_at == null ? JSON.parse(String(row.payload)) : null,
                clientUpdatedAt: row.client_updated_at,
                updatedAt: row.updated_at,
                deleted: row.deleted_at != null,
              };
            }),
            hasMore,
            cursor: last ? Number(last.updated_at) : afterUpdatedAt,
            nextCursor:
              hasMore && last
                ? encodeContentCursor({ updatedAt: Number(last.updated_at), id: String(last.id) })
                : null,
          },
          200,
          cors,
        );
      }

      if (path === '/api/auth/agent-sessions' && request.method === 'PUT') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = await readJson<{
          sessions?: {
            id: string;
            session?: unknown;
            clientUpdatedAt?: number;
            deleted?: boolean;
          }[];
        }>(request, { maxBytes: MAX_SYNC_BATCH_BYTES });
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
        const body = await readJson<{
          items?: {
            id: string;
            kind: string;
            name: string;
            payload: unknown;
            deleted?: boolean;
            hidden?: boolean;
            order?: number;
          }[];
        }>(request, { maxBytes: MAX_SYNC_BATCH_BYTES });
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
        const body = await readJson<{
          selectedId?: unknown;
          hiddenBuiltinIds?: unknown;
        }>(request);
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
        const body = await readJson(request, { lenient: true });
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

      // Remove somebody from my followers without blocking them. This deletes
      // their direction only; my own follow remains, so the action does exactly
      // what its label says and does not silently change a second preference.
      if (path.startsWith('/api/auth/follower/') && request.method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const targetId = decodeURIComponent(path.slice('/api/auth/follower/'.length));
        await env.DB.prepare('DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?')
          .bind(targetId, user.id)
          .run();
        await severDm(env, user.id, targetId);
        return json({ ok: true }, 200, cors);
      }

      if (
        (path === '/api/auth/following' ||
          path === '/api/auth/followers' ||
          path === '/api/auth/contacts') &&
        request.method === 'GET'
      ) {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const { limit, offset } = pageParams(url);
        const rows = await env.DB.prepare(
          contactListSql(
            path === '/api/auth/followers' ? 'followers' : 'following',
            path === '/api/auth/contacts',
          ),
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

      if (path === '/api/auth/discover' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const { limit, offset } = pageParams(url);
        const rows = await env.DB.prepare(
          `SELECT u.id, u.username, u.display_name, p.avatar_url, p.bio, p.location,
                  p.interests, p.updated_at,
                  EXISTS (SELECT 1 FROM user_follows f
                           WHERE f.follower_id = ? AND f.followee_id = u.id) AS following,
                  EXISTS (SELECT 1 FROM user_follows f
                           WHERE f.follower_id = u.id AND f.followee_id = ?) AS followed_by
             FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
            WHERE u.id <> ?
              AND u.banned_at IS NULL
              AND COALESCE(p.discoverable, 1) = 1
              AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = u.id)
              AND NOT EXISTS (SELECT 1 FROM user_blocks b
                    WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
                       OR (b.blocker_id = u.id AND b.blocked_id = ?))
            ORDER BY COALESCE(p.updated_at, u.created_at) DESC, u.id
            LIMIT ? OFFSET ?`,
        )
          .bind(user.id, user.id, user.id, user.id, user.id, limit + 1, offset)
          .all<Record<string, unknown>>();
        const users = rows.results.slice(0, limit).map((row) => ({
          id: String(row.id),
          username: String(row.username),
          displayName: String(row.display_name),
          avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
          bio: row.bio == null ? null : String(row.bio),
          location: row.location == null ? null : String(row.location),
          interests: row.interests ? (JSON.parse(String(row.interests)) as string[]) : [],
          following: Number(row.following) === 1,
          followedBy: Number(row.followed_by) === 1,
        }));
        return json(
          { users, nextOffset: rows.results.length > limit ? offset + limit : null },
          200,
          cors,
        );
      }

      if (path === '/api/auth/block' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = await readJson(request, { lenient: true });
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

      if (path === '/api/auth/report' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const body = await readJson(request, { lenient: true });
        const targetId = typeof body.userId === 'string' ? body.userId : '';
        const reason = typeof body.reason === 'string' ? body.reason : '';
        const details = typeof body.details === 'string' ? body.details.trim() : '';
        if (!targetId || !REPORT_REASONS.has(reason)) return err('举报信息不完整', 400, cors);
        if (targetId === user.id) return err('不能举报自己', 400, cors);
        if (details.length > MAX_REPORT_DETAILS) return err('补充说明不能超过 500 字', 400, cors);
        const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
          .bind(targetId)
          .first();
        if (!target) return err('用户不存在', 404, cors);
        // The open-pair unique index decides, so two concurrent reports cannot race into a 500.
        const inserted = await env.DB.prepare(
          `INSERT INTO user_reports
           (id, reporter_user_id, reported_user_id, reason, details, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?) ON CONFLICT DO NOTHING`,
        )
          .bind(crypto.randomUUID(), user.id, targetId, reason, details || null, Date.now())
          .run();
        if (!inserted.meta.changes) return json({ ok: true, duplicate: true }, 200, cors);
        return json({ ok: true, duplicate: false }, 201, cors);
      }

      if (path === '/api/auth/credit-red-packets' && request.method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        return err('充值内测中，请联系管理员 QQ 询问', 503, cors);
      }

      if (path === '/api/auth/credit-red-packets' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('未登录', 401, cors);
        const rows = await env.DB.prepare(
          `SELECT id, code, note, status, reject_reason, created_at, processed_at
             FROM credit_red_packet_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
          .bind(user.id)
          .all<Record<string, unknown>>();
        return json(
          {
            items: rows.results.map((row) => ({
              id: String(row.id),
              code: String(row.code),
              note: row.note == null ? null : String(row.note),
              status: String(row.status),
              rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
              createdAt: Number(row.created_at),
              processedAt: row.processed_at == null ? null : Number(row.processed_at),
            })),
          },
          200,
          cors,
        );
      }

      const redPacketApprove = path.match(
        /^\/api\/auth\/admin\/credit-red-packets\/([^/]+)\/approve$/,
      );
      const redPacketReject = path.match(
        /^\/api\/auth\/admin\/credit-red-packets\/([^/]+)\/reject$/,
      );
      if (path === '/api/auth/admin/credit-red-packets' && request.method === 'GET') {
        const user = await currentUser(request, env);
        if (!user || user.role !== 'admin') return err('无管理权限', 403, cors);
        const rows = await env.DB.prepare(
          `SELECT r.id, r.code, r.note, r.status, r.reject_reason, r.created_at, r.processed_at, u.username
             FROM credit_red_packet_requests r JOIN users u ON u.id = r.user_id
            ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100`,
        ).all<Record<string, unknown>>();
        return json(
          {
            items: rows.results.map((row) => ({
              id: String(row.id),
              username: String(row.username),
              code: String(row.code),
              note: row.note == null ? null : String(row.note),
              status: String(row.status),
              rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
              createdAt: Number(row.created_at),
              processedAt: row.processed_at == null ? null : Number(row.processed_at),
            })),
          },
          200,
          cors,
        );
      }
      if (redPacketApprove && request.method === 'POST') {
        const admin = await currentUser(request, env);
        if (!admin || admin.role !== 'admin') return err('无管理权限', 403, cors);
        const body = await readJson(request, { lenient: true });
        const amountCredits = Number(body.amountCredits);
        if (!Number.isSafeInteger(amountCredits) || amountCredits < 1 || amountCredits > 20_000)
          return err('Credit 数量无效', 400, cors);
        const row = await env.DB.prepare(
          `SELECT id, user_id, status FROM credit_red_packet_requests WHERE id = ?`,
        )
          .bind(redPacketApprove[1])
          .first<{ id: string; user_id: string; status: string }>();
        if (!row) return err('申请不存在', 404, cors);
        if (row.status !== 'pending') return err('该申请已处理', 409, cors);
        const now = Date.now();
        const referenceId = `red-packet:${row.id}`;
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO credit_ledger (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at) VALUES (?, ?, 'red_packet', ?, ?, ?, ?)`,
          ).bind(
            row.user_id,
            amountCredits,
            referenceId,
            CREDIT_PRICE_VERSION,
            JSON.stringify({ operatorUserId: admin.id, requestId: row.id }),
            now,
          ),
          env.DB.prepare(
            `UPDATE credit_red_packet_requests SET status = 'approved', processed_by = ?, processed_at = ? WHERE id = ? AND status = 'pending'`,
          ).bind(admin.id, now, row.id),
        ]);
        return json({ ok: true, amountCredits }, 200, cors);
      }
      if (redPacketReject && request.method === 'POST') {
        const admin = await currentUser(request, env);
        if (!admin || admin.role !== 'admin') return err('无管理权限', 403, cors);
        const body = await readJson(request, { lenient: true });
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 2 || reason.length > 200) return err('拒绝原因无效', 400, cors);
        const result = await env.DB.prepare(
          `UPDATE credit_red_packet_requests SET status = 'rejected', reject_reason = ?, processed_by = ?, processed_at = ? WHERE id = ? AND status = 'pending'`,
        )
          .bind(reason, admin.id, Date.now(), redPacketReject[1])
          .run();
        if (!result.meta.changes) return err('申请不存在或已处理', 409, cors);
        return json({ ok: true }, 200, cors);
      }

      if (path === '/api/auth/feedback' && request.method === 'POST') {
        const body = await readJson(request, { lenient: true });
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
        if (!message) return err('反馈内容不能为空', 400, cors);
        if (message.length > MAX_FEEDBACK_MESSAGE)
          return err('反馈内容不能超过 4000 字', 400, cors);
        if (contact.length > MAX_FEEDBACK_CONTACT) return err('联系方式过长', 400, cors);
        const recent = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at >= ?',
        )
          .bind(ipHash, Date.now() - FEEDBACK_WINDOW_MS)
          .first<{ n: number }>();
        if ((recent?.n ?? 0) >= MAX_FEEDBACK_PER_WINDOW) {
          return err('反馈提交过于频繁，请稍后再试', 429, cors);
        }
        const user = await currentUser(request, env);
        const id = crypto.randomUUID();
        const createdAt = Date.now();
        await env.DB.prepare(
          `INSERT INTO feedback (id, user_id, contact, message, ip_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, user?.id ?? null, contact || null, message, ipHash, createdAt)
          .run();
        if (env.EMAIL) {
          try {
            await env.EMAIL.send({
              to: FEEDBACK_RECIPIENT,
              from: { email: 'no-reply@0xnullai.com', name: '猫愿反馈' },
              subject: '收到新的猫愿反馈',
              text: `反馈编号：${id}\n用户：${user?.username ?? '未登录'}\n联系方式：${contact || '未提供'}\n\n${message}`,
            });
          } catch (error) {
            console.error('feedback_email_failed', error);
          }
        }
        return json({ ok: true, id }, 201, cors);
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

        const body = await readJson(request, { lenient: true });
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
      // Every signed-in viewer can read profile fields, irrespective of legacy
      // visibility. Blocks still return the same 404 as a missing account.
      if (path.startsWith('/api/auth/users/') && request.method === 'GET') {
        const viewer = await currentUser(request, env);
        if (!viewer) return err('未登录', 401, cors);
        const username = decodeURIComponent(path.slice('/api/auth/users/'.length)).toLowerCase();
        if (!username) return err('用户不存在', 404, cors);

        const target = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
          .bind(username)
          .first<UserRow>();
        if (!target) return err('用户不存在', 404, cors);

        const isSelf = viewer.id === target.id;
        if (!isSelf && (await blockedBetween(env, viewer.id, target.id))) {
          return err('用户不存在', 404, cors);
        }

        const row = await env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?')
          .bind(target.id)
          .first<Record<string, unknown>>();
        const profile = row
          ? publicProfile(row)
          : {
              avatarUrl: null,
              bio: null,
              birthDate: null,
              location: null,
              links: [],
              interests: [],
              discoverable: true,
              visibility: 'public' as const,
            };
        const [following, followedBy] = !isSelf
          ? await Promise.all([
              follows(env, viewer.id, target.id),
              follows(env, target.id, viewer.id),
            ])
          : [false, false];
        const isFriend = following && followedBy;

        // The birth date never leaves its owner's own view. The profile editor
        // tells users in so many words that it is collected to confirm they are
        // an adult and that the date itself is not shown — marking a profile
        // public is consent to the bio and the region, not to that. A promise
        // made in the UI has to be kept by the endpoint, or it is not a promise.
        const shown = isSelf ? profile : { ...profile, birthDate: null };

        const [followerCount, followingCount] = await Promise.all([
          countFollows(env, 'followee_id', target.id),
          countFollows(env, 'follower_id', target.id),
        ]);

        // Album photos retain their independent per-photo access policy.
        const photos = await visiblePhotos(env, target.id, isSelf, isFriend);

        return json(
          {
            user: publicUser(target),
            profile: shown,
            following,
            followedBy,
            counts: { followers: followerCount, following: followingCount },
            createdAt: Number(target.created_at),
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
        // Rows left by the retired system push stay in D1 until the table is dropped; erase this
        // account's device identifiers now, even if cross-service deletion needs cron retry.
        await env.DB.prepare('DELETE FROM push_registrations WHERE user_id=?').bind(user.id).run();
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
      // Malformed or oversized bodies and undecodable path segments are the client's mistake.
      if (error instanceof RequestError) return err(error.message, error.status, cors);
      if (error instanceof URIError) return err('请求路径无效', 400, cors);
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

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    if (controller.cron === '* * * * *') {
      ctx.waitUntil(
        Promise.all([
          runCompanionSchedules(env, now),
          runMediaJobs(env, now),
          runAutoMemory(env, now),
          runConversationDigest(env, now),
          runTextBilling(env, now),
          runPendingAccountDeletions(env, now),
          runAgentRunMaintenance(env, now),
          recoverVoiceAttachmentAsr(
            env,
            {
              reserve: (userId, key, credits) =>
                reserveCredits(env, userId, {
                  idempotencyKey: key,
                  usageKind: 'agent',
                  modelId: 'voice-asr',
                  credits,
                }),
              settle: (userId, key, charge, metadata) =>
                settleCredits(env, userId, key, charge, metadata),
              release: (userId, key) => releaseCredits(env, userId, key),
            },
            now,
          ),
          recoverManagedTts(
            env,
            {
              reserve: (userId, key, credits) =>
                reserveCredits(env, userId, {
                  idempotencyKey: key,
                  usageKind: 'agent',
                  modelId: 'managed-tts',
                  credits,
                }),
              settle: (userId, key, charge, metadata) =>
                settleCredits(env, userId, key, charge, metadata),
              release: (userId, key) => releaseCredits(env, userId, key),
            },
            now,
          ),
          expireStagedVideoReplies(env, now),
          // Every five minutes: prune the intake ledger and check alert thresholds.
          new Date(now).getUTCMinutes() % 5 === 0 ? runRuntimeMonitoring(env, now) : undefined,
        ]).then(() => undefined),
      );
      return;
    }
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
          ...monitoringRetentionStatements(env, now),
        ]),
        runAuthMaintenance(env, now),
        runConversationAttachmentCleanup(env),
        expireMediumMemories(env, now),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;

// Auth records its own 5xx and cron failures straight into D1; fail-open like every Worker.
export default withServerErrorCounting(authWorker, {
  worker: 'auth',
  sink: (env: Env) => ({ recordServerErrors: (report) => recordServerErrors(env, report) }),
});
