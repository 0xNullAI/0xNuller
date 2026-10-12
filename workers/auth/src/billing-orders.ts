import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { err, json, readBodyBounded } from './http';
const PATH = '/api/auth/billing';
const ADMIN = '/api/auth/admin/billing';
const ID = /^[A-Za-z0-9._:-]{8,128}$/;
const PRICE = 'credits-2026-09';
const OFFERS = [
  { id: 'credit-1000', amountMinor: 700, credits: 1000 },
  { id: 'credit-5000', amountMinor: 3500, credits: 5000 },
  { id: 'credit-10000', amountMinor: 7000, credits: 10000 },
  { id: 'credit-20000', amountMinor: 14000, credits: 20000 },
];
interface Order {
  sequence: number;
  id: string;
  user_id: string;
  package_id: string;
  amount_minor: number;
  currency: string;
  credits: number;
  price_version: string;
  status: string;
  version: number;
  created_at: number;
  expires_at: number;
  updated_at: number;
}
const orderView = (r: Order) => ({
  id: r.id,
  packageId: r.package_id,
  amountMinor: r.amount_minor,
  currency: r.currency,
  credits: r.credits,
  priceVersion: r.price_version,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  updatedAt: r.updated_at,
});
/** This input is ONLY for a trusted provider-verification adapter or explicit administrator reconciliation.
 * A browser redirect, client claim or unsigned webhook must NEVER call this function.
 */
