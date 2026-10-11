import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';

const PATH = /^\/api\/auth\/conversations\/([A-Za-z0-9._:-]{1,128})\/memory-access$/;
interface AccessRow {
  enabled: number;
  version: number;
  updated_at: number;
}
function view(row: AccessRow | null) {
  return {
    enabled: row?.enabled === 1,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
  };
}

/** Account-level facts require an explicit grant for this exact owned, bound AI chat. */
export async function handleAccountMemoryAccess(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at !== null || request.headers.get('X-Account-Id') !== user.id)
    return err('账号不可用或已切换', 403, headers);
  const conversationId = match[1]!;
  const owned = `SELECT 1 FROM server_conversations c
    JOIN character_relationships r ON r.user_id=c.user_id
      AND r.id=json_extract(c.metadata,'$.relationshipId')
      AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
    WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=c.user_id)`;
  if (!(await env.DB.prepare(owned).bind(user.id, conversationId).first()))
    return err('私人会话不存在或尚未绑定角色', 404, headers);

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT enabled,version,updated_at FROM conversation_account_memory_access WHERE user_id=? AND conversation_id=?',
    )
      .bind(user.id, conversationId)
      .first<AccessRow>();
    return json({ item: view(row) }, 200, headers);
  }
  if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 512);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  if (
    Object.keys(body).some((key) => key !== 'enabled' && key !== 'version') ||
    typeof body.enabled !== 'boolean' ||
    !Number.isSafeInteger(body.version) ||
    (body.version as number) < 0
  )
    return err('记忆开放设置无效', 400, headers);
  const now = Date.now();
  const row =
    body.version === 0
      ? await env.DB.prepare(
          `INSERT INTO conversation_account_memory_access(user_id,conversation_id,enabled,version,updated_at)
           SELECT ?,?,?,1,? WHERE EXISTS(${owned})
           ON CONFLICT DO NOTHING RETURNING enabled,version,updated_at`,
        )
          .bind(user.id, conversationId, body.enabled ? 1 : 0, now, user.id, conversationId)
          .first<AccessRow>()
      : await env.DB.prepare(
          `UPDATE conversation_account_memory_access SET enabled=?,version=version+1,updated_at=?
           WHERE user_id=? AND conversation_id=? AND version=? AND EXISTS(${owned})
           RETURNING enabled,version,updated_at`,
        )
          .bind(
            body.enabled ? 1 : 0,
            now,
            user.id,
            conversationId,
            body.version,
            user.id,
            conversationId,
          )
          .first<AccessRow>();
  if (!row) return err('设置已变更，请刷新后重试', 409, headers);
  return json({ item: view(row) }, 200, headers);
}
