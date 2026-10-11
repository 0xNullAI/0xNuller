import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { err, json, readBodyBounded } from './http';
import {
  fetchTrustedAudio,
  isMp3Audio,
  synthesizeCosyvoice,
  TtsProviderError,
} from './cosyvoice-tts';

type Env = SessionEnv & {
  PHOTOS: R2Bucket;
  DASHSCOPE_TTS_API_KEY?: string;
  DASHSCOPE_WORKSPACE_ID?: string;
  TTS_CREDITS_PER_CHARACTER?: string;
};
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
type Job = {
  user_id: string;
  id: string;
  text_hash: string;
  reservation_key: string;
  state: 'running' | 'settlement_pending' | 'succeeded' | 'failed' | 'needs_review';
  max_credits: number;
  charged_credits: number | null;
  characters: number | null;
  object_key: string | null;
  audio_expires_at: number | null;
  price_version: string;
  created_at: number;
  updated_at: number;
};
const ROOT = '/api/auth/managed-tts';
const ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_TEXT_CHARACTERS = 500;
const HOLD_TTL_MS = 2 * 60 * 60 * 1000;
const AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

function price(env: Env) {
  const rate = Number(env.TTS_CREDITS_PER_CHARACTER);
  return env.DASHSCOPE_TTS_API_KEY &&
    /^[A-Za-z0-9-]{4,80}$/.test(env.DASHSCOPE_WORKSPACE_ID ?? '') &&
    env.PHOTOS &&
    Number.isSafeInteger(rate) &&
    rate > 0 &&
    rate <= 1000
    ? {
        rate,
        maxTextCharacters: MAX_TEXT_CHARACTERS,
        priceVersion: `cosyvoice-v3-flash-v1:${rate}`,
      }
    : null;
}

function offerForText(
  text: string,
  rate: number,
): { length: number; maxCharacters: number; maxCredits: number } | null {
  const length = Array.from(text).length;
  if (
    !text.trim() ||
    length > MAX_TEXT_CHARACTERS ||
    !length ||
    Array.from(text).some((character) => character.codePointAt(0)! < 32)
  )
    return null;
  // The provider may count a Han ideograph as two billable characters.
  const maxCharacters = length * 2;
  return { length, maxCharacters, maxCredits: maxCharacters * rate };
}

const readJob = (env: Env, userId: string, id: string) =>
  env.DB.prepare('SELECT * FROM managed_tts_jobs WHERE user_id=? AND id=?')
    .bind(userId, id)
    .first<Job>();

function publicJob(job: Job | null) {
  return job
    ? {
        id: job.id,
        state: job.state,
        credits: job.state === 'succeeded' ? job.charged_credits : null,
        characters: job.state === 'succeeded' ? job.characters : null,
        audioAvailable:
          job.state === 'succeeded' &&
          Boolean(job.object_key && job.audio_expires_at && job.audio_expires_at > Date.now()),
      }
    : null;
}

