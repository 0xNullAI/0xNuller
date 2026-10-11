import { err, json, readBodyBounded } from './http';
import { MEMORY_COLUMNS, memoryView, type MemoryRow } from './memory-records';
import { currentUser, type SessionEnv } from './session-domain';

const PEOPLE_PATH = '/api/auth/memory-people';
const FACTS_PATH = '/api/auth/memory-facts';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_PEOPLE = 200;
const PERSON_COLUMNS =
  'id, relationship_id, display_name, aliases_json, version, created_at, updated_at';

interface PersonRow {
  id: string;
  relationship_id: string;
  display_name: string;
  aliases_json: string;
  version: number;
  created_at: number;
  updated_at: number;
}
interface PersonAliases {
  id: string;
  normalized_aliases_json: string;
}

function personView(row: PersonRow) {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    displayName: row.display_name,
    aliases: JSON.parse(row.aliases_json) as string[],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function normalizedAlias(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= 2 &&
    value.length <= 60 &&
    !hasControlCharacter(value)
  );
}
function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const bytes = await readBodyBounded(request, 5000);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function fieldsAre(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}
function forEachAliasSpan(
  input: string,
  alias: string,
  visit: (start: number, end: number) => boolean,
) {
  if (!alias) return false;
  const latin = /^[a-z0-9]/u.test(alias);
  let start = input.indexOf(alias);
  while (start >= 0) {
    const end = start + alias.length;
    const before = input[start - 1] ?? '';
    const after = input[end] ?? '';
    if ((!latin || (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after))) && visit(start, end))
      return true;
    start = input.indexOf(alias, start + 1);
  }
  return false;
}

/** Only explicit, active relationship identities can expand a query. Same aliases may name different people. */
export async function matchedMemoryPeople(
  env: Pick<SessionEnv, 'DB'>,
  userId: string,
  relationshipId: string,
  query: string,
): Promise<Map<string, string[]>> {
  const input = normalizedAlias(query);
  if (!input) return new Map();
  const rows = await env.DB.prepare(
    `SELECT id,normalized_aliases_json FROM memory_people
     WHERE user_id=? AND relationship_id=? AND deleted_at IS NULL
     ORDER BY updated_at DESC,id ASC LIMIT ?`,
  )
    .bind(userId, relationshipId, MAX_PEOPLE)
    .all<PersonAliases>();
  const people = rows.results.map((row) => ({
    id: row.id,
    aliases: JSON.parse(row.normalized_aliases_json) as string[],
  }));
  const longestEndAtStart = new Int32Array(input.length + 1);
  for (const person of people)
    for (const alias of person.aliases)
      forEachAliasSpan(input, alias, (start, end) => {
        longestEndAtStart[start] = Math.max(longestEndAtStart[start]!, end);
        return false;
      });
  const longestEarlierEnd = new Int32Array(input.length + 1);
  let furthest = 0;
  for (let start = 0; start <= input.length; start += 1) {
    longestEarlierEnd[start] = furthest;
    furthest = Math.max(furthest, longestEndAtStart[start]!);
  }
  // A longer explicit alias resolves the same text span ahead of a shared short name.
  // Separate spans still allow asking about two people in one query.
  return new Map(
    people.flatMap((person) => {
      const matchedAliases = person.aliases.filter((alias) =>
        forEachAliasSpan(
          input,
          alias,
          (start, end) => longestEarlierEnd[start]! < end && longestEndAtStart[start] === end,
        ),
      );
      return matchedAliases.length ? [[person.id, matchedAliases] as const] : [];
    }),
  );
}

