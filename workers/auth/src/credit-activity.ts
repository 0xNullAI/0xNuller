import { err, json } from './http';
import { currentUser, type SessionEnv } from './session-domain';
const TYPES = new Set(['agent', 'voice', 'video', 'image', 'selfie', 'proactive', 'tts']);
// Read-aloud holds: the stable id, and the id used before the speech provider changed.
const TTS_MODEL_IDS = new Set(['managed-tts', 'cosyvoice-v3-flash']);
function project(row: Record<string, unknown>) {
  let metadata: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(String(row.metadata_json ?? '{}'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      metadata = value as Record<string, unknown>;
  } catch {
    /* Legacy truncated metadata is not required for ledger correctness. */
  }
  const type =
    typeof metadata.kind === 'string' && TYPES.has(metadata.kind)
      ? metadata.kind
      : typeof row.usage_kind === 'string' && TYPES.has(row.usage_kind)
        ? row.usage_kind
        : null;
  const model =
    typeof row.model_id === 'string'
      ? row.model_id
      : typeof metadata.model === 'string'
        ? metadata.model
        : null;
  return {
    id: Number(row.id),
    kind: String(row.kind),
    amountCredits: Number(row.amount_credits),
    referenceId: String(row.reference_id),
    priceVersion: row.price_version == null ? null : String(row.price_version),
    createdAt: Number(row.created_at),
    usageType: type,
    model: model?.slice(0, 200) ?? null,
    durationMs:
      typeof metadata.durationMs === 'number' &&
      Number.isFinite(metadata.durationMs) &&
      metadata.durationMs >= 0
        ? metadata.durationMs
        : null,
  };
}
/** A safe projection, never return prompts, provider identifiers, credentials or raw billing metadata. */
export async function handleCreditActivity(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/auth/credits/activity') return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (
    user.banned_at != null ||
    (request.headers.has('X-Account-Id') && request.headers.get('X-Account-Id') !== user.id)
  )
    return err('账号不可用或已切换', 403, headers);
  if (request.method !== 'GET') return err('不支持此操作', 405, headers);
  if (url.searchParams.get('view') === 'timeline') {
    if (request.headers.get('X-Account-Id') !== user.id) return err('账号已切换', 403, headers);
    return timeline(env, user.id, url, headers);
  }
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam === null ? null : Number(beforeParam);
  if (before !== null && (!Number.isSafeInteger(before) || before <= 0))
    return err('账本游标无效', 400, headers);
  const rows = await env.DB.prepare(
    `SELECT l.id,l.kind,l.amount_credits,l.reference_id,l.price_version,l.metadata_json,l.created_at,r.usage_kind,r.model_id
    FROM credit_ledger l LEFT JOIN credit_reservations r ON r.user_id=l.user_id AND r.idempotency_key=l.reference_id AND l.kind='usage'
    WHERE l.user_id=? ${before === null ? '' : 'AND l.id<?'} ORDER BY l.id DESC LIMIT 31`,
  )
    .bind(user.id, ...(before === null ? [] : [before]))
    .all<Record<string, unknown>>();
  const pending = await env.DB.prepare(
    `SELECT r.idempotency_key,r.usage_kind,r.model_id,r.reserved_credits,r.created_at,r.updated_at,m.kind AS media_kind FROM credit_reservations r LEFT JOIN media_jobs m ON m.user_id=r.user_id AND m.reservation_key=r.idempotency_key
    WHERE r.user_id=? AND r.status='pending' AND r.updated_at>? ORDER BY r.created_at DESC,r.idempotency_key LIMIT 31`,
  )
    .bind(user.id, Date.now() - 2 * 60 * 60 * 1000)
    .all<Record<string, unknown>>();
  const page = rows.results.slice(0, 30);
  return json(
    {
      entries: page.map(project),
      nextCursor: rows.results.length > 30 ? Number(page[page.length - 1]!.id) : null,
      pending: pending.results.slice(0, 30).map((row) => ({
        referenceId: String(row.idempotency_key),
        usageType:
          typeof row.media_kind === 'string'
            ? row.media_kind
            : String(row.model_id).includes('proactive')
              ? 'proactive'
              : TTS_MODEL_IDS.has(String(row.model_id))
                ? 'tts'
                : String(row.usage_kind),
        model: String(row.model_id).slice(0, 200),
        reservedCredits: Number(row.reserved_credits),
        createdAt: Number(row.created_at),
      })),
      pendingTruncated: pending.results.length > 30,
    },
    200,
    headers,
  );
}

