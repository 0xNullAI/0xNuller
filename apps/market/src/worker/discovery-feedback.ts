import { getItem } from './db';

interface FeedbackEnv {
  DB: D1Database;
  AUTH: {
    marketAccountIdentity(credentials: {
      authorization: string | null;
      cookie: string | null;
    }): Promise<{ id: string } | null>;
    marketItemCreator(itemId: string): Promise<{ id: string } | null>;
  };
}

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, X-Account-Id',
  'Access-Control-Allow-Origin': '*',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

export async function handleDiscoveryFeedback(
  request: Request,
  env: FeedbackEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const list = path === '/api/items/discovery-feedback';
  const create = /^\/api\/items\/([\w-]{1,128})\/discovery-feedback$/.exec(path);
  const remove = /^\/api\/items\/discovery-feedback\/(item|creator)\/([\w-]{1,128})$/.exec(path);
  if (!list && !create && !remove) return null;
  const identity = await env.AUTH.marketAccountIdentity({
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  });
  if (!identity) return json({ error: '请先登录' }, 401);
  if (request.headers.get('X-Account-Id') !== identity.id)
    return json({ error: '账户已切换，请刷新' }, 409);
  const account = identity.id;
  if (list) {
    if (request.method !== 'GET') return json({ error: '不支持此操作' }, 405);
    const rows = await env.DB.prepare(
      `SELECT f.target_kind AS kind,f.target_id AS targetId,f.reason,
       f.source_item_id AS sourceItemId,i.name AS sourceItemName,f.created_at AS createdAt
       FROM character_discovery_feedback f LEFT JOIN items i ON i.id=f.source_item_id
       WHERE f.account_id=? ORDER BY f.created_at DESC,f.target_id LIMIT 200`,
    )
      .bind(account)
      .all();
    return json({ items: rows.results ?? [], accountId: account });
  }
  if (remove) {
    if (request.method !== 'DELETE') return json({ error: '不支持此操作' }, 405);
    await env.DB.prepare(
      'DELETE FROM character_discovery_feedback WHERE account_id=? AND target_kind=? AND target_id=?',
    )
      .bind(account, remove[1], remove[2])
      .run();
    return json({ ok: true, accountId: account });
  }
  if (request.method !== 'PUT') return json({ error: '不支持此操作' }, 405);
  if (Number(request.headers.get('Content-Length')) > 500) return json({ error: '请求过大' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: '请选择有效反馈' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 500) {
      await reader.cancel();
      return json({ error: '请求过大' }, 413);
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: '请选择有效反馈' }, 400);
  }
  const reason = body.reason;
  if (
    !['not_interested', 'too_similar', 'hide_creator'].includes(String(reason)) ||
    Object.keys(body).some((key) => !['reason', 'creatorId'].includes(key)) ||
    (reason !== 'hide_creator' && body.creatorId !== undefined)
  )
    return json({ error: '请选择有效反馈' }, 400);
  const item = await getItem(env.DB, create![1]!);
  if (
    !item ||
    item.type !== 'scenario' ||
    typeof (item.content as { prompt?: unknown }).prompt !== 'string' ||
    !(item.content as { prompt: string }).prompt.trim()
  )
    return json({ error: '角色不存在或已下架' }, 404);
  let kind = 'item';
  let target = item.id;
  if (reason === 'hide_creator') {
    const creator = await env.AUTH.marketItemCreator(item.id);
    if (!creator) return json({ error: '无法确认发布账户' }, 409);
    if (body.creatorId !== creator.id) return json({ error: '发布账户已变化，请刷新' }, 409);
    kind = 'creator';
    target = creator.id;
  }
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO character_discovery_owner_checks(account_id) VALUES(?) ON CONFLICT(account_id) DO NOTHING',
  )
    .bind(account)
    .run();
  await env.DB.prepare(
    `INSERT INTO character_discovery_feedback(account_id,target_kind,target_id,reason,source_item_id,created_at)
     SELECT ?,?,?,?,?,? WHERE
       (SELECT COUNT(*) FROM character_discovery_feedback WHERE account_id=?)<200
       OR EXISTS(SELECT 1 FROM character_discovery_feedback WHERE account_id=? AND target_kind=? AND target_id=?)
     ON CONFLICT(account_id,target_kind,target_id) DO UPDATE SET
       reason=excluded.reason,source_item_id=excluded.source_item_id,created_at=excluded.created_at`,
  )
    .bind(account, kind, target, reason, item.id, now, account, account, kind, target)
    .run();
  const saved = await env.DB.prepare(
    'SELECT 1 FROM character_discovery_feedback WHERE account_id=? AND target_kind=? AND target_id=?',
  )
    .bind(account, kind, target)
    .first();
  return saved
    ? json({ kind, targetId: target, reason, accountId: account })
    : json({ error: '反馈偏好已达200条上限' }, 409);
}
