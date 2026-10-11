import type { SessionEnv } from './session-domain';
type Env = Pick<SessionEnv, 'DB'>;
interface Row {
  reservation_key: string;
  state: string;
  action: string | null;
  charge: number | null;
  metadata_json: string | null;
  updated_at: number;
  status: string;
  reserved_credits: number;
  charged_credits: number | null;
  reservation_updated: number;
  user_id: string;
  model_id: string;
  request_hash: string | null;
}
const read = (env: Env, key: string, capability: string) =>
  env.DB.prepare(
    `SELECT t.*,r.status,r.reserved_credits,r.charged_credits,r.updated_at AS reservation_updated,r.user_id,r.model_id
   FROM text_billing_outbox t JOIN credit_reservations r ON r.idempotency_key=t.reservation_key
   WHERE t.reservation_key=? AND t.capability=? AND r.usage_kind IN ('agent','video')`,
  )
    .bind(key, capability)
    .first<Row>();
export async function registerTextBilling(
  env: Env,
  key: string,
  subject: string,
  requestHash?: string,
) {
  if (requestHash !== undefined && !/^[a-f0-9]{64}$/.test(requestHash))
    throw new Error('text_billing_request_hash_invalid');
  const capability = crypto.randomUUID() + crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO text_billing_outbox(reservation_key,capability,request_hash,updated_at)
    SELECT idempotency_key,?,?,? FROM credit_reservations WHERE idempotency_key=? AND status='pending' AND usage_kind IN ('agent','video') AND user_id=?`,
    )
      .bind(capability, requestHash ?? null, Date.now(), key, subject)
      .run();
    if (!(await read(env, key, capability))) throw new Error('text_billing_registration_failed');
  } catch (error) {
    // The authenticated owner just created this hold; no provider has been started yet.
    // Do not depend on re-authentication after a potentially delayed registration failure.
    await env.DB.prepare(
      `UPDATE credit_reservations SET status='released',updated_at=?
      WHERE idempotency_key=? AND user_id=? AND status='pending' AND usage_kind IN ('agent','video')`,
    )
      .bind(Date.now(), key, subject)
      .run()
      .catch(() => console.error('Text billing registration cleanup deferred'));
    throw error;
  }
  return capability;
}
export async function inspectTextBilling(env: Env, key: string, capability: string) {
  const row = await read(env, key, capability);
  return row
    ? { status: row.status, charged: row.charged_credits, recovery: row.state }
    : { status: 'missing', charged: null };
}
export async function checkpointTextBilling(
  env: Env,
  key: string,
  capability: string,
  charge: number,
  metadata: Record<string, unknown>,
) {
  const row = await read(env, key, capability);
  const usage = metadata?.usage as
    { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (
    !row ||
    row.state !== 'running' ||
    row.status !== 'pending' ||
    !Number.isSafeInteger(charge) ||
    charge < 1 ||
    charge > row.reserved_credits ||
    metadata.model !== row.model_id ||
    (row.request_hash !== null && metadata.requestHash !== row.request_hash) ||
    !usage ||
    !Number.isSafeInteger(usage.prompt_tokens) ||
    !Number.isSafeInteger(usage.completion_tokens) ||
    usage.prompt_tokens! < 0 ||
    usage.completion_tokens! < 0
  )
    throw new Error('text_billing_checkpoint_rejected');
  const encoded = JSON.stringify(metadata);
  if (encoded.length > 4000) throw new Error('text_billing_metadata_too_large');
  // A repeated checkpoint is harmless; a lower charge cannot erase confirmed usage.
  await env.DB.prepare(
    `UPDATE text_billing_outbox SET charge=?,metadata_json=?,updated_at=?
    WHERE reservation_key=? AND capability=? AND state='running' AND (charge IS NULL OR (charge<=? AND json_extract(metadata_json,'$.usage.prompt_tokens')<=? AND json_extract(metadata_json,'$.usage.completion_tokens')<=?))`,
  )
    .bind(
      charge,
      encoded,
      Date.now(),
      key,
      capability,
      charge,
      usage.prompt_tokens,
      usage.completion_tokens,
    )
    .run();
  const final = await read(env, key, capability);
  if (
    !final ||
    final.state !== 'running' ||
    final.charge !== charge ||
    final.metadata_json !== encoded
  )
    throw new Error('text_billing_checkpoint_conflict');
  return { status: 'checkpointed' };
}
export async function finalizeTextBilling(
  env: Env,
  key: string,
  capability: string,
  action: 'settle' | 'release',
) {
  if (!['settle', 'release'].includes(action)) throw new Error('text_billing_action_invalid');
  const row = await read(env, key, capability);
  if (!row) return { status: 'missing', charged: null };
  if (row.state === 'running') {
    if (action === 'settle' && row.charge === null) throw new Error('text_billing_usage_missing');
    if (action === 'release' && row.charge !== null)
      throw new Error('text_billing_usage_confirmed');
    await env.DB.prepare(
      `UPDATE text_billing_outbox SET state='ready',action=?,updated_at=? WHERE reservation_key=? AND capability=? AND state='running' AND ((?='settle' AND charge IS NOT NULL) OR (?='release' AND charge IS NULL))`,
    )
      .bind(action, Date.now(), key, capability, action, action)
      .run();
  }
  await applyTextBilling(env, key);
  return inspectTextBilling(env, key, capability);
}
async function applyTextBilling(env: Env, key: string, now = Date.now()) {
  // Never charge a hold that other wallet owners already consider expired. Preserve a review record.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE text_billing_outbox SET state='needs_review',reason='reservation_expired',updated_at=?
      WHERE reservation_key=? AND state='ready' AND EXISTS(SELECT 1 FROM credit_reservations r WHERE r.idempotency_key=reservation_key AND r.status='pending' AND r.updated_at<=?)`,
    ).bind(now, key, now - 2 * 60 * 60 * 1000),
    env.DB.prepare(
      `INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
      SELECT r.user_id,-t.charge,'usage',r.idempotency_key,'credits-2026-09',t.metadata_json,?
      FROM text_billing_outbox t JOIN credit_reservations r ON r.idempotency_key=t.reservation_key
      WHERE t.reservation_key=? AND t.state='ready' AND t.action='settle' AND t.charge IS NOT NULL AND r.status='pending'
      ON CONFLICT(user_id,kind,reference_id) DO NOTHING`,
    ).bind(now, key),
    env.DB.prepare(
      `UPDATE credit_reservations SET status='settled',charged_credits=(SELECT charge FROM text_billing_outbox WHERE reservation_key=?),updated_at=?
      WHERE idempotency_key=? AND status='pending' AND EXISTS(SELECT 1 FROM text_billing_outbox WHERE reservation_key=? AND state='ready' AND action='settle')`,
    ).bind(key, now, key, key),
    env.DB.prepare(
      `UPDATE credit_reservations SET status='released',updated_at=? WHERE idempotency_key=? AND status='pending' AND EXISTS(
      SELECT 1 FROM text_billing_outbox WHERE reservation_key=? AND (state='needs_review' OR (state='ready' AND action='release')))`,
    ).bind(now, key, key),
    env.DB.prepare(
      `UPDATE text_billing_outbox SET state=CASE WHEN action=(CASE (SELECT status FROM credit_reservations WHERE idempotency_key=?) WHEN 'settled' THEN 'settle' ELSE 'release' END)
      AND (action='release' OR charge=(SELECT charged_credits FROM credit_reservations WHERE idempotency_key=reservation_key)) THEN (SELECT status FROM credit_reservations WHERE idempotency_key=?) ELSE 'needs_review' END,updated_at=?
      WHERE reservation_key=? AND state='ready' AND EXISTS(SELECT 1 FROM credit_reservations WHERE idempotency_key=? AND status IN ('settled','released'))`,
    ).bind(key, key, now, key, key),
  ]);
}
export async function runTextBilling(env: Env, now = Date.now()) {
  // No new infrastructure: the existing minute cron owns bounded recovery batches.
  const rows = await env.DB.prepare(
    `SELECT reservation_key FROM text_billing_outbox WHERE next_attempt_at<=? AND (state='ready' OR (state='needs_review' AND EXISTS(SELECT 1 FROM credit_reservations r WHERE r.idempotency_key=reservation_key AND r.status='pending')) OR (state='running' AND updated_at<?)) ORDER BY next_attempt_at,updated_at LIMIT 20`,
  )
    .bind(now, now - 10 * 60 * 1000)
    .all<{ reservation_key: string }>();
  for (const { reservation_key: key } of rows.results) {
    try {
      await env.DB.prepare(
        `UPDATE text_billing_outbox SET state=CASE WHEN charge IS NULL THEN 'needs_review' ELSE 'ready' END,
        action=CASE WHEN charge IS NULL THEN NULL ELSE 'settle' END,reason=CASE WHEN charge IS NULL THEN 'interrupted_without_usage' ELSE 'recovered_checkpoint' END,updated_at=?
        WHERE reservation_key=? AND state='running' AND updated_at<?`,
      )
        .bind(now, key, now - 10 * 60 * 1000)
        .run();
      await applyTextBilling(env, key, now);
    } catch {
      console.error('Text billing recovery deferred');
      await env.DB.prepare(
        `UPDATE text_billing_outbox SET attempts=attempts+1,next_attempt_at=?+MIN(300000,30000*(1<<MIN(attempts,4))) WHERE reservation_key=?`,
      )
        .bind(now, key)
        .run()
        .catch(() => {});
    }
  }
}

export async function heartbeatTextBilling(
  env: Env,
  key: string,
  capability: string,
  now = Date.now(),
) {
  const updated = await env.DB.prepare(
    `UPDATE text_billing_outbox SET updated_at=?
    WHERE reservation_key=? AND capability=? AND state='running' AND EXISTS(
      SELECT 1 FROM credit_reservations r WHERE r.idempotency_key=reservation_key AND r.status='pending' AND r.updated_at>?) RETURNING reservation_key`,
  )
    .bind(now, key, capability, now - 2 * 60 * 60 * 1000)
    .first();
  return { status: updated ? 'running' : 'rejected' };
}
