import {
  parsePriceTable,
  recognitionCredits,
  type SpeechRecognitionRoute,
} from '@0xnullai/ai-pricing';
import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { err, json, readBodyBounded } from './http';
import { AsrProviderError, recognizeDoubaoClip } from './doubao-asr';
import { oggOpusClip, OpusContainerError, type OggOpusClip } from './opus-container';

type CreditResult = { allowed: boolean; created?: boolean; status: string; charged: number | null };
type Billing = {
  reserve: (userId: string, key: string, credits: number) => Promise<CreditResult>;
  settle: (
    userId: string,
    key: string,
    charge: number,
    metadata: Record<string, unknown>,
  ) => Promise<CreditResult>;
  release: (userId: string, key: string) => Promise<CreditResult>;
};
type Env = SessionEnv & {
  PHOTOS: R2Bucket;
  VOLC_SPEECH_API_KEY?: string;
  AI_PRICE_TABLE?: string;
};
type Job = {
  state: 'running' | 'settlement_pending' | 'succeeded' | 'failed' | 'needs_review';
  reservation_key: string;
  max_credits: number;
  charged_credits: number | null;
  seconds: number | null;
  transcript: string | null;
  price_version: string;
  started_at: number;
};
const PATH = /^\/api\/auth\/conversations\/([^/]+)\/attachments\/([^/]+)\/transcription$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ASR_MAX_AUDIO_BYTES = 6_000_000;
/** Longest clip offered for recognition; the hold covers exactly this much audio. */
const MAX_CLIP_SECONDS = 300;
const HOLD_TTL_MS = 2 * 60 * 60 * 1000;

/** Disabled (null) until both the speech key and a valid `AI_PRICE_TABLE` are configured. */
function pricing(env: Env) {
  const table = parsePriceTable(env.AI_PRICE_TABLE);
  if (!env.VOLC_SPEECH_API_KEY || !table) return null;
  const route: SpeechRecognitionRoute = table.asr;
  return {
    route,
    offer: {
      perHour: route.perHour,
      maxSeconds: MAX_CLIP_SECONDS,
      maxCredits: recognitionCredits(route, MAX_CLIP_SECONDS * 1000),
      priceVersion: `asr:${table.version}`,
    },
  };
}

const readJob = (env: Env, userId: string, conversationId: string, attachmentId: string) =>
  env.DB.prepare(
    'SELECT * FROM voice_attachment_asr_jobs WHERE user_id=? AND conversation_id=? AND attachment_id=?',
  )
    .bind(userId, conversationId, attachmentId)
    .first<Job>();

function publicJob(job: Job | null) {
  return job
    ? {
        state: job.state,
        credits: job.state === 'succeeded' ? job.charged_credits : null,
        transcript: job.state === 'succeeded' ? job.transcript : null,
        seconds: job.state === 'succeeded' ? job.seconds : null,
      }
    : null;
}