/** Account-owned on-demand TTS; no auto-play, no saved text, no browser provider URL. */
export async function handleManagedTts(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  billing: Billing,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null || request.headers.get('X-Account-Id') !== user.id)
    return err('账号不可用或已切换', 403, headers);
  const offer = price(env);
  if (path === ROOT && request.method === 'GET')
    return json({ enabled: Boolean(offer), offer }, 200, headers);

  const detail = new RegExp(`^${ROOT}/([A-Za-z0-9_-]{8,80})(/audio)?$`).exec(path);
  if (detail && request.method === 'GET') {
    const job = await readJob(env, user.id, detail[1]!);
    if (!job) return err('朗读任务不存在', 404, headers);
    if (!detail[2]) return json({ job: publicJob(job) }, 200, headers);
    if (
      job.state !== 'succeeded' ||
      !job.object_key ||
      !job.audio_expires_at ||
      job.audio_expires_at <= Date.now()
    )
      return err('朗读音频不可用或已过期', 410, headers);
    const audio = await env.PHOTOS.get(job.object_key);
    if (!audio || audio.size > 4_000_000) return err('朗读音频不可用', 410, headers);
    return new Response(audio.body, {
      headers: {
        ...headers,
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (path !== ROOT || request.method !== 'POST') return err('不支持此操作', 405, headers);
  if (!offer) return err('托管朗读或价格尚未配置', 503, headers);
  const raw = await readBodyBounded(request, 4_000);
  if (!raw) return err('请求过大', 413, headers);
  let input: {
    id?: unknown;
    text?: unknown;
    consent?: unknown;
    acceptedMaxCredits?: unknown;
    priceVersion?: unknown;
  };
  try {
    input = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return err('请求无效', 400, headers);
  }
  if (
    !input ||
    typeof input.id !== 'string' ||
    !ID.test(input.id) ||
    typeof input.text !== 'string'
  )
    return err('朗读内容无效', 400, headers);
  const amount = offerForText(input.text, offer.rate);
  if (!amount) return err('朗读内容无效或过长', 400, headers);
  if (
    input.consent !== true ||
    input.acceptedMaxCredits !== amount.maxCredits ||
    input.priceVersion !== offer.priceVersion
  )
    return err('请重新确认朗读价格', 409, headers);
  const hash = await sha256Hex(input.text);
  const previous = await readJob(env, user.id, input.id);
  if (previous)
    return previous.text_hash === hash &&
      previous.price_version === offer.priceVersion &&
      previous.max_credits === amount.maxCredits
      ? json({ job: publicJob(previous) }, 200, headers)
      : err('朗读任务内容或价格已变更', 409, headers);

  const key = `tts:${await sha256Hex(`${user.id}\0${input.id}`)}`;
  const hold = await billing.reserve(user.id, key, amount.maxCredits);
  if (!hold.allowed)
    return err(
      hold.status === 'insufficient' ? 'Credit 不足' : '朗读任务已开始或余额不可用',
      409,
      headers,
    );
  const now = Date.now();
  let inserted: Job | null;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO managed_tts_jobs(user_id,id,text_hash,reservation_key,state,max_credits,price_version,created_at,updated_at)
       VALUES(?,?,?,?,'running',?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING RETURNING *`,
    )
      .bind(user.id, input.id, hash, key, amount.maxCredits, offer.priceVersion, now, now)
      .first<Job>();
  } catch {
    if (hold.created) await billing.release(user.id, key);
    return err('朗读任务暂不可用', 503, headers);
  }
  if (!inserted) {
    if (hold.created) await billing.release(user.id, key);
    const existing = await readJob(env, user.id, input.id);
    return existing?.text_hash === hash
      ? json({ job: publicJob(existing) }, 200, headers)
      : err('朗读任务已改变', 409, headers);
  }

  let objectKey: string | null = null;
  try {
    const result = await synthesizeCosyvoice(
      env.DASHSCOPE_TTS_API_KEY!,
      env.DASHSCOPE_WORKSPACE_ID!,
      input.text,
      amount.maxCharacters,
    );
    // Never settle for a URL alone: first prove that the paid audio is retrievable and bounded.
    const audio = await fetchTrustedAudio(result.url);
    objectKey = `users/${user.id}/tts/${input.id}.mp3`;
    const claimed = await env.DB.prepare(
      "UPDATE managed_tts_jobs SET object_key=?,audio_expires_at=?,updated_at=? WHERE user_id=? AND id=? AND state='running' RETURNING id",
    )
      .bind(objectKey, Date.now() + AUDIO_TTL_MS, Date.now(), user.id, input.id)
      .first<{ id: string }>();
    if (!claimed) throw new Error('朗读任务已失效');
    await env.PHOTOS.put(objectKey, audio, { httpMetadata: { contentType: 'audio/mpeg' } });
    const expiresAt = Math.min(result.expiresAt, Date.now() + AUDIO_TTL_MS);
    const charge = result.characters * offer.rate;
    await env.DB.prepare(
      `UPDATE managed_tts_jobs SET state='settlement_pending',charged_credits=?,characters=?,object_key=?,audio_expires_at=?,updated_at=?
       WHERE user_id=? AND id=? AND state='running'`,
    )
      .bind(charge, result.characters, objectKey, expiresAt, Date.now(), user.id, input.id)
      .run();
    if (
      (await readJob(env, user.id, input.id))?.state !== 'settlement_pending' ||
      Date.now() - now >= HOLD_TTL_MS
    )
      throw new Error('朗读任务状态无法确认');
    const final = await billing.settle(user.id, key, charge, {
      kind: 'tts',
      model: 'cosyvoice-v3-flash',
      characters: result.characters,
      priceVersion: offer.priceVersion,
      taskId: input.id,
    });
    if (final.status !== 'settled' || final.charged !== charge) throw new Error('朗读账务未确认');
    await env.DB.prepare(
      "UPDATE managed_tts_jobs SET state='succeeded',updated_at=? WHERE user_id=? AND id=? AND state='settlement_pending'",
    )
      .bind(Date.now(), user.id, input.id)
      .run();
    return json({ job: publicJob(await readJob(env, user.id, input.id)) }, 200, headers);
  } catch (error) {
    const current = await readJob(env, user.id, input.id);
    if (current?.state === 'settlement_pending')
      return err('朗读已生成，账务结算中，请稍后查看', 503, headers);
    const certain = error instanceof TtsProviderError && !error.uncertain;
    if (certain) {
      const released = await billing.release(user.id, key).catch(() => null);
      if (released?.status === 'released') {
        await env.DB.prepare(
          "UPDATE managed_tts_jobs SET state='failed',updated_at=? WHERE user_id=? AND id=? AND state='running'",
        )
          .bind(Date.now(), user.id, input.id)
          .run();
        return err('朗读失败，未扣 Credit', 503, headers);
      }
    }
    if (objectKey) {
      try {
        await env.PHOTOS.delete(objectKey);
        objectKey = null;
      } catch {
        // Deletion may have cascaded after the job was claimed. Re-queue even if
        // its trigger's earlier queue entry was already processed before R2 put.
        await env.DB.prepare(
          'INSERT OR IGNORE INTO private_attachment_deletions(object_key,queued_at) VALUES(?,?)',
        )
          .bind(objectKey, Date.now())
          .run();
      }
    }
    await env.DB.prepare(
      "UPDATE managed_tts_jobs SET state='needs_review',object_key=?,updated_at=? WHERE user_id=? AND id=? AND state='running'",
    )
      .bind(objectKey, Date.now(), user.id, input.id)
      .run();
    return err('朗读结果或账务待核对，暂未扣款', 503, headers);
  }
}

/** Finish persisted usage without replaying the paid provider call. */
export async function recoverManagedTts(
  env: Env,
  billing: Billing,
  now = Date.now(),
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM managed_tts_jobs WHERE (state='settlement_pending' AND updated_at<?)
      OR (state='running' AND updated_at<?) OR (object_key IS NOT NULL AND audio_expires_at<?)
      ORDER BY updated_at LIMIT 20`,
  )
    .bind(now - 30_000, now - 2 * 60_000, now)
    .all<Job>();
  for (const job of rows.results) {
    if (
      job.state === 'settlement_pending' &&
      job.object_key &&
      job.audio_expires_at &&
      job.audio_expires_at <= now
    ) {
      // Never create a new debit for audio that the customer can no longer play.
      // A crash may have happened *after* a real debit; preserve that receipt.
      const receipt = await env.DB.prepare(
        'SELECT status,charged_credits FROM credit_reservations WHERE user_id=? AND idempotency_key=?',
      )
        .bind(job.user_id, job.reservation_key)
        .first<{ status: string; charged_credits: number | null }>();
      const state =
        receipt?.status === 'settled' && receipt.charged_credits === job.charged_credits
          ? 'succeeded'
          : 'needs_review';
      await env.DB.prepare(
        "UPDATE managed_tts_jobs SET state=?,updated_at=? WHERE user_id=? AND id=? AND state='settlement_pending'",
      )
        .bind(state, now, job.user_id, job.id)
        .run();
    }
    if (job.state === 'running' && job.updated_at < now - 2 * 60_000) {
      await env.DB.prepare(
        "UPDATE managed_tts_jobs SET state='needs_review',updated_at=? WHERE user_id=? AND id=? AND state='running'",
      )
        .bind(now, job.user_id, job.id)
        .run();
      continue;
    }
    if (
      job.state === 'settlement_pending' &&
      job.charged_credits &&
      job.characters &&
      job.object_key &&
      job.audio_expires_at &&
      job.audio_expires_at > now
    ) {
      try {
        // A persisted provider receipt is insufficient when R2 lost the playable
        // output before the wallet debit. Verify the private object on recovery.
        const saved = await env.PHOTOS.get(job.object_key);
        if (
          !saved ||
          saved.size > 4_000_000 ||
          !isMp3Audio(new Uint8Array(await saved.arrayBuffer()))
        ) {
          await env.DB.prepare(
            "UPDATE managed_tts_jobs SET state='needs_review',updated_at=? WHERE user_id=? AND id=? AND state='settlement_pending'",
          )
            .bind(now, job.user_id, job.id)
            .run();
          continue;
        }
        // The wallet refuses a late pending hold, but returns an already settled
        // receipt idempotently. A crash after debit must not hide paid audio.
        const settled = await billing.settle(
          job.user_id,
          job.reservation_key,
          job.charged_credits,
          {
            kind: 'tts',
            model: 'cosyvoice-v3-flash',
            characters: job.characters,
            priceVersion: job.price_version,
            taskId: job.id,
          },
        );
        if (settled.status === 'settled' && settled.charged === job.charged_credits)
          await env.DB.prepare(
            "UPDATE managed_tts_jobs SET state='succeeded',updated_at=? WHERE user_id=? AND id=? AND state='settlement_pending'",
          )
            .bind(now, job.user_id, job.id)
            .run();
        else if (job.created_at <= now - HOLD_TTL_MS)
          await env.DB.prepare(
            "UPDATE managed_tts_jobs SET state='needs_review',updated_at=? WHERE user_id=? AND id=? AND state='settlement_pending'",
          )
            .bind(now, job.user_id, job.id)
            .run();
      } catch {
        /* retry on next cron; never regenerate */
      }
    }
    if (job.object_key && job.audio_expires_at && job.audio_expires_at <= now) {
      await env.PHOTOS.delete(job.object_key);
      await env.DB.prepare(
        'UPDATE managed_tts_jobs SET object_key=NULL,updated_at=? WHERE user_id=? AND id=? AND object_key=?',
      )
        .bind(now, job.user_id, job.id, job.object_key)
        .run();
    }
  }
}
