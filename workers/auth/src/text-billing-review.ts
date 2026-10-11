import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { err, json, readBodyBounded } from './http';
const PATH = '/api/auth/admin/billing/text-reconciliation';
export async function handleTextBillingReview(
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
    const rows = await env.DB.prepare(
      `SELECT t.rowid AS sequence,t.reservation_key AS id,r.user_id AS accountId,r.model_id AS model,
      t.state,r.status,t.charge AS confirmedCharge,r.charged_credits AS charged,r.reserved_credits AS reserved,
      t.reason,t.updated_at AS updatedAt,t.attempts,t.next_attempt_at AS nextAttemptAt,
      json_extract(t.metadata_json,'$.usage.prompt_tokens') AS promptTokens,
      json_extract(t.metadata_json,'$.usage.completion_tokens') AS completionTokens,
      (SELECT json_group_array(json_object('eventId',event_id,'operatorId',operator_id,'note',note,'createdAt',created_at))
        FROM (SELECT event_id,operator_id,note,created_at FROM text_billing_reviews WHERE reservation_key=t.reservation_key ORDER BY sequence DESC LIMIT 5)) AS notesJson
      FROM text_billing_outbox t JOIN credit_reservations r ON r.idempotency_key=t.reservation_key
      WHERE (t.state='needs_review' OR r.status='pending' OR EXISTS(SELECT 1 FROM text_billing_reviews WHERE reservation_key=t.reservation_key)) ${before ? 'AND t.rowid<?' : ''}
      ORDER BY t.rowid DESC LIMIT 31`,
    )
      .bind(...(before ? [Number(before)] : []))
      .all<{ sequence: number; notesJson: string; [key: string]: unknown }>();
    const items = rows.results
      .slice(0, 30)
      .map(({ notesJson, ...row }) => ({ ...row, notes: JSON.parse(notesJson) }));
    return json(
      { items, nextCursor: rows.results.length > 30 ? items.at(-1)!.sequence : null },
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
    const { eventId, id, note, observed } = body ?? {};
    if (
      typeof eventId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(eventId) ||
      typeof id !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(id) ||
      typeof note !== 'string' ||
      note.trim().length < 3 ||
      note.length > 1000 ||
      !observed ||
      typeof observed.state !== 'string' ||
      typeof observed.status !== 'string' ||
      !Number.isSafeInteger(observed.updatedAt) ||
      !(observed.confirmedCharge === null || Number.isSafeInteger(observed.confirmedCharge))
    )
      return err('备注或观察版本无效', 400, headers);
    const snapshot = JSON.stringify({
      state: observed.state,
      status: observed.status,
      updatedAt: observed.updatedAt,
      confirmedCharge: observed.confirmedCharge,
    });
    const hash = await sha256Hex(JSON.stringify({ id, note, operator: user.id, snapshot }));
    const previous = () =>
      env.DB.prepare('SELECT payload_hash FROM text_billing_reviews WHERE event_id=?')
        .bind(eventId)
        .first<{ payload_hash: string }>();
    const existing = await previous();
    if (existing)
      return existing.payload_hash === hash
        ? json({ recorded: true }, 200, headers)
        : err('事件编号已用于其他备注', 409, headers);
    await env.DB.prepare(
      `INSERT INTO text_billing_reviews(event_id,reservation_key,operator_id,note,payload_hash,observed_json,created_at)
      SELECT ?,t.reservation_key,?,?,?,?,? FROM text_billing_outbox t JOIN credit_reservations r ON r.idempotency_key=t.reservation_key
      WHERE t.reservation_key=? AND t.state=? AND r.status=? AND t.updated_at=? AND t.charge IS ?
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
        observed.state,
        observed.status,
        observed.updatedAt,
        observed.confirmedCharge,
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