/** Explicit opt-in per saved clip. ASR text is private draft, never an automatic user message. */
export async function handleVoiceAttachmentAsr(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  billing: Billing,
): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  let conversationId: string;
  let attachmentId: string;
  try {
    conversationId = decodeURIComponent(match[1]!);
    attachmentId = decodeURIComponent(match[2]!);
  } catch {
    return err('编号无效', 400, headers);
  }
  if (!ID.test(conversationId) || !ID.test(attachmentId)) return err('编号无效', 400, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  if (request.headers.get('X-Account-Id') !== user.id) return err('账号已切换', 403, headers);
  const attachment = await env.DB.prepare(
    `SELECT a.object_key,a.mime,a.size FROM private_conversation_attachments a
       JOIN server_conversations c ON c.user_id=a.user_id AND c.id=a.conversation_id
     WHERE a.user_id=? AND a.conversation_id=? AND a.id=? AND a.status='ready'
       AND a.kind='voice' AND c.deleted_at IS NULL`,
  )
    .bind(user.id, conversationId, attachmentId)
    .first<{ object_key: string; mime: string; size: number }>();
  if (!attachment) return err('语音附件不存在', 404, headers);
  if (attachment.mime !== 'audio/webm' && attachment.mime !== 'audio/ogg')
    return err('此录音格式暂不支持自动识别', 415, headers);
  const priced = pricing(env);
  const offer = priced?.offer ?? null;
  if (request.method === 'GET')
    return json(
      {
        enabled: Boolean(offer),
        offer,
        job: publicJob(await readJob(env, user.id, conversationId, attachmentId)),
      },
      200,
      headers,
    );
  if (request.method !== 'POST') return err('不支持此操作', 405, headers);
  if (!priced || !offer) return err('语音识别或价格尚未配置', 503, headers);
  if (attachment.size > ASR_MAX_AUDIO_BYTES) return err('录音过大，无法识别', 413, headers);
  const raw = await readBodyBounded(request, 1000);
  if (!raw) return err('请求过大', 413, headers);
  let accepted: { consent?: unknown; acceptedMaxCredits?: unknown; priceVersion?: unknown };
  try {
    accepted = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return err('请求无效', 400, headers);
  }
  if (
    accepted?.consent !== true ||
    accepted.acceptedMaxCredits !== offer.maxCredits ||
    accepted.priceVersion !== offer.priceVersion
  )
    return err('请重新确认语音识别价格', 409, headers);
  const previous = await readJob(env, user.id, conversationId, attachmentId);
  if (previous) return json({ job: publicJob(previous) }, 200, headers);
  // Measure (and, for WebM, rewrap) the clip before holding Credit, so an over-long or
  // unreadable recording is refused without a reservation or a provider call.
  let clip: OggOpusClip;
  try {
    const object = await env.PHOTOS.get(attachment.object_key);
    if (!object || object.size !== attachment.size) return err('语音附件不可用', 404, headers);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== attachment.size) return err('语音附件不可用', 404, headers);
    clip = oggOpusClip(bytes, attachment.mime);
  } catch (error) {
    if (error instanceof OpusContainerError) return err(error.message, 415, headers);
    throw error;
  }
  if (clip.durationMs > MAX_CLIP_SECONDS * 1000)
    return err(`录音超过 ${MAX_CLIP_SECONDS / 60} 分钟，无法识别`, 413, headers);

  const key = `asr:${await sha256Hex(`${user.id}\0${conversationId}\0${attachmentId}`)}`;
  const reserved = await billing.reserve(user.id, key, offer.maxCredits);
  if (!reserved.allowed)
    return err(
      reserved.status === 'insufficient' ? 'Credit 不足' : '识别任务已开始或余额不可用',
      409,
      headers,
    );
  const now = Date.now();
  let inserted: { reservation_key: string } | null;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO voice_attachment_asr_jobs
        (user_id,conversation_id,attachment_id,reservation_key,state,max_credits,price_version,started_at,updated_at)
       SELECT ?,?,?,?,'running',?,?,?,? WHERE EXISTS
        (SELECT 1 FROM private_conversation_attachments a JOIN server_conversations c
          ON c.user_id=a.user_id AND c.id=a.conversation_id
          WHERE a.user_id=? AND a.conversation_id=? AND a.id=? AND a.status='ready'
            AND a.kind='voice' AND c.deleted_at IS NULL)
       ON CONFLICT(user_id,conversation_id,attachment_id) DO NOTHING RETURNING reservation_key`,
    )
      .bind(
        user.id,
        conversationId,
        attachmentId,
        key,
        offer.maxCredits,
        offer.priceVersion,
        now,
        now,
        user.id,
        conversationId,
        attachmentId,
      )
      .first<{ reservation_key: string }>();
  } catch {
    // No provider call happened. The reservation can be safely released.
    if (reserved.created) await billing.release(user.id, key);
    throw new Error('语音识别任务暂不可用');
  }
  if (!inserted) {
    if (reserved.created) await billing.release(user.id, key);
    return err('会话或附件已变更，请重试', 409, headers);
  }
  try {
    const recognition = await recognizeDoubaoClip({
      key: env.VOLC_SPEECH_API_KEY!,
      resourceId: priced.route.resourceId,
      ogg: clip.ogg,
    });
    const seconds = Math.ceil(recognition.durationMs / 1000);
    const charge = Math.min(
      offer.maxCredits,
      recognitionCredits(priced.route, recognition.durationMs),
    );
    await env.DB.prepare(
      `UPDATE voice_attachment_asr_jobs SET state='settlement_pending',transcript=?,seconds=?,charged_credits=?,updated_at=?
       WHERE user_id=? AND conversation_id=? AND attachment_id=? AND state='running'`,
    )
      .bind(recognition.text, seconds, charge, Date.now(), user.id, conversationId, attachmentId)
      .run();
    if ((await readJob(env, user.id, conversationId, attachmentId))?.state !== 'settlement_pending')
      throw new Error('语音附件已失效');
    if (Date.now() - now >= HOLD_TTL_MS) throw new Error('语音冻结已过期');
    const final = await billing.settle(user.id, key, charge, {
      model: priced.route.resourceId,
      kind: 'asr',
      seconds,
      durationMs: recognition.durationMs,
      priceVersion: offer.priceVersion,
      conversationId,
      attachmentId,
    });
    if (final.status === 'settled' && final.charged === charge) {
      await env.DB.prepare(
        `UPDATE voice_attachment_asr_jobs SET state='succeeded',updated_at=?
         WHERE user_id=? AND conversation_id=? AND attachment_id=? AND state='settlement_pending'`,
      )
        .bind(Date.now(), user.id, conversationId, attachmentId)
        .run();
      return json(
        { job: publicJob(await readJob(env, user.id, conversationId, attachmentId)) },
        200,
        headers,
      );
    }
    await env.DB.prepare(
      `UPDATE voice_attachment_asr_jobs SET state='needs_review',transcript=NULL,updated_at=?
       WHERE user_id=? AND conversation_id=? AND attachment_id=? AND state='settlement_pending'`,
    )
      .bind(Date.now(), user.id, conversationId, attachmentId)
      .run();
    return err('识别已完成但账务待核对', 409, headers);
  } catch (error) {
    const current = await readJob(env, user.id, conversationId, attachmentId);
    if (current?.state === 'settlement_pending')
      return err('识别已完成，账务结算中，请稍后查看', 503, headers);
    const certainFailure = error instanceof AsrProviderError && !error.uncertain;
    if (certainFailure) {
      const released = await billing.release(user.id, key);
      if (released.status === 'released') {
        await env.DB.prepare(
          `UPDATE voice_attachment_asr_jobs SET state='failed',updated_at=?
           WHERE user_id=? AND conversation_id=? AND attachment_id=? AND state='running'`,
        )
          .bind(Date.now(), user.id, conversationId, attachmentId)
          .run();
        return err('语音识别失败，未扣 Credit', 503, headers);
      }
    }
    // A timeout, 5xx or malformed reply may already have consumed provider usage.
    // Retain the hold for manual review; never retry the same audio automatically.
    await env.DB.prepare(
      `UPDATE voice_attachment_asr_jobs SET state='needs_review',updated_at=?
       WHERE user_id=? AND conversation_id=? AND attachment_id=? AND state='running'`,
    )
      .bind(Date.now(), user.id, conversationId, attachmentId)
      .run();
    return err('识别结果待核对，暂未扣款', 503, headers);
  }
}

/** Recover a persisted provider result without ever replaying the paid provider request. */
export async function recoverVoiceAttachmentAsr(
  env: Env,
  billing: Billing,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE voice_attachment_asr_jobs SET state='needs_review',updated_at=?
     WHERE state='running' AND started_at<?`,
  )
    .bind(now, now - 5 * 60_000)
    .run();
  const rows = await env.DB.prepare(
    `SELECT user_id,conversation_id,attachment_id,reservation_key,state,max_credits,charged_credits,
            seconds,transcript,price_version,started_at
       FROM voice_attachment_asr_jobs WHERE state='settlement_pending' LIMIT 20`,
  ).all<Job & { user_id: string; conversation_id: string; attachment_id: string }>();
  for (const row of rows.results) {
    if (now - row.started_at >= HOLD_TTL_MS) {
      await env.DB.prepare(
        `UPDATE voice_attachment_asr_jobs SET state='needs_review',transcript=NULL,updated_at=?
         WHERE reservation_key=? AND state='settlement_pending'`,
      )
        .bind(now, row.reservation_key)
        .run();
      continue;
    }
    try {
      const charge = row.charged_credits;
      if (!charge || !row.seconds || row.transcript === null) continue;
      const final = await billing.settle(row.user_id, row.reservation_key, charge, {
        kind: 'asr',
        seconds: row.seconds,
        priceVersion: row.price_version,
        conversationId: row.conversation_id,
        attachmentId: row.attachment_id,
      });
      await env.DB.prepare(
        `UPDATE voice_attachment_asr_jobs SET state=?,transcript=CASE WHEN ?='succeeded' THEN transcript ELSE NULL END,updated_at=?
         WHERE reservation_key=? AND state='settlement_pending'`,
      )
        .bind(
          final.status === 'settled' && final.charged === charge ? 'succeeded' : 'needs_review',
          final.status === 'settled' && final.charged === charge ? 'succeeded' : 'needs_review',
          now,
          row.reservation_key,
        )
        .run();
    } catch {
      /* Persisted result and hold remain for the next recovery attempt. */
    }
  }
}