/** Owner-only explicit correction and person editing. Router integration is kept in Auth index. */
export async function handleMemoryFacts(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    path !== PEOPLE_PATH &&
    !path.startsWith(`${PEOPLE_PATH}/`) &&
    !path.startsWith(`${FACTS_PATH}/`)
  )
    return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (request.headers.get('X-Account-Id') !== user.id)
    return err('账号已切换，请重新打开记忆', 403, headers);
  if (user.banned_at !== null) return err('账号不可用', 403, headers);

  if (path === PEOPLE_PATH) {
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const relationshipId = url.searchParams.get('relationshipId');
    if (!relationshipId || !ID.test(relationshipId)) return err('关系编号无效', 400, headers);
    const rows = await env.DB.prepare(
      `SELECT ${PERSON_COLUMNS} FROM memory_people
       WHERE user_id=? AND relationship_id=? AND deleted_at IS NULL
         AND EXISTS(SELECT 1 FROM character_relationships r WHERE r.user_id=? AND r.id=? AND r.deleted_at IS NULL)
       ORDER BY updated_at DESC,id ASC LIMIT ?`,
    )
      .bind(user.id, relationshipId, user.id, relationshipId, MAX_PEOPLE)
      .all<PersonRow>();
    return json({ items: rows.results.map(personView), limit: MAX_PEOPLE }, 200, headers);
  }

  const personLink = /^\/api\/auth\/memory-people\/([A-Za-z0-9_-]{1,80})\/link$/u.exec(path);
  if (personLink) {
    if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
    const body = await bodyOf(request);
    if (
      !body ||
      !fieldsAre(body, ['personVersion', 'memoryId', 'memoryVersion']) ||
      !validVersion(body.personVersion) ||
      !validVersion(body.memoryVersion) ||
      typeof body.memoryId !== 'string' ||
      !ID.test(body.memoryId)
    )
      return err('人物关联参数无效', 400, headers);
    const now = Date.now();
    const row = await env.DB.prepare(
      `UPDATE personal_memories AS m SET person_id=?,updated_at=?,version=version+1
       WHERE m.user_id=? AND m.id=? AND m.version=? AND m.scope='relationship'
         AND m.state='active' AND m.deleted_at IS NULL AND m.superseded_by_id IS NULL
         AND (m.expires_at IS NULL OR m.expires_at>?)
         AND EXISTS(SELECT 1 FROM memory_people p JOIN character_relationships r
           ON r.user_id=p.user_id AND r.id=p.relationship_id
           WHERE p.user_id=m.user_id AND p.id=? AND p.version=?
             AND p.relationship_id=m.relationship_id AND p.deleted_at IS NULL AND r.deleted_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=m.user_id)
       RETURNING ${MEMORY_COLUMNS}`,
    )
      .bind(
        personLink[1],
        now,
        user.id,
        body.memoryId,
        body.memoryVersion,
        now,
        personLink[1],
        body.personVersion,
      )
      .first<MemoryRow>();
    if (!row) return err('人物或记忆已变更、跨关系或已删除，请刷新后重试', 409, headers);
    return json({ item: memoryView(row) }, 200, headers);
  }

  const unlinkPerson = /^\/api\/auth\/memory-facts\/([A-Za-z0-9_-]{1,80})\/person$/u.exec(path);
  if (unlinkPerson) {
    if (request.method !== 'DELETE') return err('不支持此操作', 405, headers);
    const body = await bodyOf(request);
    if (!body || !fieldsAre(body, ['version']) || !validVersion(body.version) || body.version === 0)
      return err('记忆版本无效', 400, headers);
    const now = Date.now();
    const row = await env.DB.prepare(
      `UPDATE personal_memories AS m SET person_id=NULL,updated_at=?,version=version+1
       WHERE m.user_id=? AND m.id=? AND m.version=? AND m.scope='relationship'
         AND m.person_id IS NOT NULL AND m.state='active' AND m.deleted_at IS NULL
         AND m.superseded_by_id IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
         AND EXISTS(SELECT 1 FROM character_relationships r WHERE r.user_id=m.user_id
           AND r.id=m.relationship_id AND r.deleted_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=m.user_id)
       RETURNING ${MEMORY_COLUMNS}`,
    )
      .bind(now, user.id, unlinkPerson[1], body.version, now)
      .first<MemoryRow>();
    if (!row) return err('记忆已变更、未关联人物或已删除，请刷新后重试', 409, headers);
    return json({ item: memoryView(row) }, 200, headers);
  }

  const personPath = /^\/api\/auth\/memory-people\/([A-Za-z0-9_-]{1,80})$/u.exec(path);
  if (personPath) {
    if (!['PUT', 'DELETE'].includes(request.method)) return err('不支持此操作', 405, headers);
    const body = await bodyOf(request);
    if (!body || !validVersion(body.version)) return err('人物版本无效', 400, headers);
    const id = personPath[1];
    const now = Date.now();
    if (request.method === 'DELETE') {
      if (!fieldsAre(body, ['version']) || body.version === 0)
        return err('人物删除参数无效', 400, headers);
      const row = await env.DB.prepare(
        `UPDATE memory_people SET display_name='',aliases_json='[]',normalized_aliases_json='[]',
          deleted_at=?,updated_at=?,version=version+1
         WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL RETURNING id`,
      )
        .bind(now, now, user.id, id, body.version)
        .first();
      if (!row) return err('人物已变更或删除，请刷新后重试', 409, headers);
      return json({ ok: true }, 200, headers);
    }
    if (
      !fieldsAre(body, ['version', 'relationshipId', 'displayName', 'aliases']) ||
      typeof body.relationshipId !== 'string' ||
      !ID.test(body.relationshipId) ||
      !validName(body.displayName) ||
      !Array.isArray(body.aliases) ||
      body.aliases.length > 10 ||
      !body.aliases.every(validName)
    )
      return err('人物名称或别名无效', 400, headers);
    const aliases = [body.displayName, ...body.aliases] as string[];
    const normalized = aliases.map(normalizedAlias);
    if (new Set(normalized).size !== normalized.length) return err('人物别名重复', 400, headers);
    const row =
      body.version === 0
        ? await env.DB.prepare(
            `INSERT INTO memory_people(user_id,id,relationship_id,display_name,aliases_json,
               normalized_aliases_json,version,created_at,updated_at)
             SELECT ?,?,?,?,?,?,1,?,? WHERE
               EXISTS(SELECT 1 FROM character_relationships r WHERE r.user_id=? AND r.id=? AND r.deleted_at IS NULL)
               AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=?)
               AND (SELECT COUNT(*) FROM memory_people WHERE user_id=? AND deleted_at IS NULL)<?
             ON CONFLICT(user_id,id) DO NOTHING RETURNING ${PERSON_COLUMNS}`,
          )
            .bind(
              user.id,
              id,
              body.relationshipId,
              body.displayName,
              JSON.stringify(body.aliases),
              JSON.stringify(normalized),
              now,
              now,
              user.id,
              body.relationshipId,
              user.id,
              user.id,
              MAX_PEOPLE,
            )
            .first<PersonRow>()
        : await env.DB.prepare(
            `UPDATE memory_people SET display_name=?,aliases_json=?,normalized_aliases_json=?,
                updated_at=?,version=version+1
             WHERE user_id=? AND id=? AND relationship_id=? AND version=? AND deleted_at IS NULL
               AND EXISTS(SELECT 1 FROM character_relationships r WHERE r.user_id=? AND r.id=? AND r.deleted_at IS NULL)
               AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=?)
             RETURNING ${PERSON_COLUMNS}`,
          )
            .bind(
              body.displayName,
              JSON.stringify(body.aliases),
              JSON.stringify(normalized),
              now,
              user.id,
              id,
              body.relationshipId,
              body.version,
              user.id,
              body.relationshipId,
              user.id,
            )
            .first<PersonRow>();
    if (!row) return err('人物已变更、已删除或达到上限，请刷新后重试', 409, headers);
    return json({ item: personView(row) }, body.version === 0 ? 201 : 200, headers);
  }

  const supersede = /^\/api\/auth\/memory-facts\/([A-Za-z0-9_-]{1,80})\/supersede$/u.exec(path);
  if (supersede) {
    if (request.method !== 'POST') return err('不支持此操作', 405, headers);
    const body = await bodyOf(request);
    if (
      !body ||
      !fieldsAre(body, ['version', 'replacementId', 'replacementVersion']) ||
      !validVersion(body.version) ||
      body.version === 0 ||
      !validVersion(body.replacementVersion) ||
      body.replacementVersion === 0 ||
      typeof body.replacementId !== 'string' ||
      !ID.test(body.replacementId) ||
      body.replacementId === supersede[1]
    )
      return err('事实纠错参数无效', 400, headers);
    const now = Date.now();
    const row = await env.DB.prepare(
      `UPDATE personal_memories AS old SET superseded_by_id=?,updated_at=?,version=version+1
       WHERE old.user_id=? AND old.id=? AND old.version=? AND old.state='active'
         AND old.deleted_at IS NULL AND old.superseded_by_id IS NULL
         AND (old.expires_at IS NULL OR old.expires_at>?)
         AND EXISTS(SELECT 1 FROM personal_memories newer WHERE newer.user_id=old.user_id
           AND newer.id=? AND newer.version=? AND newer.scope=old.scope
           AND newer.relationship_id IS old.relationship_id AND newer.state='active'
           AND newer.deleted_at IS NULL AND newer.superseded_by_id IS NULL
           AND (newer.expires_at IS NULL OR newer.expires_at>?))
         AND (old.scope='account' OR EXISTS(SELECT 1 FROM character_relationships r
           WHERE r.user_id=old.user_id AND r.id=old.relationship_id AND r.deleted_at IS NULL))
         AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=old.user_id)
       RETURNING ${MEMORY_COLUMNS}`,
    )
      .bind(
        body.replacementId,
        now,
        user.id,
        supersede[1],
        body.version,
        now,
        body.replacementId,
        body.replacementVersion,
        now,
      )
      .first<MemoryRow>();
    if (!row) return err('旧事实或新事实已变更、跨范围或已删除，请刷新后重试', 409, headers);
    return json({ item: memoryView(row) }, 200, headers);
  }
  const correct = /^\/api\/auth\/memory-facts\/([A-Za-z0-9_-]{1,80})\/correct$/u.exec(path);
  if (correct) {
    if (request.method !== 'POST') return err('不支持此操作', 405, headers);
    const body = await bodyOf(request);
    if (
      !body ||
      !fieldsAre(body, ['version', 'kind', 'title', 'content']) ||
      !validVersion(body.version) ||
      body.version === 0 ||
      typeof body.kind !== 'string' ||
      !['preference', 'person', 'event', 'note'].includes(body.kind) ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 100 ||
      typeof body.content !== 'string' ||
      !body.content.trim() ||
      body.content.length > 4000
    )
      return err('更正事实参数无效', 400, headers);
    const replacementId = `corrected-${crypto.randomUUID()}`;
    const now = Date.now();
    // D1 batch is transactional: the new, manually authored fact and retirement
    // of the old fact commit together. No source citation is copied to a correction.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO personal_memories
         (user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,
          tier,state,expires_at,person_id)
         SELECT old.user_id,?,?,?,?,1,?,?,old.scope,old.relationship_id,old.tier,'active',
           CASE WHEN old.tier='medium' THEN ? ELSE NULL END,old.person_id
         FROM personal_memories old
         WHERE old.user_id=? AND old.id=? AND old.version=? AND old.state='active'
           AND old.deleted_at IS NULL AND old.superseded_by_id IS NULL
           AND (old.expires_at IS NULL OR old.expires_at>?)
           AND (old.scope='account' OR EXISTS(SELECT 1 FROM character_relationships r
             WHERE r.user_id=old.user_id AND r.id=old.relationship_id AND r.deleted_at IS NULL))
           AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=old.user_id)`,
      ).bind(
        replacementId,
        body.kind,
        body.title.trim(),
        body.content.trim(),
        now,
        now,
        now + 30 * 86400_000,
        user.id,
        correct[1],
        body.version,
        now,
      ),
      env.DB.prepare(
        `UPDATE personal_memories AS old SET superseded_by_id=?,updated_at=?,version=version+1
         WHERE old.user_id=? AND old.id=? AND old.version=? AND old.state='active'
           AND old.deleted_at IS NULL AND old.superseded_by_id IS NULL
           AND EXISTS(SELECT 1 FROM personal_memories newer WHERE newer.user_id=old.user_id
             AND newer.id=? AND newer.version=1 AND newer.scope=old.scope
             AND newer.relationship_id IS old.relationship_id AND newer.state='active'
             AND newer.deleted_at IS NULL AND newer.superseded_by_id IS NULL)`,
      ).bind(replacementId, now, user.id, correct[1], body.version, replacementId),
    ]);
    const replacement = await env.DB.prepare(
      `SELECT ${MEMORY_COLUMNS} FROM personal_memories WHERE user_id=? AND id=?`,
    )
      .bind(user.id, replacementId)
      .first<MemoryRow>();
    if (!replacement) return err('旧事实已变更或删除，请刷新后重试', 409, headers);
    return json({ item: memoryView(replacement), replacesId: correct[1] }, 201, headers);
  }
  return err('记忆操作不存在', 404, headers);
}
