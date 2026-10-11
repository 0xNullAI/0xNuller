interface ReportEnv {
  DB: D1Database;
  AUTH: {
    marketAccountIdentity(credentials: {
      authorization: string | null;
      cookie: string | null;
    }): Promise<{ id: string } | null>;
    marketAccountAccess(credentials: {
      authorization: string | null;
      cookie: string | null;
    }): Promise<'admin' | 'user' | 'unauthorized'>;
  };
}
const REASONS = ['unsafe', 'harassment', 'privacy', 'copyright', 'spam'];
const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, X-Account-Id',
  'Access-Control-Allow-Origin': '*',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
interface ReportRow {
  id: string;
  item_id: string;
  status: string;
}
export async function handleReports(request: Request, env: ReportEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const report = /^\/api\/items\/([\w-]{1,128})\/report$/.exec(url.pathname);
  const resolve = /^\/api\/items\/admin\/reports\/([\w-]{1,128})$/.exec(url.pathname);
  const queue = url.pathname === '/api/items/admin/reports';
  if (!report && !resolve && !queue) return null;
  // The old anonymous counter endpoint stays removed.
  if (report && request.method === 'POST') return null;
  const credentials = {
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  };
  const account = await env.AUTH.marketAccountIdentity(credentials);
  if (!account) return json({ error: '请先登录' }, 401);
  if (request.headers.get('X-Account-Id') !== account.id)
    return json({ error: '账户已切换，请刷新' }, 409);
  if (!report && (await env.AUTH.marketAccountAccess(credentials)) !== 'admin')
    return json({ error: '需要管理员权限' }, 403);
  if (queue) {
    if (request.method !== 'GET') return json({ error: '不支持此操作' }, 405);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return json({ error: '分页无效' }, 400);
    const rows = await env.DB.prepare(
      `SELECT r.id,r.item_id AS itemId,r.item_name AS itemName,r.reason,r.created_at AS createdAt,i.hidden FROM item_reports r JOIN items i ON i.id=r.item_id WHERE r.status='pending' AND i.hidden=0 ORDER BY r.created_at,r.id LIMIT 51 OFFSET ?`,
    )
      .bind(offset)
      .all();
    return json({
      items: rows.results.slice(0, 50),
      nextOffset: rows.results.length > 50 ? offset + 50 : null,
    });
  }
  if (request.method !== (report ? 'PUT' : 'PATCH')) return json({ error: '不支持此操作' }, 405);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: '请求无效' }, 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 1024) {
      await reader.cancel();
      return json({ error: '请求过大' }, 413);
    }
    chunks.push(part.value);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))),
    );
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: '请求无效' }, 400);
  }
  if (report) {
    if (
      Object.keys(body).length !== 1 ||
      typeof body.reason !== 'string' ||
      !REASONS.includes(String(body.reason))
    )
      return json({ error: '请选择有效举报理由' }, 400);
    const item = await env.DB.prepare(
      `SELECT name FROM items WHERE id=? AND hidden=0 AND type='scenario'
       AND CASE WHEN json_valid(content) THEN json_type(content,'$.prompt')='text' AND length(trim(json_extract(content,'$.prompt')))>0 ELSE 0 END`,
    )
      .bind(report[1])
      .first<{ name: string }>();
    if (!item) return json({ error: '角色不存在或已下架' }, 404);
    const previous = await env.DB.prepare(
      'SELECT id FROM item_reports WHERE item_id=? AND reporter_id=?',
    )
      .bind(report[1], account.id)
      .first();
    if (previous) return json({ ok: true });
    const now = Date.now();
    const created = await env.DB.prepare(
      `INSERT INTO item_reports(id,item_id,item_name,reporter_id,reason,created_at)
    SELECT ?,i.id,i.name,?,?,? FROM items i WHERE i.id=? AND i.hidden=0 AND i.type='scenario'
      AND CASE WHEN json_valid(i.content) THEN json_type(i.content,'$.prompt')='text' AND length(trim(json_extract(i.content,'$.prompt')))>0 ELSE 0 END
    AND (SELECT COUNT(*) FROM item_reports WHERE reporter_id=? AND created_at>?)<10
    ON CONFLICT(item_id,reporter_id) DO NOTHING RETURNING id`,
    )
      .bind(
        crypto.randomUUID(),
        account.id,
        body.reason,
        now,
        report[1],
        account.id,
        now - 86_400_000,
      )
      .first();
    if (!created) {
      const duplicate = await env.DB.prepare(
        'SELECT id FROM item_reports WHERE item_id=? AND reporter_id=?',
      )
        .bind(report[1], account.id)
        .first();
      if (!duplicate) return json({ error: '暂时无法举报，请稍后重试或刷新角色状态' }, 429);
    }
    return json({ ok: true });
  }
  if (
    Object.keys(body).length !== 1 ||
    typeof body.action !== 'string' ||
    !['hide', 'dismiss'].includes(String(body.action))
  )
    return json({ error: '处理动作无效' }, 400);
  const row = await env.DB.prepare('SELECT id,item_id,status FROM item_reports WHERE id=?')
    .bind(resolve![1])
    .first<ReportRow>();
  if (!row) return json({ error: '举报不存在' }, 404);
  const intended = body.action === 'hide' ? 'hidden' : 'dismissed';
  if (row.status !== 'pending')
    return row.status === intended
      ? json({ ok: true })
      : json({ error: '举报已处理，请刷新队列' }, 409);
  const changed =
    body.action === 'hide'
      ? await env.DB.prepare(
          "UPDATE items SET hidden=1 WHERE id=? AND EXISTS(SELECT 1 FROM item_reports WHERE id=? AND status='pending') RETURNING id",
        )
          .bind(row.item_id, row.id)
          .first()
      : await env.DB.prepare(
          "UPDATE item_reports SET status='dismissed',resolved_at=? WHERE id=? AND status='pending' RETURNING id",
        )
          .bind(Date.now(), row.id)
          .first();
  return changed ? json({ ok: true }) : json({ error: '内容状态已变化，请刷新队列' }, 409);
}
