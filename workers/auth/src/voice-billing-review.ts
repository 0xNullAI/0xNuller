import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { err, json, readBodyBounded } from './http';
const PATH = '/api/auth/admin/billing/voice-reconciliation';
export async function handleVoiceBillingReview(
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
    if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))))
      return err('游标无效', 400, headers);
    const account = url.searchParams.get('accountId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const validTime = (value: string | null) =>
      value === null || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
    if (
      (account !== null && (account.length < 1 || account.length > 128)) ||
      !validTime(from) ||
      !validTime(to) ||
      (from !== null && to !== null && Number(from) > Number(to))
    )
      return err('账户或时间筛选无效', 400, headers);
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (before) {
      conditions.push('v.rowid<?');
      values.push(Number(before));
    }
    if (account !== null) {
      conditions.push('v.user_id=?');
      values.push(account);
    }
    if (from !== null) {
      conditions.push('v.created_at>=?');
      values.push(Number(from));
    }
    if (to !== null) {
      conditions.push('v.created_at<=?');
      values.push(Number(to));
    }
    const rows = await env.DB.prepare(
      `SELECT v.rowid AS sequence,v.reservation_key AS id,v.user_id AS accountId,
      r.status,r.charged_credits AS charged,r.updated_at AS updatedAt,
      v.reason,v.requested_action AS requestedAction,v.observed_duration_ms AS durationMs,
      v.requested_credits AS requestedCredits,v.reserved_credits AS reserved,
      v.price_version AS priceVersion,v.hold_updated_at AS holdUpdatedAt,v.created_at AS createdAt,
      (SELECT json_group_array(json_object('eventId',event_id,'operatorId',operator_id,'note',note,'createdAt',created_at))
        FROM (SELECT event_id,operator_id,note,created_at FROM voice_billing_review_notes WHERE reservation_key=v.reservation_key ORDER BY sequence DESC LIMIT 5)) AS notesJson
      FROM voice_billing_reviews v JOIN credit_reservations r ON r.idempotency_key=v.reservation_key AND r.user_id=v.user_id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY v.rowid DESC LIMIT 31`,
    )
      .bind(...values)
      .all<{ sequence: number; notesJson: string; [key: string]: unknown }>();
    const items = rows.results
      .slice(0, 30)
      .map(({ notesJson, ...row }) => ({ ...row, notes: JSON.parse(notesJson) }));
    // Usage-billed calls whose rounds lacked a usage report (or exceeded the hold). They
    // were charged only reported usage; the first page lists the latest for the filter.
    const usageItems = before
      ? []
      : (
          await env.DB.prepare(
            `SELECT u.reservation_key AS id,u.user_id AS accountId,u.reason,u.rounds,
            u.missing_rounds AS missingRounds,u.observed_duration_ms AS durationMs,
            u.computed_credits AS computedCredits,u.charged_credits AS chargedCredits,
            u.reserved_credits AS reserved,u.price_version AS priceVersion,u.created_at AS createdAt,
            r.status,r.charged_credits AS charged
            FROM voice_usage_reviews u JOIN credit_reservations r ON r.idempotency_key=u.reservation_key AND r.user_id=u.user_id
            ${conditions.length ? 'WHERE ' + conditions.map((c) => c.replace('v.', 'u.')).join(' AND ') : ''}
            ORDER BY u.created_at DESC LIMIT 30`,
          )
            .bind(...values)
            .all()
        ).results;
    return json(
      {
        items,
        usageItems,
        nextCursor: rows.results.length > 30 ? items.at(-1)!.sequence : null,
      },
      200,
      headers,
    );
  }
  if (url.pathname === `${PATH}/notes` && request.method === 'POST') {
    let body;
    try {
      const bytes = await readBodyBounded(request, 4096);
      if (!bytes) return err('请求过大', 413, headers);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return err('请求格式错误', 400, headers);
    }
    const { eventId, id, accountId, note, observed } = body ?? {};
    if (
      typeof eventId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(eventId) ||
      typeof id !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(id) ||
      typeof accountId !== 'string' ||
      accountId.length < 1 ||
      accountId.length > 128 ||
      typeof note !== 'string' ||
      note.trim().length < 3 ||
      note.length > 1000 ||
      !observed ||
      typeof observed.status !== 'string' ||
      !Number.isSafeInteger(observed.updatedAt) ||
      !(observed.charged === null || Number.isSafeInteger(observed.charged))
    )
      return err('备注或观察版本无效', 400, headers);
    const snapshot = JSON.stringify({
      status: observed.status,
      updatedAt: observed.updatedAt,
      charged: observed.charged,
    });
    const hash = await sha256Hex(
      JSON.stringify({ id, accountId, note, operator: user.id, snapshot }),
    );
    const previous = () =>
      env.DB.prepare('SELECT payload_hash FROM voice_billing_review_notes WHERE event_id=?')
        .bind(eventId)
        .first<{ payload_hash: string }>();
    const existing = await previous();
    if (existing)
      return existing.payload_hash === hash
        ? json({ recorded: true }, 200, headers)
        : err('事件编号已用于其他备注', 409, headers);
    await env.DB.prepare(
      `INSERT INTO voice_billing_review_notes(event_id,reservation_key,operator_id,note,payload_hash,observed_json,created_at)
      SELECT ?,v.reservation_key,?,?,?,?,? FROM voice_billing_reviews v JOIN credit_reservations r ON r.idempotency_key=v.reservation_key AND r.user_id=v.user_id
      WHERE v.reservation_key=? AND v.user_id=? AND r.status=? AND r.updated_at=? AND r.charged_credits IS ?
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
        observed.status,
        observed.updatedAt,
        observed.charged,
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
