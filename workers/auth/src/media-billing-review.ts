import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { err, json, readBodyBounded } from './http';

const PATH = '/api/auth/admin/billing/media-reconciliation';

/** Operator evidence only: neither route mutates the credit ledger or makes an asset visible. */
export async function handleMediaBillingReview(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH && url.pathname !== `${PATH}/notes`) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (
    user.role !== 'admin' ||
    user.banned_at !== null ||
    request.headers.get('X-Account-Id') !== user.id
  )
    return err('无管理权限或账号已切换', 403, headers);

  if (url.pathname === PATH && request.method === 'GET') {
    const before = url.searchParams.get('before');
    if (before !== null && (!/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before))))
      return err('游标无效', 400, headers);
    const rows = await env.DB.prepare(
      `SELECT b.rowid AS sequence,b.reservation_key AS id,b.user_id AS accountId,b.job_id AS jobId,
       b.reason,b.reserved_credits AS reservedAtReview,b.hold_updated_at AS holdUpdatedAt,
       b.created_at AS createdAt,m.kind,m.state AS jobState,m.credits AS quotedCredits,
       m.price_version AS priceVersion,m.object_key AS objectKey,m.photo_id AS photoId,
       m.mime,m.updated_at AS jobUpdatedAt,r.status AS reservationStatus,
       r.reserved_credits AS reservedNow,r.charged_credits AS chargedNow,
       r.updated_at AS reservationUpdatedAt,
       (SELECT COUNT(*) FROM credit_ledger l WHERE l.user_id=b.user_id AND l.kind='usage' AND l.reference_id=b.reservation_key) AS ledgerCount,
       (SELECT SUM(l.amount_credits) FROM credit_ledger l WHERE l.user_id=b.user_id AND l.kind='usage' AND l.reference_id=b.reservation_key) AS ledgerAmount,
       (SELECT json_group_array(json_object('eventId',event_id,'operatorId',operator_id,'note',note,'createdAt',created_at))
        FROM (SELECT event_id,operator_id,note,created_at FROM media_billing_review_notes WHERE reservation_key=b.reservation_key ORDER BY sequence DESC LIMIT 5)) AS notesJson
       FROM media_billing_reviews b JOIN media_jobs m ON m.user_id=b.user_id AND m.id=b.job_id
       LEFT JOIN credit_reservations r ON r.idempotency_key=b.reservation_key AND r.user_id=b.user_id
       ${before ? 'WHERE b.rowid<?' : ''} ORDER BY b.rowid DESC LIMIT 31`,
    )
      .bind(...(before ? [Number(before)] : []))
      .all<{ sequence: number; notesJson: string; objectKey: string; [key: string]: unknown }>();
    const items = rows.results.slice(0, 30).map(({ notesJson, objectKey, ...row }) => ({
      ...row,
      // R2 HEAD is evidence, not proof that this result should be delivered or billed.
      objectKey,
      notes: JSON.parse(notesJson) as unknown[],
    }));
    return json(
      { items, nextCursor: rows.results.length > 30 ? items.at(-1)!.sequence : null },
      200,
      headers,
    );
  }

  if (url.pathname === `${PATH}/notes` && request.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      const bytes = await readBodyBounded(request, 4096);
      if (!bytes) return err('请求过大', 413, headers);
      body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || Array.isArray(body)) throw new Error();
    } catch {
      return err('请求格式错误', 400, headers);
    }
    const { eventId, id, accountId, note, observed } = body;
    if (
      typeof eventId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(eventId) ||
      typeof id !== 'string' ||
      !/^media:[a-f0-9]{64}$/.test(id) ||
      typeof accountId !== 'string' ||
      accountId.length < 1 ||
      accountId.length > 128 ||
      typeof note !== 'string' ||
      note.trim().length < 3 ||
      note.length > 1000 ||
      !observed ||
      typeof observed !== 'object' ||
      Array.isArray(observed)
    )
      return err('备注或观察版本无效', 400, headers);
    const version = observed as Record<string, unknown>;
    if (
      !Number.isSafeInteger(version.createdAt) ||
      !Number.isSafeInteger(version.jobUpdatedAt) ||
      !(version.reservationStatus === null || typeof version.reservationStatus === 'string') ||
      !(version.reservationUpdatedAt === null || Number.isSafeInteger(version.reservationUpdatedAt))
    )
      return err('备注或观察版本无效', 400, headers);
    const snapshot = JSON.stringify({
      createdAt: version.createdAt,
      jobUpdatedAt: version.jobUpdatedAt,
      reservationStatus: version.reservationStatus,
      reservationUpdatedAt: version.reservationUpdatedAt,
    });
    const hash = await sha256Hex(
      JSON.stringify({ id, accountId, note, operator: user.id, snapshot }),
    );
    const previous = () =>
      env.DB.prepare('SELECT payload_hash FROM media_billing_review_notes WHERE event_id=?')
        .bind(eventId)
        .first<{ payload_hash: string }>();
    const existing = await previous();
    if (existing)
      return existing.payload_hash === hash
        ? json({ recorded: true }, 200, headers)
        : err('事件编号已用于其他备注', 409, headers);
    await env.DB.prepare(
      `INSERT INTO media_billing_review_notes(event_id,reservation_key,operator_id,note,payload_hash,observed_json,created_at)
       SELECT ?,b.reservation_key,?,?,?,?,? FROM media_billing_reviews b
       JOIN media_jobs m ON m.user_id=b.user_id AND m.id=b.job_id
       LEFT JOIN credit_reservations r ON r.idempotency_key=b.reservation_key AND r.user_id=b.user_id
       WHERE b.reservation_key=? AND b.user_id=? AND b.created_at=? AND m.updated_at=?
       AND r.status IS ? AND r.updated_at IS ?
       AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND banned_at IS NULL)
       AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
      .bind(
        eventId,
        user.id,
        note,
        hash,
        snapshot,
        Date.now(),
        id,
        accountId,
        version.createdAt,
        version.jobUpdatedAt,
        version.reservationStatus,
        version.reservationUpdatedAt,
        user.id,
        user.id,
      )
      .run();
    const saved = await previous();
    return saved?.payload_hash === hash
      ? json({ recorded: true }, 200, headers)
      : err('账务状态已变化或事件编号冲突，请刷新后核对', 409, headers);
  }
  return err('接口不存在', 404, headers);
}
