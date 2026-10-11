import type { SessionEnv } from './session-domain';

// Same strict > cutoff as creditBalance/reserveCredits. Also check D1 time at each write,
// so an RPC queued before expiry cannot debit after another request reuses the expired hold.
const HOLD_TTL_MS = 2 * 60 * 60 * 1000;
const CUTOFF = `MAX(?, CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER) - 7200000)`;

export interface VoiceFinalization {
  action: 'settle' | 'release';
  durationMs: number;
}
export interface VoiceFinalizationResult {
  status: 'settled' | 'released' | 'missing' | 'rejected' | 'needs_review';
  charged: number | null;
}

/** Private service-binding capability, never exposed as an HTTP account API.
 * The Voice entrypoint authenticates subject before creating a reservation.
 * Retries bind to that reservation rather than an expiring browser ticket.
 */
export async function finalizeVoiceReservation(
  env: Pick<SessionEnv, 'DB'>,
  subject: string,
  reservationKey: string,
  input: VoiceFinalization,
  priceVersion: string,
): Promise<VoiceFinalizationResult> {
  if (
    !subject ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(reservationKey) ||
    !input ||
    !['release', 'settle'].includes(input.action) ||
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs < 0 ||
    input.durationMs > 24 * 60 * 60 * 1000
  )
    return { status: 'rejected', charged: null };
  const read = () =>
    env.DB.prepare(
      `SELECT r.status,r.reserved_credits,r.charged_credits,v.reservation_key AS review_key FROM credit_reservations r LEFT JOIN voice_billing_reviews v ON v.reservation_key=r.idempotency_key AND v.user_id=r.user_id
    WHERE r.user_id=? AND r.idempotency_key=? AND r.usage_kind='voice' AND r.model_id='voice'`,
    )
      .bind(subject, reservationKey)
      .first<{
        status: 'pending' | 'settled' | 'released';
        reserved_credits: number;
        charged_credits: number | null;
        review_key: string | null;
      }>();
  const row = await read();
  if (!row) return { status: 'missing', charged: null };
  const now = Date.now();
  if (row.status === 'pending') {
    const charge = Math.min(
      row.reserved_credits,
      Math.max(20, Math.ceil(input.durationMs / 10_000) * 20),
    );
    const cutoff = now - HOLD_TTL_MS;
    const statements = [
      env.DB.prepare(
        `INSERT INTO voice_billing_reviews(reservation_key,user_id,reason,requested_action,observed_duration_ms,requested_credits,reserved_credits,price_version,hold_updated_at,created_at)
        SELECT idempotency_key,user_id,'reservation_expired',?,?,?,reserved_credits,?,updated_at,? FROM credit_reservations
        WHERE user_id=? AND idempotency_key=? AND usage_kind='voice' AND model_id='voice' AND status='pending' AND updated_at<=${CUTOFF}
        ON CONFLICT(reservation_key) DO NOTHING`,
      ).bind(
        input.action,
        input.durationMs,
        input.action === 'settle' ? charge : 0,
        priceVersion,
        now,
        subject,
        reservationKey,
        cutoff,
      ),
      env.DB.prepare(
        `UPDATE credit_reservations SET status='released',updated_at=? WHERE user_id=? AND idempotency_key=? AND usage_kind='voice' AND status='pending'
        AND EXISTS(SELECT 1 FROM voice_billing_reviews v WHERE v.reservation_key=credit_reservations.idempotency_key AND v.user_id=credit_reservations.user_id)`,
      ).bind(now, subject, reservationKey),
    ];
    if (input.action === 'release') {
      statements.push(
        env.DB.prepare(
          `UPDATE credit_reservations SET status='released',updated_at=? WHERE user_id=? AND idempotency_key=? AND usage_kind='voice' AND status='pending'`,
        ).bind(now, subject, reservationKey),
      );
    } else {
      // Same tariff, but expired holds are never charged. The debit and terminal state are atomic.
      statements.push(
        env.DB.prepare(
          `INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
          SELECT user_id,?,'usage',idempotency_key,?,?,? FROM credit_reservations
          WHERE user_id=? AND idempotency_key=? AND usage_kind='voice' AND model_id='voice' AND status='pending' AND updated_at>${CUTOFF}
          ON CONFLICT(user_id,kind,reference_id) DO NOTHING`,
        ).bind(
          -charge,
          priceVersion,
          JSON.stringify({ model: 'voice', durationMs: input.durationMs, priceVersion }),
          now,
          subject,
          reservationKey,
          cutoff,
        ),
        env.DB.prepare(
          `UPDATE credit_reservations SET charged_credits=?,status='settled',updated_at=? WHERE user_id=? AND idempotency_key=? AND usage_kind='voice' AND status='pending'
          AND EXISTS(SELECT 1 FROM credit_ledger l WHERE l.user_id=credit_reservations.user_id AND l.reference_id=credit_reservations.idempotency_key AND l.kind='usage' AND l.amount_credits=?)`,
        ).bind(charge, now, subject, reservationKey, -charge),
      );
    }
    await env.DB.batch(statements);
  }
  const final = await read();
  return final && final.status !== 'pending'
    ? {
        status: final.status === 'released' && final.review_key ? 'needs_review' : final.status,
        charged: final.charged_credits,
      }
    : { status: 'rejected', charged: null };
}
