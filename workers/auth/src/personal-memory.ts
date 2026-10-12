import { err, json, readBodyBounded } from './http';
import { MEMORY_COLUMNS as COLUMNS, memoryView as view, type MemoryRow } from './memory-records';
import { currentUser, type SessionEnv } from './session-domain';

const PATH = '/api/auth/personal-memories';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const KINDS = new Set(['preference', 'person', 'event', 'note']);
const MAX_ITEMS = 200;

/** Expired medium-term excerpts lose their private text and stop occupying the active limit. */
export async function expireMediumMemories(
  env: Pick<SessionEnv, 'DB'>,
  now = Date.now(),
): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE personal_memories SET title='',content='',deleted_at=?,updated_at=?,version=version+1
     WHERE (user_id,id) IN (
       SELECT user_id,id FROM personal_memories
       WHERE tier='medium' AND expires_at IS NOT NULL AND expires_at<=? AND deleted_at IS NULL
       ORDER BY expires_at,user_id,id LIMIT 500
     ) AND deleted_at IS NULL RETURNING id`,
  )
    .bind(now, now, now)
    .all<{ id: string }>();
  return result.results.length;
}

/** Account-owned, explicitly authored memories; no public or group read path. */
export async function handlePersonalMemories(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== PATH && !path.startsWith(`${PATH}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id)
    return err('账号已切换，请重新打开个人记忆', 403, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);

  if (path === PATH && request.method === 'GET') {
    const scope = url.searchParams.get('scope') ?? 'account';
    const relationshipId = url.searchParams.get('relationshipId');
    if (
      !['account', 'relationship'].includes(scope) ||
      (scope === 'relationship' && !relationshipId)
    )
      return err('记忆范围无效', 400, headers);
    if (
      scope === 'relationship' &&
      !(await env.DB.prepare(
        'SELECT id FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL',
      )
        .bind(user.id, relationshipId)
        .first())
    )
      return err('关系不存在或已删除', 404, headers);
    const rows = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM personal_memories
       WHERE user_id = ? AND scope = ? AND relationship_id IS ? AND deleted_at IS NULL ORDER BY updated_at DESC, id ASC LIMIT ?`,
    )
      .bind(user.id, scope, scope === 'relationship' ? relationshipId : null, MAX_ITEMS)
      .all<MemoryRow>();
    return json({ items: rows.results.map(view), limit: MAX_ITEMS }, 200, headers);
  }

  if (path === `${PATH}/export` && request.method === 'GET') {
    // Everything the account remembers, across account and relationship scopes,
    // so the user can keep or inspect it. Deleted memories are already erased.
    const [memories, relationships] = await Promise.all([
      env.DB.prepare(
        `SELECT ${COLUMNS} FROM personal_memories WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY scope, relationship_id, updated_at DESC, id ASC`,
      )
        .bind(user.id)
        .all<MemoryRow>(),
      env.DB.prepare(
        `SELECT id, character_id, ai_nickname, user_preferred_name, relationship_type
         FROM character_relationships WHERE user_id = ? AND deleted_at IS NULL ORDER BY id`,
      )
        .bind(user.id)
        .all<{
          id: string;
          character_id: string;
          ai_nickname: string;
          user_preferred_name: string;
          relationship_type: string;
        }>(),
    ]);
    return json(
      {
        format: '0xnuller-memories',
        version: 1,
        exportedAt: new Date().toISOString(),
        relationships: relationships.results.map((row) => ({
          id: row.id,
          characterId: row.character_id,
          aiNickname: row.ai_nickname,
          userPreferredName: row.user_preferred_name,
          relationshipType: row.relationship_type,
        })),
        memories: memories.results.map(view),
      },
      200,
      { ...headers, 'Content-Disposition': 'attachment; filename="0xnuller-memories.json"' },
    );
  }

  const id = path.slice(PATH.length + 1);
  if (!ID.test(id)) return err('记忆编号无效', 400, headers);
  if (request.method !== 'PUT' && request.method !== 'DELETE') {
    return err('不支持此操作', 405, headers);
  }
  const bytes = await readBodyBounded(request, 20_000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body');
    body = parsed as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  const allowed =
    request.method === 'DELETE'
      ? new Set(['version'])
      : new Set([
          'version',
          'kind',
          'title',
          'content',
          'scope',
          'relationshipId',
          'tier',
          'state',
        ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return err('包含不支持的字段', 400, headers);
  }
  const version = body.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return err('记忆版本无效', 400, headers);
  }
  const now = Date.now();
  if (request.method === 'DELETE') {
    const deleted = await env.DB.prepare(
      `UPDATE personal_memories SET title = '', content = '', deleted_at = ?, updated_at = ?,
       version = version + 1 WHERE user_id = ? AND id = ? AND version = ? AND deleted_at IS NULL
       RETURNING id`,
    )
      .bind(now, now, user.id, id, version)
      .first();
    if (!deleted) return err('记忆已变更或删除，请刷新后重试', 409, headers);
    return json({ ok: true }, 200, headers);
  }

  const { kind, title, content } = body;
  const scope = body.scope ?? 'account';
  const relationshipId = body.relationshipId ?? null;
  const tier = body.tier ?? 'long';
  const state = body.state ?? 'active';
  if (
    typeof scope !== 'string' ||
    !['account', 'relationship'].includes(scope) ||
    typeof tier !== 'string' ||
    !['long', 'medium', 'history'].includes(tier) ||
    typeof state !== 'string' ||
    !['active', 'suggested'].includes(state) ||
    (scope === 'account' && relationshipId !== null) ||
    (scope === 'relationship' && (typeof relationshipId !== 'string' || !ID.test(relationshipId)))
  )
    return err('记忆范围或层级无效', 400, headers);
  if (
    scope === 'relationship' &&
    !(await env.DB.prepare(
      'SELECT id FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL',
    )
      .bind(user.id, relationshipId)
      .first())
  )
    return err('关系不存在或已删除', 404, headers);
  if (
    typeof kind !== 'string' ||
    !KINDS.has(kind) ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 100 ||
    typeof content !== 'string' ||
    !content.trim() ||
    content.length > 4000
  ) {
    return err('请填写类型、标题（最多 100 字）和内容（最多 4000 字）', 400, headers);
  }

  const row =
    version === 0
      ? await env.DB.prepare(
          `INSERT INTO personal_memories
         (user_id, id, kind, title, content, version, created_at, updated_at, scope, relationship_id, tier, state, expires_at)
         SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ? WHERE
         (SELECT COUNT(*) FROM personal_memories WHERE user_id = ? AND deleted_at IS NULL) < ?
         AND (?='account' OR EXISTS(SELECT 1 FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL))
         ON CONFLICT(user_id, id) DO NOTHING RETURNING ${COLUMNS}`,
        )
          .bind(
            user.id,
            id,
            kind,
            title.trim(),
            content.trim(),
            now,
            now,
            scope,
            relationshipId,
            tier,
            state,
            tier === 'medium' ? now + 30 * 86400_000 : null,
            user.id,
            MAX_ITEMS,
            scope,
            user.id,
            relationshipId,
          )
          .first<MemoryRow>()
      : await env.DB.prepare(
          `UPDATE personal_memories SET kind = ?, title = ?, content = ?, version = version + 1,
         updated_at = ?, tier = ?, state = ?, expires_at = ? WHERE user_id = ? AND id = ? AND version = ? AND scope = ? AND relationship_id IS ? AND deleted_at IS NULL AND superseded_by_id IS NULL
         AND (?='account' OR EXISTS(SELECT 1 FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL))
         AND (json_array_length(source_refs)=0 OR expires_at IS NULL OR expires_at>?)
         RETURNING ${COLUMNS}`,
        )
          .bind(
            kind,
            title.trim(),
            content.trim(),
            now,
            tier,
            state,
            tier === 'medium' ? now + 30 * 86400_000 : null,
            user.id,
            id,
            version,
            scope,
            relationshipId,
            scope,
            user.id,
            relationshipId,
            now,
          )
          .first<MemoryRow>();
  if (!row) {
    return err('记忆已变更、已删除或达到 200 条上限，请刷新后重试', 409, headers);
  }
  return json({ item: view(row) }, version === 0 ? 201 : 200, headers);
}
