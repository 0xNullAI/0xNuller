interface ConversionEnv {
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

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, X-Account-Id',
  'Access-Control-Allow-Origin': '*',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

function isCharacterContent(content: 'content' | 'i.content'): string {
  return `(CASE WHEN json_valid(${content}) THEN COALESCE(
    json_extract(${content}, '$.kind') = 'character' OR
    (json_extract(${content}, '$.kind') IS NULL AND
      json_extract(${content}, '$.characterCard.schemaVersion') = 1), 0) ELSE 0 END)`;
}

/** An acknowledged click or completed start action; never a chat or relationship event. */
export async function handleCharacterConversion(
  request: Request,
  env: ConversionEnv,
  now = Date.now(),
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const admin = path === '/api/items/admin/character-conversions';
  const event = /^\/api\/items\/([\w-]{1,128})\/character-(detail-open|start)$/.exec(path);
  if (!admin && !event) return null;
  const credentials = {
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  };
  const identity = await env.AUTH.marketAccountIdentity(credentials);
  if (!identity) return json({ error: '请先登录' }, 401);
  if (request.headers.get('X-Account-Id') !== identity.id)
    return json({ error: '账户已切换，请刷新' }, 409);
  if (admin) {
    if (request.method !== 'GET') return json({ error: '不支持此操作' }, 405);
    if ((await env.AUTH.marketAccountAccess(credentials)) !== 'admin')
      return json({ error: '需要管理员权限' }, 403);
    const firstDay = Math.floor(now / 86_400_000) - 29;
    const rows = await env.DB.prepare(
      `SELECT e.item_id AS itemId,i.name AS itemName,
       COUNT(DISTINCT e.account_id) AS openedAccounts,
       COUNT(DISTINCT CASE WHEN e.event_type='start' THEN e.account_id END) AS startedAccounts
       FROM character_conversion_events e JOIN items i ON i.id=e.item_id
       WHERE e.day>=? AND i.hidden=0 AND i.type='scenario'
         AND ${isCharacterContent('i.content')}
       GROUP BY e.item_id HAVING COUNT(DISTINCT e.account_id)>=5
       ORDER BY startedAccounts DESC,openedAccounts DESC,e.item_id LIMIT 100`,
    )
      .bind(firstDay)
      .all();
    return json({ windowDays: 30, items: rows.results ?? [] });
  }
  if (request.method !== 'POST') return json({ error: '不支持此操作' }, 405);
  // An empty POST may still arrive with a (zero-length) body stream through a proxy;
  // only actual content is rejected.
  if (request.body && (await request.arrayBuffer()).byteLength > 0)
    return json({ error: '此事件不接受正文' }, 400);
  const itemId = event![1]!;
  const item = await env.DB.prepare(
    `SELECT 1 FROM items WHERE id=? AND hidden=0 AND type='scenario'
     AND CASE WHEN json_valid(content) THEN json_type(content,'$.prompt')='text' AND length(trim(json_extract(content,'$.prompt')))>0 ELSE 0 END
     AND ${isCharacterContent('content')}`,
  )
    .bind(itemId)
    .first();
  if (!item) return json({ error: '角色不存在或已下架' }, 404);
  const day = Math.floor(now / 86_400_000);
  const eventType = event![2] === 'start' ? 'start' : 'detail_open';
  await env.DB.prepare(
    'INSERT INTO character_discovery_owner_checks(account_id) VALUES(?) ON CONFLICT(account_id) DO NOTHING',
  )
    .bind(identity.id)
    .run();
  const saved = await env.DB.prepare(
    `INSERT INTO character_conversion_events(account_id,item_id,day,event_type,created_at)
     SELECT ?,i.id,?,?,? FROM items i WHERE i.id=? AND i.hidden=0 AND i.type='scenario'
       AND CASE WHEN json_valid(i.content) THEN json_type(i.content,'$.prompt')='text' AND length(trim(json_extract(i.content,'$.prompt')))>0 ELSE 0 END
       AND ${isCharacterContent('i.content')}
       AND ((SELECT COUNT(*) FROM character_conversion_events WHERE account_id=? AND day=? AND event_type=?)<100
         OR EXISTS(SELECT 1 FROM character_conversion_events WHERE account_id=? AND item_id=? AND day=? AND event_type=?))
     ON CONFLICT(account_id,item_id,day,event_type) DO NOTHING`,
  )
    .bind(
      identity.id,
      day,
      eventType,
      now,
      itemId,
      identity.id,
      day,
      eventType,
      identity.id,
      itemId,
      day,
      eventType,
    )
    .run();
  if (saved.meta.changes) return json({ recorded: true });
  const existing = await env.DB.prepare(
    'SELECT 1 FROM character_conversion_events WHERE account_id=? AND item_id=? AND day=? AND event_type=?',
  )
    .bind(identity.id, itemId, day, eventType)
    .first();
  if (existing) return json({ recorded: true });
  return json({ error: '每日记录已达上限或角色已下架' }, 429);
}

export async function purgeExpiredCharacterConversions(
  db: D1Database,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare('DELETE FROM character_conversion_events WHERE day<?')
    .bind(Math.floor(now / 86_400_000) - 29)
    .run();
}

/** One Auth lookup per owner; failures retain the marker for the next daily sweep. */
export async function purgeInactiveDiscoveryOwners(
  env: Pick<ConversionEnv, 'DB'> & {
    AUTH: { marketAccountActive(userId: string): Promise<boolean> };
  },
  now = Date.now(),
): Promise<void> {
  const owners = await env.DB.prepare(
    'SELECT account_id FROM character_discovery_owner_checks ORDER BY last_checked_at,account_id LIMIT 100',
  ).all<{ account_id: string }>();
  for (const row of owners.results ?? []) {
    try {
      if (!(await env.AUTH.marketAccountActive(row.account_id))) {
        await env.DB.prepare('DELETE FROM character_discovery_feedback WHERE account_id=?')
          .bind(row.account_id)
          .run();
        await env.DB.prepare('DELETE FROM character_conversion_events WHERE account_id=?')
          .bind(row.account_id)
          .run();
        await env.DB.prepare('DELETE FROM character_discovery_owner_checks WHERE account_id=?')
          .bind(row.account_id)
          .run();
        continue;
      }
      const remaining = await env.DB.prepare(
        `SELECT 1 FROM character_discovery_feedback WHERE account_id=?
         UNION ALL SELECT 1 FROM character_conversion_events WHERE account_id=? LIMIT 1`,
      )
        .bind(row.account_id, row.account_id)
        .first();
      if (remaining)
        await env.DB.prepare(
          'UPDATE character_discovery_owner_checks SET last_checked_at=? WHERE account_id=?',
        )
          .bind(now, row.account_id)
          .run();
      else
        await env.DB.prepare('DELETE FROM character_discovery_owner_checks WHERE account_id=?')
          .bind(row.account_id)
          .run();
    } catch (error) {
      console.error('market_discovery_owner_cleanup_retry_needed', row.account_id, error);
    }
  }
}
