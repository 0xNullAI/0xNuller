import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';
const PATH = '/api/auth/character-appearance/';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
interface AppearanceRow {
  photo_id: string | null;
  scale: number;
  position: string;
  version: number;
}
export async function handleCharacterAppearance(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PATH)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (
    user.banned_at != null ||
    (request.headers.has('X-Account-Id') && request.headers.get('X-Account-Id') !== user.id)
  )
    return err('账户不可用或已切换', 403, headers);
  const id = path.slice(PATH.length);
  if (!ID.test(id)) return err('关系编号无效', 400, headers);
  const relationship = await env.DB.prepare(
    'SELECT id FROM character_relationships WHERE user_id = ? AND id = ? AND deleted_at IS NULL',
  )
    .bind(user.id, id)
    .first();
  if (!relationship) return err('私人关系不存在', 404, headers);
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT a.scale, a.position, a.version,
      CASE WHEN p.status = 'ready' AND p.user_id = a.user_id THEN a.photo_id ELSE NULL END AS photo_id
      FROM character_appearances a LEFT JOIN user_photos p ON p.id = a.photo_id WHERE a.user_id = ? AND a.relationship_id = ?`,
    )
      .bind(user.id, id)
      .first<AppearanceRow>();
    return json(
      {
        item: row
          ? {
              photoId: row.photo_id,
              scale: row.scale,
              position: row.position,
              version: row.version,
            }
          : { photoId: null, scale: 35, position: 'right', version: 0 },
      },
      200,
      headers,
    );
  }
  if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 2000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return err('格式错误', 400, headers);
  }
  const { photoId, scale, position, version } = body;
  if (
    Object.keys(body).some((key) => !['photoId', 'scale', 'position', 'version'].includes(key)) ||
    (photoId !== null && (typeof photoId !== 'string' || !ID.test(photoId))) ||
    typeof scale !== 'number' ||
    !Number.isInteger(scale) ||
    scale < 15 ||
    scale > 70 ||
    !['left', 'center', 'right'].includes(String(position)) ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    return err('外观参数无效', 400, headers);
  if (
    photoId !== null &&
    !(await env.DB.prepare(
      "SELECT id FROM user_photos WHERE id = ? AND user_id = ? AND status = 'ready'",
    )
      .bind(photoId, user.id)
      .first())
  )
    return err('请选择本人已上传的可用图片', 400, headers);
  const result = await env.DB.prepare(
    `INSERT INTO character_appearances (user_id, relationship_id, photo_id, scale, position, version)
    SELECT ?, ?, ?, ?, ?, 1 WHERE ? = 0 AND EXISTS (SELECT 1 FROM character_relationships WHERE user_id = ? AND id = ? AND deleted_at IS NULL)
    ON CONFLICT(user_id, relationship_id) DO NOTHING RETURNING version`,
  )
    .bind(user.id, id, photoId, scale, position, version, user.id, id)
    .first();
  if (version === 0 && !result) return err('外观已更新，请重新加载', 409, headers);
  if (version > 0) {
    const update = await env.DB.prepare(
      `UPDATE character_appearances SET photo_id = ?, scale = ?, position = ?, version = version + 1 WHERE user_id = ? AND relationship_id = ? AND version = ? AND EXISTS (SELECT 1 FROM character_relationships WHERE user_id = ? AND id = ? AND deleted_at IS NULL) RETURNING version`,
    )
      .bind(photoId, scale, position, user.id, id, version, user.id, id)
      .first();
    if (!update) return err('外观已更新，请重新加载', 409, headers);
  }
  return json({ item: { photoId, scale, position, version: version + 1 } }, 200, headers);
}