/** Read-only operator queue; no transcript or R2 path leaves this endpoint. */
export async function handleAsrBillingReview(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/auth/admin/billing/asr-reconciliation') return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (
    user.role !== 'admin' ||
    user.banned_at !== null ||
    request.headers.get('X-Account-Id') !== user.id
  )
    return err('无管理权限或账号已切换', 403, headers);
  if (request.method !== 'GET') return err('不支持此操作', 405, headers);
  const before = url.searchParams.get('before');
  if (before && (!/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before))))
    return err('游标无效', 400, headers);
  const rows = await env.DB.prepare(
    `SELECT j.rowid AS sequence,j.user_id AS accountId,j.conversation_id AS conversationId,
            j.attachment_id AS attachmentId,j.reservation_key AS reservationKey,j.state,
            j.max_credits AS maximumCredits,j.charged_credits AS expectedCharge,
            j.seconds,j.price_version AS priceVersion,j.started_at AS startedAt,
            j.updated_at AS updatedAt,r.status AS reservationStatus,r.charged_credits AS chargedNow,
            (SELECT COUNT(*) FROM credit_ledger l WHERE l.user_id=j.user_id AND l.kind='usage'
              AND l.reference_id=j.reservation_key) AS ledgerCount
       FROM voice_attachment_asr_jobs j LEFT JOIN credit_reservations r
         ON r.idempotency_key=j.reservation_key AND r.user_id=j.user_id
      WHERE (j.state IN ('needs_review','settlement_pending')
         OR (j.state='running' AND j.started_at<?))
      ${before ? 'AND j.rowid<?' : ''} ORDER BY j.rowid DESC LIMIT 31`,
  )
    .bind(Date.now() - 5 * 60_000, ...(before ? [Number(before)] : []))
    .all<{ sequence: number }>();
  const items = rows.results.slice(0, 30);
  return json(
    { items, nextCursor: rows.results.length > 30 ? items.at(-1)!.sequence : null },
    200,
    headers,
  );
}