async function timeline(env: SessionEnv, user: string, url: URL, headers: Record<string, string>) {
  let cursor: [number, string] | null = null;
  try {
    const value = url.searchParams.get('cursor');
    if (value) {
      const parsed: unknown = JSON.parse(value);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !Number.isSafeInteger(parsed[0]) ||
        parsed[0] < 0 ||
        typeof parsed[1] !== 'string' ||
        parsed[1].length > 200
      )
        throw new Error();
      cursor = parsed as [number, string];
    }
  } catch {
    return err('流水游标无效', 400, headers);
  }
  const rows = await env.DB.prepare(
    `WITH activity AS (
    SELECT 'r:'||r.idempotency_key AS event_id,r.created_at AS event_created,r.idempotency_key AS reference_id,
      'usage' AS kind,l.amount_credits,COALESCE(l.price_version,m.price_version,g.price_version,z.price_version,json_extract(t.metadata_json,'$.priceVersion')) AS price_version,COALESCE(l.metadata_json,t.metadata_json) AS metadata_json,
      r.usage_kind,r.model_id,r.status AS reservation_status,r.reserved_credits,r.charged_credits,r.updated_at,
      m.kind AS media_kind,COALESCE(m.id,z.id) AS task_id,COALESCE(c.conversation_id,m.conversation_id) AS conversation_id,COALESCE(c.relationship_id,m.relationship_id) AS relationship_id,COALESCE(m.state,z.state) AS task_state,
      g.schedule_id,COALESCE(t.state,CASE WHEN z.state='needs_review' OR v.reservation_key IS NOT NULL OR b.reservation_key IS NOT NULL THEN 'needs_review' END) AS recovery_state,c.run_id,v.reason AS voice_review_reason,
      gc.room_id,gc.trigger_id,gc.role_id
    FROM credit_reservations r
    LEFT JOIN credit_ledger l ON l.user_id=r.user_id AND l.reference_id=r.idempotency_key AND l.kind='usage'
    LEFT JOIN media_jobs m ON m.user_id=r.user_id AND m.reservation_key=r.idempotency_key
    LEFT JOIN managed_tts_jobs z ON z.user_id=r.user_id AND z.reservation_key=r.idempotency_key
    LEFT JOIN companion_generations g ON g.user_id=r.user_id AND g.reservation_key=r.idempotency_key
    LEFT JOIN reservation_context c ON c.reservation_key=r.idempotency_key AND c.user_id=r.user_id
    LEFT JOIN group_ai_reservation_context gc ON gc.reservation_key=r.idempotency_key AND gc.user_id=r.user_id
    LEFT JOIN voice_billing_reviews v ON v.reservation_key=r.idempotency_key AND v.user_id=r.user_id
    LEFT JOIN media_billing_reviews b ON b.reservation_key=r.idempotency_key AND b.user_id=r.user_id
    LEFT JOIN text_billing_outbox t ON t.reservation_key=r.idempotency_key
    WHERE r.user_id=?
    UNION ALL
    SELECT 'l:'||l.id,l.created_at,l.reference_id,l.kind,l.amount_credits,l.price_version,l.metadata_json,
      NULL,NULL,NULL,NULL,NULL,l.created_at,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
    FROM credit_ledger l WHERE l.user_id=? AND NOT EXISTS(
      SELECT 1 FROM credit_reservations r WHERE r.user_id=l.user_id AND r.idempotency_key=l.reference_id AND l.kind='usage')
  ) SELECT * FROM activity ${cursor ? 'WHERE event_created<? OR (event_created=? AND event_id<?)' : ''}
    ORDER BY event_created DESC,event_id DESC LIMIT 31`,
  )
    .bind(user, user, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []))
    .all<Record<string, unknown>>();
  const page = rows.results.slice(0, 30);
  const entries = page.map((row) => {
    const base = project({ ...row, id: 0, created_at: row.event_created });
    const status = typeof row.reservation_status === 'string' ? row.reservation_status : null;
    const holdExpired =
      status === 'pending' && Number(row.updated_at) <= Date.now() - 2 * 60 * 60 * 1000;
    const modality =
      row.media_kind === 'video'
        ? 'generated_video'
        : typeof row.media_kind === 'string'
          ? row.media_kind
          : row.schedule_id
            ? 'proactive'
            : TTS_MODEL_IDS.has(String(row.model_id))
              ? 'tts'
              : base.usageType;
    const anomaly =
      row.voice_review_reason === 'reservation_expired'
        ? 'voice_hold_expired'
        : row.recovery_state === 'needs_review'
          ? 'needs_review'
          : status === 'settled' && row.amount_credits === null
            ? 'ledger_missing'
            : status &&
                row.amount_credits !== null &&
                (status !== 'settled' ||
                  Number(row.charged_credits) !== -Number(row.amount_credits))
              ? 'ledger_mismatch'
              : holdExpired
                ? 'expired_hold'
                : row.task_state === 'submission_unknown'
                  ? 'provider_unconfirmed'
                  : row.task_state === 'failed'
                    ? 'generation_failed'
                    : null;
    return {
      ...base,
      id: String(row.event_id),
      amountCredits: row.amount_credits === null ? null : Number(row.amount_credits),
      usageType: modality,
      status: status ?? (base.kind === 'usage' ? 'recorded' : 'posted'),
      reservedCredits: row.reserved_credits === null ? null : Number(row.reserved_credits),
      chargedCredits: row.charged_credits === null ? null : Number(row.charged_credits),
      holdActive: status === 'pending' && !holdExpired,
      conversationId: row.conversation_id ?? null,
      runId: row.run_id ?? null,
      relationshipId: row.relationship_id ?? null,
      taskId: row.task_id ?? null,
      scheduleId: row.schedule_id ?? null,
      roomId: row.room_id ?? null,
      triggerId: row.trigger_id ?? null,
      roleId: row.role_id ?? null,
      taskState: row.task_state ?? null,
      recoveryState: row.recovery_state ?? null,
      anomaly,
    };
  });
  const last = page.at(-1);
  return json(
    {
      view: 'timeline',
      entries,
      nextCursor:
        rows.results.length > 30 && last
          ? JSON.stringify([Number(last.event_created), String(last.event_id)])
          : null,
    },
    200,
    headers,
  );
}
