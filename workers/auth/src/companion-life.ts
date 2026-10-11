import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';

const PATH = '/api/auth/companion-life';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const KINDS = new Set(['person', 'event', 'milestone', 'lifecycle']);
const STAGES = new Set(['getting_to_know', 'established', 'reconnecting', 'paused', 'ended']);
const COLUMNS =
  'id,relationship_id,kind,label,title,content,occurred_on,person_ids,version,created_at,updated_at';
interface Row {
  id: string;
  relationship_id: string;
  kind: string;
  label: string;
  title: string;
  content: string;
  occurred_on: string | null;
  person_ids: string;
  version: number;
  created_at: number;
  updated_at: number;
}
function view(row: Row) {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    kind: row.kind,
    label: row.label,
    title: row.title,
    content: row.content,
    occurredOn: row.occurred_on,
    personIds: JSON.parse(row.person_ids) as string[],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function validDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Each edge refers to an explicitly saved person inside the same private relationship. */
export async function handleCompanionLife(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH && !url.pathname.startsWith(`${PATH}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (
    user.banned_at != null ||
    (request.headers.has('X-Account-Id') && request.headers.get('X-Account-Id') !== user.id)
  )
    return err('账号不可用或已切换', 403, headers);
  const relationshipId = url.searchParams.get('relationshipId');
  if (!relationshipId || !ID.test(relationshipId)) return err('关系编号无效', 400, headers);
  if (
    !(await env.DB.prepare(
      'SELECT id FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL',
    )
      .bind(user.id, relationshipId)
      .first())
  )
    return err('关系不存在或已删除', 404, headers);
  if (url.pathname === PATH && request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM companion_life_records WHERE user_id=? AND relationship_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 200`,
    )
      .bind(user.id, relationshipId)
      .all<Row>();
    return json({ items: rows.results.map(view) }, 200, headers);
  }
  const id = url.pathname.slice(PATH.length + 1);
  if (!ID.test(id)) return err('记录编号无效', 400, headers);
  if (request.method !== 'PUT' && request.method !== 'DELETE')
    return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 20_000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  const allowed = new Set(
    request.method === 'DELETE'
      ? ['version']
      : ['version', 'kind', 'label', 'title', 'content', 'occurredOn', 'personIds'],
  );
  const { version } = body;
  if (
    Object.keys(body).some((key) => !allowed.has(key)) ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    return err('字段或版本无效', 400, headers);
  const now = Date.now();
  if (request.method === 'DELETE') {
    const changed = await env.DB.prepare(
      `UPDATE companion_life_records SET title='',content='',label='',occurred_on=NULL,person_ids='[]',deleted_at=?,updated_at=?,version=version+1 WHERE user_id=? AND relationship_id=? AND id=? AND version=? AND deleted_at IS NULL AND kind<>'lifecycle' RETURNING id`,
    )
      .bind(now, now, user.id, relationshipId, id, version)
      .first();
    return changed
      ? json({ ok: true }, 200, headers)
      : err('记录已变更；关系阶段只能修改，不能删除', 409, headers);
  }
  const { kind, label, title, content } = body;
  const occurredOn = body.occurredOn ?? null;
  const people = body.personIds ?? [];
  if (
    typeof kind !== 'string' ||
    !KINDS.has(kind) ||
    typeof label !== 'string' ||
    label.length > 80 ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 120 ||
    typeof content !== 'string' ||
    content.length > 4000 ||
    !validDate(occurredOn) ||
    !Array.isArray(people) ||
    people.length > 20 ||
    people.some((p) => typeof p !== 'string' || !ID.test(p)) ||
    new Set(people).size !== people.length ||
    ((kind === 'person' || kind === 'lifecycle') && people.length > 0) ||
    (kind === 'lifecycle' && !STAGES.has(label))
  )
    return err('请填写有效内容、日期与人物关联', 400, headers);
  const peopleJson = JSON.stringify(people);
  // Guards live inside the writing statement, not just a preflight read: deletion cannot race a write.
  const guard = `EXISTS(SELECT 1 FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM companion_life_records p WHERE p.user_id=? AND p.relationship_id=? AND p.id=j.value AND p.kind='person' AND p.deleted_at IS NULL))`;
  const row =
    version === 0
      ? await env.DB.prepare(
          `INSERT INTO companion_life_records(user_id,id,relationship_id,kind,label,title,content,occurred_on,person_ids,version,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,1,?,? WHERE ${guard} AND (SELECT COUNT(*) FROM companion_life_records WHERE user_id=? AND relationship_id=? AND deleted_at IS NULL)<${kind === 'lifecycle' ? 200 : 199}
      ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
        )
          .bind(
            user.id,
            id,
            relationshipId,
            kind,
            label.trim(),
            title.trim(),
            content.trim(),
            occurredOn,
            peopleJson,
            now,
            now,
            user.id,
            relationshipId,
            peopleJson,
            user.id,
            relationshipId,
            user.id,
            relationshipId,
          )
          .first<Row>()
      : await env.DB.prepare(
          `UPDATE companion_life_records SET label=?,title=?,content=?,occurred_on=?,person_ids=?,updated_at=?,version=version+1
      WHERE user_id=? AND relationship_id=? AND id=? AND kind=? AND version=? AND deleted_at IS NULL AND ${guard} RETURNING ${COLUMNS}`,
        )
          .bind(
            label.trim(),
            title.trim(),
            content.trim(),
            occurredOn,
            peopleJson,
            now,
            user.id,
            relationshipId,
            id,
            kind,
            version,
            user.id,
            relationshipId,
            peopleJson,
            user.id,
            relationshipId,
          )
          .first<Row>();
  return row
    ? json({ item: view(row) }, version === 0 ? 201 : 200, headers)
    : err('记录或关联已变更、已删除或达到上限，请刷新核对', 409, headers);
}
