import { err, json, readBodyBounded } from './http';
import { currentUser } from './session-domain';
import type { AutoMemoryEnv } from './auto-memory';

const PATH = '/api/auth/conversation-digest-preferences/';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
interface Row {
  enabled: number;
  version: number;
  updated_at: number;
}

export async function handleConversationDigestPreference(
  request: Request,
  env: AutoMemoryEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PATH)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const relationshipId = path.slice(PATH.length);
  if (!ID.test(relationshipId)) return err('关系编号无效', 400, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at !== null) return err('账号不可用', 403, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id) return err('账号已切换', 403, headers);
  const relationship = await env.DB.prepare(
    'SELECT 1 FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL',
  )
    .bind(user.id, relationshipId)
    .first();
  if (!relationship) return err('关系不存在或已删除', 404, headers);
  const available = Boolean(env.MINIMAX_MEDIA_API_KEY?.trim());
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT enabled,version,updated_at FROM conversation_digest_preferences WHERE user_id=? AND relationship_id=?',
    )
      .bind(user.id, relationshipId)
      .first<Row>();
    return json(
      {
        item: {
          enabled: row?.enabled === 1,
          version: row?.version ?? 0,
          updatedAt: row?.updated_at ?? null,
        },
        available,
      },
      200,
      headers,
    );
  }
  if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 1000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body');
    body = parsed as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  if (
    Object.keys(body).some((key) => key !== 'enabled' && key !== 'version') ||
    typeof body.enabled !== 'boolean' ||
    typeof body.version !== 'number' ||
    !Number.isSafeInteger(body.version) ||
    body.version < 0
  )
    return err('摘要设置无效', 400, headers);
  if (body.enabled && !available) return err('摘要服务暂不可用', 503, headers);
  const now = Date.now();
  const row =
    body.version === 0
      ? await env.DB.prepare(
          `INSERT INTO conversation_digest_preferences(user_id,relationship_id,enabled,version,updated_at)
         SELECT ?,?,?,1,? WHERE EXISTS(SELECT 1 FROM character_relationships
           WHERE user_id=? AND id=? AND deleted_at IS NULL)
         ON CONFLICT DO NOTHING RETURNING enabled,version,updated_at`,
        )
          .bind(user.id, relationshipId, body.enabled ? 1 : 0, now, user.id, relationshipId)
          .first<Row>()
      : await env.DB.prepare(
          `UPDATE conversation_digest_preferences SET enabled=?,version=version+1,updated_at=?
         WHERE user_id=? AND relationship_id=? AND version=?
           AND EXISTS(SELECT 1 FROM character_relationships
             WHERE user_id=? AND id=? AND deleted_at IS NULL)
         RETURNING enabled,version,updated_at`,
        )
          .bind(
            body.enabled ? 1 : 0,
            now,
            user.id,
            relationshipId,
            body.version,
            user.id,
            relationshipId,
          )
          .first<Row>();
  if (!row) return err('设置已变更，请刷新后重试', 409, headers);
  if (!body.enabled) {
    await env.DB.prepare('DELETE FROM conversation_digests WHERE user_id=? AND relationship_id=?')
      .bind(user.id, relationshipId)
      .run();
    await env.DB.prepare(
      `DELETE FROM conversation_digest_attempts WHERE user_id=? AND conversation_id IN
       (SELECT id FROM server_conversations WHERE user_id=? AND json_extract(metadata,'$.relationshipId')=?)`,
    )
      .bind(user.id, user.id, relationshipId)
      .run();
  }
  return json(
    {
      item: { enabled: row.enabled === 1, version: row.version, updatedAt: row.updated_at },
      available,
    },
    200,
    headers,
  );
}