export interface VerifiedBillingEvent {
  provider: 'manual';
  eventId: string;
  orderId: string;
  paymentId: string;
  kind: 'paid' | 'refunded';
  amountMinor: number;
  currency: 'CNY';
  operatorUserId: string;
}
export async function applyVerifiedBillingEvent(
  env: SessionEnv,
  event: VerifiedBillingEvent,
): Promise<{ state: 'applied' | 'needs_review' | 'conflict'; reason?: string }> {
  if (
    event.provider !== 'manual' ||
    !ID.test(event.eventId) ||
    !ID.test(event.paymentId) ||
    !ID.test(event.orderId) ||
    !['paid', 'refunded'].includes(event.kind) ||
    !Number.isSafeInteger(event.amountMinor) ||
    event.amountMinor <= 0 ||
    event.currency !== 'CNY' ||
    !event.operatorUserId
  )
    return { state: 'conflict', reason: '事件参数无效' };
  if (
    !(await env.DB.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND banned_at IS NULL")
      .bind(event.operatorUserId)
      .first())
  )
    return { state: 'conflict', reason: '人工对账操作员无管理权限' };
  const hash = await sha256Hex(
    JSON.stringify({
      provider: event.provider,
      eventId: event.eventId,
      orderId: event.orderId,
      paymentId: event.paymentId,
      kind: event.kind,
      amountMinor: event.amountMinor,
      currency: event.currency,
    }),
  );
  const existing = await env.DB.prepare(
    'SELECT payload_hash,state,reason FROM billing_events WHERE provider=? AND event_id=?',
  )
    .bind(event.provider, event.eventId)
    .first<{ payload_hash: string; state: 'applied' | 'needs_review'; reason: string | null }>();
  if (existing)
    return existing.payload_hash === hash
      ? { state: existing.state, ...(existing.reason ? { reason: existing.reason } : {}) }
      : { state: 'conflict', reason: '同一事件编号包含不同内容' };
  const order = await env.DB.prepare('SELECT * FROM billing_orders WHERE id=?')
    .bind(event.orderId)
    .first<Order>();
  if (!order) return { state: 'conflict', reason: '订单不存在' };
  const now = Date.now();
  const payment = await env.DB.prepare(
    'SELECT * FROM billing_payments WHERE provider=? AND payment_id=?',
  )
    .bind(event.provider, event.paymentId)
    .first<{
      order_id: string;
      ledger_reference: string;
      refund_reference: string | null;
      refunded_at: number | null;
    }>();
  let reason: string | null = null;
  if (order.amount_minor !== event.amountMinor || order.currency !== event.currency)
    reason = '支付金额或币种与订单不符';
  if (payment && payment.order_id !== order.id) reason = '支付流水已关联其它订单';
  if (
    event.kind === 'paid' &&
    !payment &&
    (!['awaiting_payment'].includes(order.status) || order.expires_at <= now)
  )
    reason = '订单已关闭或过期，需要人工核对迟到支付';
  if (
    event.kind === 'refunded' &&
    (!payment || !['paid', 'refund_requested', 'refunded'].includes(order.status))
  )
    reason = '未找到可退款的原支付';
  const debitReference = `billing-refund:${event.provider}:${event.paymentId}`;
  const paymentReference = event.paymentId; // Same namespace as existing manual-grant receipts, preventing double funding.
  const createEvent = env.DB.prepare(
    `INSERT INTO billing_events(provider,event_id,order_id,payment_id,kind,amount_minor,currency,payload_hash,state,reason,operator_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,'received',NULL,?,?) ON CONFLICT(provider,event_id) DO NOTHING`,
  ).bind(
    event.provider,
    event.eventId,
    order.id,
    event.paymentId,
    event.kind,
    event.amountMinor,
    event.currency,
    hash,
    event.operatorUserId,
    now,
  );
  const eventGuard = `EXISTS(SELECT 1 FROM billing_events WHERE provider=? AND event_id=? AND payload_hash=? AND state='received')`;
  const eventArgs = [event.provider, event.eventId, hash];
  if (reason) {
    await env.DB.batch([
      createEvent,
      env.DB.prepare(
        `UPDATE billing_events SET state='needs_review',reason=? WHERE provider=? AND event_id=? AND payload_hash=? AND state='received'`,
      ).bind(reason, ...eventArgs),
    ]);
    const final = await env.DB.prepare(
      'SELECT payload_hash,state,reason FROM billing_events WHERE provider=? AND event_id=?',
    )
      .bind(event.provider, event.eventId)
      .first<{ payload_hash: string; state: 'applied' | 'needs_review'; reason: string | null }>();
    return final?.payload_hash === hash
      ? { state: final.state, ...(final.reason ? { reason: final.reason } : {}) }
      : { state: 'conflict', reason: '事件编号冲突' };
  }
  if (event.kind === 'paid') {
    await env.DB.batch([
      createEvent,
      env.DB.prepare(
        `INSERT INTO billing_payments(provider,payment_id,order_id,ledger_reference,paid_at)
    SELECT ?,?,?,?,? FROM billing_orders o WHERE o.id=? AND o.status='awaiting_payment' AND o.expires_at>? AND ${eventGuard}
    AND NOT EXISTS(SELECT 1 FROM credit_ledger WHERE kind='manual_purchase' AND reference_id=?)
    AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=o.user_id)
    AND o.credits + (SELECT COALESCE(SUM(amount_credits),0) FROM admin_credit_audit WHERE operator_user_id=? AND created_at>=?)<=200000
    ON CONFLICT DO NOTHING`,
      ).bind(
        event.provider,
        event.paymentId,
        order.id,
        paymentReference,
        now,
        order.id,
        now,
        ...eventArgs,
        paymentReference,
        event.operatorUserId,
        now - 86400000,
      ),
      env.DB.prepare(
        `INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
    SELECT o.user_id,o.credits,'manual_purchase',p.ledger_reference,o.price_version,?,? FROM billing_orders o JOIN billing_payments p ON p.order_id=o.id
    WHERE o.id=? AND p.provider=? AND p.payment_id=? AND ${eventGuard} ON CONFLICT(user_id,kind,reference_id) DO NOTHING`,
      ).bind(
        JSON.stringify({
          orderId: order.id,
          amountCny: order.amount_minor / 100,
          provider: event.provider,
          operatorUserId: event.operatorUserId,
        }),
        now,
        order.id,
        event.provider,
        event.paymentId,
        ...eventArgs,
      ),
      env.DB.prepare(
        `INSERT INTO admin_credit_audit(operator_user_id,target_user_id,action,amount_cny,amount_credits,external_reference,created_at)
       SELECT ?,o.user_id,'manual_purchase',o.amount_minor/100,o.credits,p.ledger_reference,? FROM billing_orders o JOIN billing_payments p ON p.order_id=o.id JOIN credit_ledger l ON l.reference_id=p.ledger_reference AND l.user_id=o.user_id AND l.kind='manual_purchase'
       WHERE o.id=? AND p.provider=? AND p.payment_id=? AND ${eventGuard} ON CONFLICT(external_reference) DO NOTHING`,
      ).bind(event.operatorUserId, now, order.id, event.provider, event.paymentId, ...eventArgs),
      env.DB.prepare(
        `UPDATE billing_orders SET status='paid',version=version+1,updated_at=? WHERE id=? AND status='awaiting_payment' AND EXISTS(SELECT 1 FROM billing_payments p JOIN credit_ledger l ON l.reference_id=p.ledger_reference AND l.kind='manual_purchase' WHERE p.order_id=billing_orders.id AND l.user_id=billing_orders.user_id)`,
      ).bind(now, order.id),
      env.DB.prepare(
        `UPDATE billing_events SET state=CASE WHEN EXISTS(SELECT 1 FROM billing_payments p JOIN billing_orders o ON o.id=p.order_id WHERE p.order_id=? AND p.provider=? AND p.payment_id=? AND o.status IN ('paid','refund_requested','refunded')) THEN 'applied' ELSE 'needs_review' END,reason=CASE WHEN EXISTS(SELECT 1 FROM billing_payments WHERE order_id=? AND provider=? AND payment_id=?) THEN NULL ELSE '流水已使用或订单状态变化，需要对账' END WHERE provider=? AND event_id=? AND payload_hash=? AND state='received'`,
      ).bind(
        order.id,
        event.provider,
        event.paymentId,
        order.id,
        event.provider,
        event.paymentId,
        ...eventArgs,
      ),
    ]);
  } else {
    // Full refunds only. Do not take Credit already held by a live AI request, or manufacture a cash refund.
    await env.DB.batch([
      createEvent,
      env.DB.prepare(
        `INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
    SELECT o.user_id,-o.credits,'refund',?,o.price_version,?,? FROM billing_orders o JOIN billing_payments p ON p.order_id=o.id
    WHERE o.id=? AND o.status IN ('paid','refund_requested') AND p.provider=? AND p.payment_id=? AND p.refunded_at IS NULL AND ${eventGuard}
    AND o.credits <= (SELECT COALESCE(SUM(amount_credits),0) FROM credit_ledger WHERE user_id=o.user_id) - (SELECT COALESCE(SUM(reserved_credits),0) FROM credit_reservations WHERE user_id=o.user_id AND status='pending' AND updated_at>?)
    ON CONFLICT(user_id,kind,reference_id) DO NOTHING`,
      ).bind(
        debitReference,
        JSON.stringify({
          orderId: order.id,
          amountMinor: event.amountMinor,
          currency: event.currency,
          provider: event.provider,
          operatorUserId: event.operatorUserId,
        }),
        now,
        order.id,
        event.provider,
        event.paymentId,
        ...eventArgs,
        now - 7200000,
      ),
      env.DB.prepare(
        `UPDATE billing_payments SET refunded_at=?,refund_reference=? WHERE order_id=? AND provider=? AND payment_id=? AND refunded_at IS NULL AND EXISTS(SELECT 1 FROM credit_ledger WHERE reference_id=? AND kind='refund')`,
      ).bind(now, debitReference, order.id, event.provider, event.paymentId, debitReference),
      env.DB.prepare(
        `UPDATE billing_orders SET status='refunded',version=version+1,updated_at=? WHERE id=? AND status IN ('paid','refund_requested') AND EXISTS(SELECT 1 FROM billing_payments WHERE order_id=? AND refunded_at IS NOT NULL)`,
      ).bind(now, order.id, order.id),
      env.DB.prepare(
        `UPDATE billing_events SET state=CASE WHEN EXISTS(SELECT 1 FROM billing_payments WHERE order_id=? AND refunded_at IS NOT NULL AND payment_id=? AND provider=?) THEN 'applied' ELSE 'needs_review' END,reason=CASE WHEN EXISTS(SELECT 1 FROM billing_payments WHERE order_id=? AND refunded_at IS NOT NULL) THEN NULL ELSE 'Credit已消费或被预留，需人工处理退款差额' END WHERE provider=? AND event_id=? AND payload_hash=? AND state='received'`,
      ).bind(order.id, event.paymentId, event.provider, order.id, ...eventArgs),
    ]);
  }
  const result = await env.DB.prepare(
    'SELECT state,reason,payload_hash FROM billing_events WHERE provider=? AND event_id=?',
  )
    .bind(event.provider, event.eventId)
    .first<{ state: 'applied' | 'needs_review'; reason: string | null; payload_hash: string }>();
  if (!result || result.payload_hash !== hash) return { state: 'conflict', reason: '事件编号冲突' };
  return { state: result.state, ...(result.reason ? { reason: result.reason } : {}) };
}
export async function handleBillingOrders(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(PATH) && !path.startsWith(ADMIN)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  if (path === `${PATH}/webhook`)
    return err('在线支付商户与签名校验尚未配置，不接受付款通知', 503, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at !== null || request.headers.get('X-Account-Id') !== user.id)
    return err('账号不可用或已切换', 403, headers);
  const admin = path.startsWith(ADMIN);
  if (admin && user.role !== 'admin') return err('无管理权限', 403, headers);
  await env.DB.prepare(
    "UPDATE billing_orders SET status='expired',version=version+1,updated_at=? WHERE user_id=? AND status='awaiting_payment' AND expires_at<=?",
  )
    .bind(Date.now(), user.id, Date.now())
    .run();
  if (path === `${PATH}/catalog` && request.method === 'GET')
    return json(
      {
        currency: 'CNY',
        priceVersion: PRICE,
        onlinePaymentEnabled: false,
        channel: 'manual',
        message: '在线支付尚未接通。创建订单不会扣款或增加Credit，需管理员核实实际付款。',
        packages: OFFERS,
      },
      200,
      headers,
    );
  if ((path === `${PATH}/orders` || path === `${ADMIN}/orders`) && request.method === 'GET') {
    const before = url.searchParams.get('before');
    if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))))
      return err('游标无效', 400, headers);
    const rows = await env.DB.prepare(
      `SELECT * FROM billing_orders WHERE ${admin ? '1=1' : 'user_id=?'} ${before ? 'AND sequence<?' : ''} ORDER BY sequence DESC LIMIT 31`,
    )
      .bind(...(admin ? [] : [user.id]), ...(before ? [Number(before)] : []))
      .all<Order>();
    const page = rows.results.slice(0, 30);
    return json(
      {
        items: page.map((r) => ({ ...orderView(r), ...(admin ? { accountId: r.user_id } : {}) })),
        nextCursor: rows.results.length > 30 ? page.at(-1)!.sequence : null,
      },
      200,
      headers,
    );
  }
  if (path === `${ADMIN}/reconciliation` && request.method === 'GET') {
    const events = await env.DB.prepare(
      'SELECT provider,event_id,order_id,payment_id,kind,amount_minor,currency,state,reason,operator_user_id,created_at FROM billing_events ORDER BY created_at DESC,event_id DESC LIMIT 100',
    ).all();
    return json({ events: events.results, onlinePaymentEnabled: false }, 200, headers);
  }
  const match = new RegExp(
    `^${admin ? ADMIN : PATH}/orders/([A-Za-z0-9._:-]{8,128})(?:/(cancel|refund-request|confirm-payment|confirm-refund))?$`,
  ).exec(path);
  if (!match) return err('接口不存在', 404, headers);
  const id = match[1]!;
  const action = match[2];
  const order = await env.DB.prepare(
    `SELECT * FROM billing_orders WHERE id=? ${admin ? '' : 'AND user_id=?'}`,
  )
    .bind(id, ...(admin ? [] : [user.id]))
    .first<Order>();
  if (!action && request.method === 'GET')
    return order ? json({ item: orderView(order) }, 200, headers) : err('订单不存在', 404, headers);
  const bytes = await readBodyBounded(request, 4000);
  if (!bytes) return err('请求过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || Array.isArray(body)) throw new Error();
  } catch {
    return err('请求格式无效', 400, headers);
  }
  const now = Date.now();
  if (!admin && !action && request.method === 'PUT') {
    const offer = OFFERS.find((o) => o.id === body.packageId);
    if (!offer || body.priceVersion !== PRICE) return err('充值档位或价格版本无效', 400, headers);
    if (order)
      return order.package_id === offer.id
        ? json({ item: orderView(order) }, 200, headers)
        : err('订单编号已使用', 409, headers);
    const created = await env.DB.prepare(
      `INSERT INTO billing_orders(id,user_id,package_id,amount_minor,currency,credits,price_version,status,created_at,expires_at,updated_at)
    SELECT ?,?,?,?,'CNY',?,?,'awaiting_payment',?,?,? WHERE (SELECT COUNT(*) FROM billing_orders WHERE user_id=? AND status='awaiting_payment' AND expires_at>?)<5 AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?) ON CONFLICT(id) DO NOTHING RETURNING *`,
    )
      .bind(
        id,
        user.id,
        offer.id,
        offer.amountMinor,
        offer.credits,
        PRICE,
        now,
        now + 86400000,
        now,
        user.id,
        now,
        user.id,
      )
      .first<Order>();
    return created
      ? json({ item: orderView(created) }, 201, headers)
      : err('订单编号已使用或待确认订单达到上限', 409, headers);
  }
  if (!order) return err('订单不存在', 404, headers);
  if (
    admin &&
    request.method === 'POST' &&
    (action === 'confirm-payment' || action === 'confirm-refund')
  ) {
    if (
      body.confirmedExternalPayment !== true ||
      typeof body.paymentId !== 'string' ||
      typeof body.eventId !== 'string' ||
      body.amountMinor !== order.amount_minor ||
      body.currency !== order.currency
    )
      return err('必须核实外部实际收款/退款、流水及精确金额', 400, headers);
    const result = await applyVerifiedBillingEvent(env, {
      provider: 'manual',
      eventId: body.eventId,
      paymentId: body.paymentId,
      orderId: id,
      kind: action === 'confirm-payment' ? 'paid' : 'refunded',
      amountMinor: order.amount_minor,
      currency: 'CNY',
      operatorUserId: user.id,
    });
    return json(
      result,
      result.state === 'conflict' ? 409 : result.state === 'needs_review' ? 202 : 200,
      headers,
    );
  }
  if (!admin && request.method === 'POST' && (action === 'cancel' || action === 'refund-request')) {
    if (!Number.isSafeInteger(body.version) || body.version !== order.version)
      return err('订单已变化，请刷新', 409, headers);
    if (action === 'cancel') {
      const updated = await env.DB.prepare(
        "UPDATE billing_orders SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND status='awaiting_payment' RETURNING *",
      )
        .bind(now, id, user.id, body.version)
        .first<Order>();
      return updated
        ? json({ item: orderView(updated) }, 200, headers)
        : err('此订单不能取消', 409, headers);
    }
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500)
      return err('请填写退款原因', 400, headers);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE billing_orders SET status='refund_requested',version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND status='paid'",
      ).bind(now, id, user.id, body.version),
      env.DB.prepare(
        "INSERT INTO billing_refund_requests(order_id,reason,requested_at,updated_at) SELECT id,?,?,? FROM billing_orders WHERE id=? AND user_id=? AND status='refund_requested' AND version=? ON CONFLICT(order_id) DO NOTHING",
      ).bind(body.reason.trim(), now, now, id, user.id, order.version + 1),
    ]);
    const updated = await env.DB.prepare('SELECT * FROM billing_orders WHERE id=? AND user_id=?')
      .bind(id, user.id)
      .first<Order>();
    return updated?.status === 'refund_requested'
      ? json(
          { item: orderView(updated), message: '已提交人工退款申请，未执行实际退款。' },
          200,
          headers,
        )
      : err('此订单不能申请退款', 409, headers);
  }
  return err('不支持此操作', 405, headers);
}
