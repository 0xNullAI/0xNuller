import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';
import { validCharacterId } from './group-ai-ticket';

const PATH = '/api/auth/character-relationships';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ITEMS = 200;
const VOICE = /^[A-Za-z0-9_.:-]{0,64}$/;
const COLUMNS =
  'id, character_id, ai_nickname, user_preferred_name, relationship_type, notes, voice, version, created_at, updated_at';
interface RelationshipRow {
  id: string;
  character_id: string;
  ai_nickname: string;
  user_preferred_name: string;
  relationship_type: string;
  notes: string;
  voice: string;
  version: number;
  created_at: number;
  updated_at: number;
}
function view(row: RelationshipRow) {
  return {
    id: row.id,
    characterId: row.character_id,
    aiNickname: row.ai_nickname,
    userPreferredName: row.user_preferred_name,
    relationshipType: row.relationship_type,
    notes: row.notes,
    voice: row.voice,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Private account preferences only: neither public card updates nor group requests write these. */
export async function handleCharacterRelationships(
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
    return err('账号已切换，请重新打开角色关系', 403, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  if (path === PATH) {
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const characterId = url.searchParams.get('characterId');
    if (characterId !== null && !validCharacterId(characterId))
      return err('角色编号无效', 400, headers);
    const statement = env.DB.prepare(
      `SELECT ${COLUMNS} FROM character_relationships WHERE user_id = ? AND deleted_at IS NULL
       ${characterId === null ? '' : 'AND character_id = ?'} ORDER BY updated_at DESC, id ASC LIMIT ?`,
    );
    const rows = await (
      characterId === null
        ? statement.bind(user.id, MAX_ITEMS)
        : statement.bind(user.id, characterId, MAX_ITEMS)
    ).all<RelationshipRow>();
    return json({ items: rows.results.map(view), limit: MAX_ITEMS }, 200, headers);
  }
  if (path === `${PATH}/ensure`) {
    if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
    if (account !== user.id) return err('账号已切换，请重新打开角色关系', 409, headers);
    const bytes = await readBodyBounded(request, 1000);
    if (!bytes) return err('内容过大', 413, headers);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    } catch {
      return err('请求格式无效', 400, headers);
    }
    if (
      Object.keys(body).some((key) => key !== 'characterId') ||
      !validCharacterId(body.characterId)
    )
      return err('角色编号无效', 400, headers);
    const characterId = body.characterId;
    const existing = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM character_relationships WHERE user_id=? AND character_id=? AND deleted_at IS NULL`,
    )
      .bind(user.id, characterId)
      .first<RelationshipRow>();
    if (existing) return json({ item: view(existing) }, 200, headers);
    // An explicit deletion is not silently undone by opening the chat again.
    const deleted = await env.DB.prepare(
      'SELECT 1 FROM character_relationships WHERE user_id=? AND character_id=? AND deleted_at IS NOT NULL',
    )
      .bind(user.id, characterId)
      .first();
    if (deleted) return err('专属关系已删除；可在设置中手动重新建立', 409, headers);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO character_relationships
       (user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at)
       SELECT ?,?,?, '', '', '', '', 1, ?, ?
       WHERE (SELECT COUNT(*) FROM character_relationships WHERE user_id=? AND deleted_at IS NULL) < ?
         AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?)
         AND NOT EXISTS(SELECT 1 FROM character_relationships WHERE user_id=? AND character_id=? AND deleted_at IS NOT NULL)
       ON CONFLICT DO NOTHING`,
    )
      .bind(
        user.id,
        crypto.randomUUID(),
        characterId,
        now,
        now,
        user.id,
        MAX_ITEMS,
        user.id,
        user.id,
        characterId,
      )
      .run();
    const created = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM character_relationships WHERE user_id=? AND character_id=? AND deleted_at IS NULL`,
    )
      .bind(user.id, characterId)
      .first<RelationshipRow>();
    return created
      ? json({ item: view(created) }, 200, headers)
      : err('关系数量已达上限或已删除，请刷新', 409, headers);
  }
  const id = path.slice(PATH.length + 1);
  if (!ID.test(id)) return err('关系编号无效', 400, headers);
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM character_relationships WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    )
      .bind(user.id, id)
      .first<RelationshipRow>();
    return row ? json({ item: view(row) }, 200, headers) : err('关系不存在或已删除', 404, headers);
  }
  if (request.method !== 'PUT' && request.method !== 'DELETE')
    return err('不支持此操作', 405, headers);
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
          'characterId',
          'aiNickname',
          'userPreferredName',
          'relationshipType',
          'notes',
          'voice',
        ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    return err('包含不支持的字段', 400, headers);
  const version = body.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return err('关系版本无效', 400, headers);
  }
  const now = Date.now();
  if (request.method === 'DELETE') {
    const deleted = await env.DB.prepare(
      `UPDATE character_relationships SET ai_nickname = '', user_preferred_name = '',
       relationship_type = '', notes = '', voice = '', deleted_at = ?, updated_at = ?, version = version + 1
       WHERE user_id = ? AND id = ? AND version = ? AND deleted_at IS NULL RETURNING id`,
    )
      .bind(now, now, user.id, id, version)
      .first();
    return deleted
      ? json({ ok: true }, 200, headers)
      : err('关系已变更或删除，请刷新后重试', 409, headers);
  }
  const { characterId, aiNickname, userPreferredName, relationshipType, notes } = body;
  if (
    !validCharacterId(characterId) ||
    typeof aiNickname !== 'string' ||
    aiNickname.length > 80 ||
    typeof userPreferredName !== 'string' ||
    userPreferredName.length > 80 ||
    typeof relationshipType !== 'string' ||
    relationshipType.length > 80 ||
    typeof notes !== 'string' ||
    notes.length > 4000
  ) {
    return err('请填写有效角色编号、称呼/关系（最多 80 字）和备注（最多 4000 字）', 400, headers);
  }
  // Optional so clients that predate the field keep the saved voice.
  const voice = body.voice;
  if (voice !== undefined && (typeof voice !== 'string' || !VOICE.test(voice)))
    return err('音色无效', 400, headers);
  const row =
    version === 0
      ? await env.DB.prepare(
          `INSERT INTO character_relationships
       (user_id, id, character_id, ai_nickname, user_preferred_name, relationship_type, notes, voice, version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE
       (SELECT COUNT(*) FROM character_relationships WHERE user_id = ? AND deleted_at IS NULL) < ?
       ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
        )
          .bind(
            user.id,
            id,
            characterId,
            aiNickname.trim(),
            userPreferredName.trim(),
            relationshipType.trim(),
            notes.trim(),
            voice ?? '',
            now,
            now,
            user.id,
            MAX_ITEMS,
          )
          .first<RelationshipRow>()
      : await env.DB.prepare(
          `UPDATE character_relationships SET ai_nickname = ?, user_preferred_name = ?, relationship_type = ?,
       notes = ?, voice = COALESCE(?, voice), version = version + 1, updated_at = ?
       WHERE user_id = ? AND id = ? AND character_id = ? AND version = ? AND deleted_at IS NULL RETURNING ${COLUMNS}`,
        )
          .bind(
            aiNickname.trim(),
            userPreferredName.trim(),
            relationshipType.trim(),
            notes.trim(),
            voice ?? null,
            now,
            user.id,
            id,
            characterId,
            version,
          )
          .first<RelationshipRow>();
  if (!row) return err('关系已变更、已存在、已删除或达到 200 条上限，请刷新后重试', 409, headers);
  return json({ item: view(row) }, version === 0 ? 201 : 200, headers);
}
