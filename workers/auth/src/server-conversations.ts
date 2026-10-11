import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';

const PATH = '/api/auth/conversations';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BYTES = 2_000_000;
type Message = {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  kind?: 'camera_observation';
};
type PublicSession = {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  metadata: Record<string, string>;
};
type Row = {
  id: string;
  created_at: number;
  metadata: string;
  revision: number;
  updated_at: number;
  deleted_at: number | null;
  last_sequence: number;
  message_count: number;
  mutation_id: string;
  messages_json: string;
};
const columns = `id,created_at,metadata,revision,updated_at,deleted_at,last_sequence,mutation_id,
  (SELECT COUNT(*) FROM server_conversation_messages
   WHERE user_id=server_conversations.user_id AND conversation_id=server_conversations.id) AS message_count,
  (SELECT json_group_array(CASE WHEN kind='camera_observation'
    THEN json_object('id',id,'role',role,'content',content,'createdAt',created_at,'kind',kind)
    ELSE json_object('id',id,'role',role,'content',content,'createdAt',created_at) END)
   FROM (SELECT id,role,content,created_at,kind FROM server_conversation_messages
     WHERE user_id=server_conversations.user_id AND conversation_id=server_conversations.id ORDER BY position,id)) AS messages_json`;
const windowColumns = `id,created_at,metadata,revision,updated_at,deleted_at,last_sequence,mutation_id,
  (SELECT COUNT(*) FROM server_conversation_messages
   WHERE user_id=server_conversations.user_id AND conversation_id=server_conversations.id) AS message_count,
  (SELECT json_group_array(CASE WHEN kind='camera_observation'
    THEN json_object('id',id,'role',role,'content',content,'createdAt',created_at,'kind',kind)
    ELSE json_object('id',id,'role',role,'content',content,'createdAt',created_at) END)
   FROM (SELECT id,role,content,created_at,kind FROM
     (SELECT id,role,content,created_at,kind,sequence FROM server_conversation_messages
      WHERE user_id=server_conversations.user_id AND conversation_id=server_conversations.id
      ORDER BY sequence DESC LIMIT 20) ORDER BY sequence ASC)) AS messages_json`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Minute maintenance removes abandoned draft text without adding it to history. */
export async function expireStagedVideoReplies(env: SessionEnv, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE video_reply_staging SET state='cancelled',source_message_id=NULL,
       content=NULL,updated_at=? WHERE state='pending' AND updated_at<?`,
  )
    .bind(now, now - 10 * 60_000)
    .run();
}

function sanitize(value: unknown, id: string): PublicSession {
  if (
    !record(value) ||
    value.id !== id ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 10_000
  )
    throw new Error('会话格式无效');
  const seen = new Set<string>();
  const messages = value.messages.map((raw): Message => {
    if (
      !record(raw) ||
      typeof raw.id !== 'string' ||
      !ID.test(raw.id) ||
      seen.has(raw.id) ||
      !['system', 'user', 'assistant'].includes(String(raw.role)) ||
      (raw.kind !== undefined && raw.kind !== 'camera_observation') ||
      typeof raw.content !== 'string' ||
      raw.content.length > 100_000 ||
      !timestamp(raw.createdAt)
    )
      throw new Error('消息格式或编号无效');
    seen.add(raw.id);
    return {
      id: raw.id,
      role: String(raw.role),
      content: raw.content,
      createdAt: raw.createdAt,
      ...(raw.kind === 'camera_observation' ? { kind: 'camera_observation' as const } : {}),
    };
  });
  const metadata: Record<string, string> = {};
  if (record(value.metadata)) {
    if (
      typeof value.metadata.promptPresetId === 'string' &&
      value.metadata.promptPresetId.length <= 200
    )
      metadata.promptPresetId = value.metadata.promptPresetId;
    if (typeof value.metadata.sessionTitle === 'string')
      metadata.sessionTitle = value.metadata.sessionTitle.slice(0, 200);
    if (
      typeof value.metadata.relationshipId === 'string' &&
      /^[A-Za-z0-9_-]{1,80}$/.test(value.metadata.relationshipId)
    )
      metadata.relationshipId = value.metadata.relationshipId;
    // A scene changes the environment, never the character relationship.
    // The empty string explicitly clears a previously selected scene because
    // partial session updates preserve omitted metadata keys.
    if (
      typeof value.metadata.sceneId === 'string' &&
      /^[A-Za-z0-9._:-]{0,200}$/.test(value.metadata.sceneId)
    )
      metadata.sceneId = value.metadata.sceneId;
  }
  return { id, createdAt: value.createdAt, updatedAt: value.updatedAt, messages, metadata };
}
function item(row: Row) {
  // Metadata, revision and messages are read by one SQLite statement/snapshot.
  return {
    id: row.id,
    revision: row.revision,
    lastSequence: row.last_sequence,
    messageCount: row.message_count,
    updatedAt: row.updated_at,
    deleted: row.deleted_at !== null,
    session:
      row.deleted_at === null
        ? {
            id: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            messages: JSON.parse(row.messages_json) as Message[],
            metadata: JSON.parse(row.metadata) as Record<string, string>,
          }
        : null,
  };
}

// Every message write is guarded by a unique successful CAS token. D1 executes
// batch atomically: a rejected CAS cannot partially append or rewrite messages.
function messageStatements(
  env: SessionEnv,
  userId: string,
  session: PublicSession,
  token: string,
  previous: Message[] = [],
) {
  const existing = new Map(previous.map((message) => [message.id, message.content]));
  const changed = session.messages
    .map((message, position) => ({ ...message, position }))
    .filter((message) => existing.get(message.id) !== message.content);
  // One SQL statement regardless of conversation length, avoiding a D1 query
  // per historical message. json_each is SQLite's table-valued JSON primitive.
  return [
    env.DB.prepare(
      `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
    SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.role'),json_extract(value,'$.content'),json_extract(value,'$.createdAt'),json_extract(value,'$.position')
    FROM json_each(?) WHERE EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND mutation_id=? AND deleted_at IS NULL)
    ON CONFLICT(user_id,conversation_id,id) DO UPDATE SET content=excluded.content`,
    ).bind(userId, session.id, JSON.stringify(changed), userId, session.id, token),
  ];
}

async function importLegacy(env: SessionEnv, userId: string, onlyId?: string) {
  const rows = await env.DB.prepare(
    `SELECT a.id,a.payload,a.updated_at,a.deleted_at FROM agent_sessions a
    WHERE a.user_id = ? ${onlyId ? 'AND a.id = ?' : ''} AND NOT EXISTS(SELECT 1 FROM server_conversations c WHERE c.user_id=a.user_id AND c.id=a.id)`,
  )
    .bind(userId, ...(onlyId ? [onlyId] : []))
    .all<{ id: string; payload: string; updated_at: number; deleted_at: number | null }>();
  const errors: { id: string; error: string }[] = [];
  for (const legacy of rows.results) {
    let session: PublicSession;
    try {
      if (!ID.test(legacy.id)) throw new Error('id');
      session =
        legacy.deleted_at === null
          ? sanitize(JSON.parse(legacy.payload), legacy.id)
          : {
              id: legacy.id,
              createdAt: legacy.updated_at,
              updatedAt: legacy.updated_at,
              messages: [],
              metadata: {},
            };
    } catch {
      errors.push({ id: legacy.id, error: '历史会话格式需要修复，原始数据仍保留' });
      continue;
    }
    const token = `legacy:${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,deleted_at,mutation_id) VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(user_id,id) DO NOTHING`,
      ).bind(
        userId,
        legacy.id,
        session.createdAt,
        JSON.stringify(session.metadata),
        legacy.updated_at,
        legacy.deleted_at,
        token,
      ),
      ...messageStatements(env, userId, session, token),
      env.DB.prepare(
        'UPDATE server_conversations SET mutation_id=? WHERE user_id=? AND id=? AND mutation_id=?',
      ).bind(crypto.randomUUID(), userId, legacy.id, token),
    ]);
  }
  return errors;
}

/** Authenticated public dialogue only: never restores device state, grants or tool execution. */
export async function handleServerConversations(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH && !url.pathname.startsWith(`${PATH}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id)
    return err('账号已切换，请重新打开会话', 403, headers);
  if (url.pathname === `${PATH}/search`) {
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query.length < 2 || query.length > 100) return err('搜索词长度无效', 400, headers);
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const matches = await env.DB.prepare(
      `SELECT conversation.id FROM server_conversations conversation
       WHERE conversation.user_id=? AND conversation.deleted_at IS NULL AND
         (json_extract(conversation.metadata,'$.sessionTitle') LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR EXISTS (SELECT 1 FROM server_conversation_messages message
            WHERE message.user_id=conversation.user_id AND message.conversation_id=conversation.id
              AND message.content LIKE ? ESCAPE '\\' COLLATE NOCASE))
       ORDER BY conversation.updated_at DESC,conversation.id ASC LIMIT 50`,
    )
      .bind(user.id, pattern, pattern)
      .all<{ id: string }>();
    return json({ ids: matches.results.map((row) => row.id) }, 200, headers);
  }
  if (url.pathname === PATH) {
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return err('分页大小无效', 400, headers);
    const recent =
      url.searchParams.get('summary') === '1' && url.searchParams.get('order') === 'recent';
    let cursor: [number, string] = recent ? [Number.MAX_SAFE_INTEGER, ''] : [0, ''];
    try {
      const input: unknown = url.searchParams.has('cursor')
        ? JSON.parse(url.searchParams.get('cursor')!)
        : cursor;
      if (
        !Array.isArray(input) ||
        input.length !== 2 ||
        !timestamp(input[0]) ||
        typeof input[1] !== 'string' ||
        (input[1] !== '' && !ID.test(input[1]))
      )
        throw new Error('cursor');
      cursor = input as [number, string];
    } catch {
      return err('分页游标无效', 400, headers);
    }
    const migrationErrors = await importLegacy(env, user.id);
    if (url.searchParams.get('summary') === '1') {
      const summaries = await env.DB.prepare(
        `SELECT id,created_at,metadata,revision,updated_at,deleted_at,last_sequence,read_sequence,last_message_at,
        CASE WHEN read_sequence IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM server_conversation_messages WHERE user_id=server_conversations.user_id AND conversation_id=server_conversations.id AND role='assistant' AND sequence>read_sequence) END AS unread,
        (SELECT CASE attachment.kind WHEN 'image' THEN '[图片]' WHEN 'voice' THEN '[语音]'
          ELSE substr(message.content,1,160) END
          FROM server_conversation_messages message
          LEFT JOIN private_conversation_attachments attachment ON attachment.user_id=message.user_id
            AND attachment.conversation_id=message.conversation_id AND attachment.message_id=message.id
          WHERE message.user_id=server_conversations.user_id AND message.conversation_id=server_conversations.id
            AND message.role IN ('user','assistant') ORDER BY message.sequence DESC LIMIT 1) AS preview
        ,EXISTS(SELECT 1 FROM server_conversation_messages message
          WHERE message.user_id=server_conversations.user_id AND message.conversation_id=server_conversations.id
            AND message.role='user') AS has_user_message
        FROM server_conversations WHERE user_id = ? AND ${recent ? 'deleted_at IS NULL AND (COALESCE(last_message_at,0) < ? OR (COALESCE(last_message_at,0) = ? AND id > ?))' : '(updated_at > ? OR (updated_at = ? AND id > ?))'}
        ORDER BY ${recent ? 'COALESCE(last_message_at,0) DESC' : 'updated_at ASC'},id ASC LIMIT ?`,
      )
        .bind(user.id, cursor[0], cursor[0], cursor[1], limit + 1)
        .all<
          Omit<Row, 'messages_json' | 'mutation_id'> & {
            preview: string | null;
            has_user_message: number;
            last_sequence: number;
            read_sequence: number | null;
            last_message_at: number | null;
            unread: number | null;
          }
        >();
      const page = summaries.results.slice(0, limit);
      const last = page.at(-1);
      return json(
        {
          items: page.map((row) => ({
            id: row.id,
            revision: row.revision,
            lastSequence: row.last_sequence,
            readSequence: row.read_sequence,
            lastMessageAt: row.deleted_at === null ? row.last_message_at : null,
            unread: row.deleted_at === null ? row.unread : null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            deleted: row.deleted_at !== null,
            metadata: row.deleted_at === null ? JSON.parse(row.metadata) : {},
            preview: row.deleted_at === null ? (row.preview ?? '') : '',
            hasUserMessage: row.deleted_at === null && row.has_user_message !== 0,
          })),
          migrationErrors,
          nextCursor:
            summaries.results.length > limit && last
              ? JSON.stringify([recent ? (last.last_message_at ?? 0) : last.updated_at, last.id])
              : null,
        },
        200,
        headers,
      );
    }
    const rows = await env.DB.prepare(
      `SELECT ${columns} FROM server_conversations WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at ASC,id ASC LIMIT ?`,
    )
      .bind(user.id, cursor[0], cursor[0], cursor[1], limit + 1)
      .all<Row>();
    const page = rows.results.slice(0, limit);
    const last = page.at(-1);
    return json(
      {
        items: page.map(item),
        migrationErrors,
        nextCursor:
          rows.results.length > limit && last ? JSON.stringify([last.updated_at, last.id]) : null,
      },
      200,
      headers,
    );
  }
  const readRequest = url.pathname.endsWith('/read');
  const observationRequest = url.pathname.endsWith('/observations');
  const videoReplyRequest = url.pathname.endsWith('/video-replies');
  const messagesRequest = url.pathname.endsWith('/messages');
  const relationshipRequest = url.pathname.endsWith('/relationship');
  const metadataRequest = url.pathname.endsWith('/metadata');
  let id: string;
  try {
    id = decodeURIComponent(
      url.pathname.slice(
        PATH.length + 1,
        readRequest
          ? -5
          : observationRequest
            ? -13
            : videoReplyRequest
              ? -'/video-replies'.length
              : messagesRequest
                ? -9
                : relationshipRequest
                  ? -13
                  : metadataRequest
                    ? -9
                    : undefined,
      ),
    );
  } catch {
    return err('会话编号无效', 400, headers);
  }
  if (!ID.test(id)) return err('会话编号无效', 400, headers);
  const migrationErrors = await importLegacy(env, user.id, id);
  if (migrationErrors.length) return err(migrationErrors[0]!.error, 422, headers);
  if (metadataRequest) {
    if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
    if (account !== user.id) return err('需要账号标识', 403, headers);
    const bytes = await readBodyBounded(request, 2048);
    let expectedRevision: number;
    let changes: Record<string, unknown>;
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes ?? new ArrayBuffer(0)));
      if (
        !record(body) ||
        Object.keys(body).sort().join(',') !== 'changes,expectedRevision' ||
        !timestamp(body.expectedRevision) ||
        !record(body.changes) ||
        Object.keys(body.changes).length < 1 ||
        Object.keys(body.changes).some((key) => !['sessionTitle', 'sceneId'].includes(key)) ||
        ('sessionTitle' in body.changes &&
          body.changes.sessionTitle !== null &&
          (typeof body.changes.sessionTitle !== 'string' ||
            body.changes.sessionTitle.length > 200)) ||
        ('sceneId' in body.changes &&
          body.changes.sceneId !== null &&
          (typeof body.changes.sceneId !== 'string' ||
            !/^[A-Za-z0-9._:-]{0,200}$/.test(body.changes.sceneId)))
      )
        throw new Error();
      expectedRevision = body.expectedRevision;
      changes = body.changes;
    } catch {
      return err('会话资料变更无效', 400, headers);
    }
    const existing = await env.DB.prepare(
      `SELECT metadata,revision,deleted_at FROM server_conversations WHERE user_id=? AND id=?`,
    )
      .bind(user.id, id)
      .first<{
        metadata: string;
        revision: number;
        deleted_at: number | null;
      }>();
    if (!existing || existing.deleted_at !== null) return err('会话不存在或已删除', 404, headers);
    if (existing.revision !== expectedRevision)
      return json({ error: '会话已变更，请重新读取', revision: existing.revision }, 409, headers);
    const metadata = JSON.parse(existing.metadata) as Record<string, string>;
    if ('sessionTitle' in changes) {
      if (changes.sessionTitle === null || changes.sessionTitle === '')
        delete metadata.sessionTitle;
      else metadata.sessionTitle = changes.sessionTitle as string;
    }
    if ('sceneId' in changes)
      metadata.sceneId = changes.sceneId === null ? '' : (changes.sceneId as string);
    if (JSON.stringify(metadata) !== existing.metadata) {
      const token = crypto.randomUUID();
      await env.DB.prepare(
        `UPDATE server_conversations SET metadata=?,revision=revision+1,
         updated_at=MAX(updated_at+1,?),mutation_id=?
         WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
      )
        .bind(JSON.stringify(metadata), Date.now(), token, user.id, id, expectedRevision)
        .run();
      const saved = await env.DB.prepare(
        `SELECT revision,metadata,updated_at,mutation_id FROM server_conversations WHERE user_id=? AND id=?`,
      )
        .bind(user.id, id)
        .first<{
          revision: number;
          metadata: string;
          updated_at: number;
          mutation_id: string;
        }>();
      if (saved?.mutation_id !== token)
        return json(
          { error: '会话已变更，请重新读取', revision: saved?.revision ?? 0 },
          409,
          headers,
        );
      return json(
        {
          revision: saved.revision,
          updatedAt: saved.updated_at,
          metadata: JSON.parse(saved.metadata),
        },
        200,
        headers,
      );
    }
    const unchanged = await env.DB.prepare(
      `SELECT revision,metadata,updated_at,deleted_at FROM server_conversations WHERE user_id=? AND id=?`,
    )
      .bind(user.id, id)
      .first<{
        revision: number;
        metadata: string;
        updated_at: number;
        deleted_at: number | null;
      }>();
    const actual = unchanged ? (JSON.parse(unchanged.metadata) as Record<string, string>) : null;
    if (unchanged && unchanged.revision !== expectedRevision)
      return json({ error: '会话已变更，请重新读取', revision: unchanged.revision }, 409, headers);
    if (
      actual &&
      Object.entries(changes).some(([key, value]) =>
        key === 'sessionTitle'
          ? value === null || value === ''
            ? actual.sessionTitle !== undefined
            : actual.sessionTitle !== value
          : actual.sceneId !== (value ?? ''),
      )
    )
      return json(
        { error: '会话已变更，请重新读取', revision: unchanged?.revision ?? 0 },
        409,
        headers,
      );
    return unchanged && unchanged.deleted_at === null
      ? json(
          {
            revision: unchanged.revision,
            updatedAt: unchanged.updated_at,
            metadata: actual,
          },
          200,
          headers,
        )
      : err('会话不存在或已删除', 404, headers);
  }
  if (relationshipRequest) {
    if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
    if (account !== user.id) return err('需要账号标识', 403, headers);
    const bytes = await readBodyBounded(request, 1024);
    let expectedRevision: number;
    let relationshipId: string;
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes ?? new ArrayBuffer(0)));
      if (
        !record(body) ||
        Object.keys(body).sort().join(',') !== 'expectedRevision,relationshipId' ||
        !timestamp(body.expectedRevision) ||
        typeof body.relationshipId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(body.relationshipId)
      )
        throw new Error();
      expectedRevision = body.expectedRevision;
      relationshipId = body.relationshipId;
    } catch {
      return err('关系绑定无效', 400, headers);
    }
    const token = crypto.randomUUID();
    await env.DB.prepare(
      `UPDATE server_conversations SET metadata=json_set(metadata,'$.relationshipId',?),
         revision=revision+1,updated_at=MAX(updated_at+1,?),mutation_id=?
       WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL
         AND (json_extract(metadata,'$.relationshipId') IS NULL
           OR json_extract(metadata,'$.relationshipId')=?)
         AND EXISTS(SELECT 1 FROM character_relationships r
           WHERE r.user_id=? AND r.id=? AND r.deleted_at IS NULL
             AND r.character_id=json_extract(server_conversations.metadata,'$.promptPresetId'))`,
    )
      .bind(
        relationshipId,
        Date.now(),
        token,
        user.id,
        id,
        expectedRevision,
        relationshipId,
        user.id,
        relationshipId,
      )
      .run();
    const saved = await env.DB.prepare(
      `SELECT ${windowColumns} FROM server_conversations WHERE user_id=? AND id=?`,
    )
      .bind(user.id, id)
      .first<Row>();
    if (!saved || saved.deleted_at !== null) return err('会话不存在或已删除', 404, headers);
    if (saved.mutation_id !== token)
      return json({ error: '会话或关系已变更', revision: saved.revision }, 409, headers);
    return json(item(saved), 200, headers);
  }
  if (messagesRequest) {
    if (request.method === 'POST') {
      if (account !== user.id) return err('需要账号标识', 403, headers);
      const bytes = await readBodyBounded(request, 256_000);
      if (!bytes) return err('消息批次过大', 413, headers);
      let expectedRevision: number;
      let additions: Message[];
      try {
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (
          !record(body) ||
          Object.keys(body).sort().join(',') !== 'expectedRevision,messages' ||
          !timestamp(body.expectedRevision) ||
          !Array.isArray(body.messages) ||
          body.messages.length < 1 ||
          body.messages.length > 20
        )
          throw new Error();
        expectedRevision = body.expectedRevision;
        const ids = new Set<string>();
        additions = body.messages.map((raw): Message => {
          if (
            !record(raw) ||
            Object.keys(raw).sort().join(',') !== 'content,createdAt,id,role' ||
            typeof raw.id !== 'string' ||
            !ID.test(raw.id) ||
            ids.has(raw.id) ||
            !['user', 'assistant'].includes(String(raw.role)) ||
            typeof raw.content !== 'string' ||
            raw.content.length > 100_000 ||
            !timestamp(raw.createdAt)
          )
            throw new Error();
          ids.add(raw.id);
          return {
            id: raw.id,
            role: String(raw.role),
            content: raw.content,
            createdAt: raw.createdAt,
          };
        });
      } catch {
        return err('消息批次无效', 400, headers);
      }
      const owner = await env.DB.prepare(
        `SELECT revision,updated_at,deleted_at,last_sequence FROM server_conversations
         WHERE user_id=? AND id=?`,
      )
        .bind(user.id, id)
        .first<{
          revision: number;
          updated_at: number;
          deleted_at: number | null;
          last_sequence: number;
        }>();
      if (!owner || owner.deleted_at !== null) return err('会话不存在或已删除', 404, headers);
      const existing = await env.DB.prepare(
        `SELECT id,role,content,created_at,kind FROM server_conversation_messages
         WHERE user_id=? AND conversation_id=? AND id IN (SELECT value FROM json_each(?))`,
      )
        .bind(user.id, id, JSON.stringify(additions.map((message) => message.id)))
        .all<{
          id: string;
          role: string;
          content: string;
          created_at: number;
          kind: string | null;
        }>();
      const byId = new Map(existing.results.map((message) => [message.id, message]));
      if (
        additions.some((message) => {
          const old = byId.get(message.id);
          return (
            old &&
            (old.role !== message.role ||
              (old.content !== message.content &&
                !(old.role === 'assistant' && message.content.startsWith(old.content))) ||
              old.created_at !== message.createdAt ||
              old.kind !== 'message')
          );
        })
      )
        return err('消息编号冲突', 409, headers);
      const missing = additions.filter((message) => !byId.has(message.id));
      const extended = additions.filter((message) => {
        const old = byId.get(message.id);
        return old && old.content !== message.content;
      });
      if (!missing.length && !extended.length)
        return json(
          {
            revision: owner.revision,
            lastSequence: owner.last_sequence,
            added: 0,
            extended: 0,
          },
          200,
          headers,
        );
      if (owner.revision !== expectedRevision)
        return json({ error: '会话已变更，请重新读取', revision: owner.revision }, 409, headers);
      const token = crypto.randomUUID();
      const now = Math.max(Date.now(), owner.updated_at + 1);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE server_conversations SET revision=revision+1,updated_at=?,mutation_id=?
           WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
        ).bind(now, token, user.id, id, expectedRevision),
        ...extended.map((message) =>
          env.DB.prepare(
            `UPDATE server_conversation_messages SET content=?
           WHERE user_id=? AND conversation_id=? AND id=? AND role='assistant'
             AND kind='message' AND content=?
             AND EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=?
               AND mutation_id=? AND deleted_at IS NULL)`,
          ).bind(
            message.content,
            user.id,
            id,
            message.id,
            byId.get(message.id)!.content,
            user.id,
            id,
            token,
          ),
        ),
        env.DB.prepare(
          `INSERT INTO server_conversation_messages
           (user_id,conversation_id,id,role,content,created_at,position)
           SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.role'),
             json_extract(value,'$.content'),json_extract(value,'$.createdAt'),
             (SELECT COALESCE(MAX(position),-1) FROM server_conversation_messages
              WHERE user_id=? AND conversation_id=?) + CAST(json_each.key AS INTEGER) + 1
           FROM json_each(?) WHERE EXISTS(SELECT 1 FROM server_conversations
             WHERE user_id=? AND id=? AND mutation_id=? AND deleted_at IS NULL)
           ON CONFLICT(user_id,conversation_id,id) DO NOTHING`,
        ).bind(user.id, id, user.id, id, JSON.stringify(missing), user.id, id, token),
      ]);
      const saved = await env.DB.prepare(
        `SELECT revision,last_sequence,mutation_id FROM server_conversations WHERE user_id=? AND id=?`,
      )
        .bind(user.id, id)
        .first<{
          revision: number;
          last_sequence: number;
          mutation_id: string;
        }>();
      if (saved?.mutation_id !== token)
        return json(
          { error: '会话已变更，请重新读取', revision: saved?.revision ?? 0 },
          409,
          headers,
        );
      return json(
        {
          revision: saved.revision,
          lastSequence: saved.last_sequence,
          added: missing.length,
          extended: extended.length,
        },
        200,
        headers,
      );
    }
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !Number.isSafeInteger(before) ||
      before < 1
    )
      return err('消息分页条件无效', 400, headers);
    const owner = await env.DB.prepare(
      `SELECT revision,last_sequence,
        (SELECT COUNT(*) FROM server_conversation_messages WHERE user_id=? AND conversation_id=?) AS message_count
       FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL`,
    )
      .bind(user.id, id, user.id, id)
      .first<{
        revision: number;
        last_sequence: number;
        message_count: number;
      }>();
    if (!owner) return err('会话不存在或已删除', 404, headers);
    const rows = await env.DB.prepare(
      `SELECT id,role,content,created_at,kind,sequence FROM server_conversation_messages
       WHERE user_id=? AND conversation_id=? AND sequence<?
       ORDER BY sequence DESC LIMIT ?`,
    )
      .bind(user.id, id, before, limit + 1)
      .all<{
        id: string;
        role: string;
        content: string;
        created_at: number;
        kind: string | null;
        sequence: number;
      }>();
    const page = rows.results.slice(0, limit);
    const latest = await env.DB.prepare(
      `SELECT revision,last_sequence,
        (SELECT COUNT(*) FROM server_conversation_messages WHERE user_id=? AND conversation_id=?) AS message_count
       FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL`,
    )
      .bind(user.id, id, user.id, id)
      .first<typeof owner>();
    if (
      !latest ||
      latest.revision !== owner.revision ||
      latest.last_sequence !== owner.last_sequence ||
      latest.message_count !== owner.message_count
    )
      return err('会话正在更新，请重新读取消息', 409, headers);
    return json(
      {
        items: page.reverse().map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.created_at,
          sequence: message.sequence,
          ...(message.kind === 'camera_observation' ? { kind: 'camera_observation' } : {}),
        })),
        nextBefore: rows.results.length > limit ? (page[0]?.sequence ?? null) : null,
        revision: owner.revision,
        lastSequence: owner.last_sequence,
        messageCount: owner.message_count,
      },
      200,
      headers,
    );
  }
  if (videoReplyRequest) {
    if (!['POST', 'PUT', 'DELETE'].includes(request.method))
      return err('不支持此操作', 405, headers);
    if (account !== user.id) return err('需要账号标识', 403, headers);
    const bytes = await readBodyBounded(request, 16_384);
    let replyId: string;
    let sourceMessageId = '';
    let content = '';
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes ?? new ArrayBuffer(0)));
      if (
        !record(body) ||
        Object.keys(body).sort().join(',') !==
          (request.method === 'POST' ? 'content,id,sourceMessageId' : 'id') ||
        typeof body.id !== 'string' ||
        !/^video-reply-[a-f0-9-]{36}$/.test(body.id) ||
        (request.method === 'POST' &&
          (typeof body.sourceMessageId !== 'string' ||
            !ID.test(body.sourceMessageId) ||
            typeof body.content !== 'string' ||
            !body.content.trim() ||
            body.content.length > 10_000))
      )
        throw new Error();
      replyId = body.id;
      if (request.method === 'POST') {
        sourceMessageId = body.sourceMessageId as string;
        content = (body.content as string).trim();
      }
    } catch {
      return err('视频回复无效', 400, headers);
    }
    const owner = await env.DB.prepare(
      `SELECT id FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL
       AND json_extract(metadata,'$.promptPresetId') IS NOT NULL`,
    )
      .bind(user.id, id)
      .first();
    if (!owner) return err('会话不存在或已删除', 404, headers);
    const now = Date.now();
    // Abandoned staged text never becomes a hidden permanent transcript entry.
    await expireStagedVideoReplies(env, now);
    if (request.method === 'POST') {
      const source = await env.DB.prepare(
        `SELECT 1 FROM server_conversation_messages WHERE user_id=? AND conversation_id=?
         AND id=? AND role='user' AND kind='message'`,
      )
        .bind(user.id, id, sourceMessageId)
        .first();
      if (!source) return err('原始提问尚未保存', 409, headers);
      const conflict = await env.DB.prepare(
        `SELECT 1 FROM server_conversation_messages WHERE user_id=? AND conversation_id=? AND id=?`,
      )
        .bind(user.id, id, replyId)
        .first();
      if (conflict) return err('回复编号已占用', 409, headers);
      await env.DB.prepare(
        `INSERT INTO video_reply_staging
         (user_id,conversation_id,reply_id,source_message_id,content,state,created_at,updated_at)
         VALUES (?,?,?,?,?,'pending',?,?)
         ON CONFLICT(user_id,conversation_id,reply_id) DO NOTHING`,
      )
        .bind(user.id, id, replyId, sourceMessageId, content, now, now)
        .run();
      const staged = await env.DB.prepare(
        `SELECT state,source_message_id,content FROM video_reply_staging
         WHERE user_id=? AND conversation_id=? AND reply_id=?`,
      )
        .bind(user.id, id, replyId)
        .first<{
          state: string;
          source_message_id: string | null;
          content: string | null;
        }>();
      if (
        staged?.state !== 'pending' ||
        staged.source_message_id !== sourceMessageId ||
        staged.content !== content
      )
        return err('回复编号已取消或冲突', 409, headers);
      return json({ staged: true }, 200, headers);
    }
    if (request.method === 'DELETE') {
      await env.DB.prepare(
        `INSERT INTO video_reply_staging
         (user_id,conversation_id,reply_id,source_message_id,content,state,created_at,updated_at)
         VALUES (?,?,?,NULL,NULL,'cancelled',?,?)
         ON CONFLICT(user_id,conversation_id,reply_id) DO UPDATE SET
           state='cancelled',source_message_id=NULL,content=NULL,updated_at=excluded.updated_at
         WHERE video_reply_staging.state='pending'`,
      )
        .bind(user.id, id, replyId, now, now)
        .run();
      const state = await env.DB.prepare(
        `SELECT state FROM video_reply_staging WHERE user_id=? AND conversation_id=? AND reply_id=?`,
      )
        .bind(user.id, id, replyId)
        .first<{ state: string }>();
      if (state?.state !== 'cancelled')
        return err('回复已提交，请检查服务器聊天记录', 409, headers);
      return json({ cancelled: true }, 200, headers);
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO server_conversation_messages
         (user_id,conversation_id,id,role,content,created_at,position)
         SELECT s.user_id,s.conversation_id,s.reply_id,'assistant',s.content,?,
           COALESCE((SELECT MAX(position)+1 FROM server_conversation_messages
             WHERE user_id=s.user_id AND conversation_id=s.conversation_id),0)
         FROM video_reply_staging s WHERE s.user_id=? AND s.conversation_id=? AND s.reply_id=?
           AND s.state='pending' AND s.updated_at>=?
           AND EXISTS(SELECT 1 FROM server_conversation_messages source
             WHERE source.user_id=s.user_id AND source.conversation_id=s.conversation_id
               AND source.id=s.source_message_id AND source.role='user' AND source.kind='message')
           AND EXISTS(SELECT 1 FROM server_conversations owner
             WHERE owner.user_id=s.user_id AND owner.id=s.conversation_id AND owner.deleted_at IS NULL)
         ON CONFLICT(user_id,conversation_id,id) DO NOTHING`,
      ).bind(now, user.id, id, replyId, now - 10 * 60_000),
      env.DB.prepare(
        `UPDATE video_reply_staging SET state='committed',content=NULL,updated_at=?
         WHERE user_id=? AND conversation_id=? AND reply_id=? AND state='pending'
           AND EXISTS(SELECT 1 FROM server_conversation_messages message
             WHERE message.user_id=? AND message.conversation_id=? AND message.id=?
               AND message.role='assistant' AND message.kind='message'
               AND message.content=video_reply_staging.content)`,
      ).bind(now, user.id, id, replyId, user.id, id, replyId),
    ]);
    const state = await env.DB.prepare(
      `SELECT state FROM video_reply_staging WHERE user_id=? AND conversation_id=? AND reply_id=?`,
    )
      .bind(user.id, id, replyId)
      .first<{ state: string }>();
    if (state?.state !== 'committed') return err('回复已取消、过期或编号冲突', 409, headers);
    const saved = await env.DB.prepare(
      `SELECT ${windowColumns} FROM server_conversations WHERE user_id=? AND id=?`,
    )
      .bind(user.id, id)
      .first<Row>();
    if (!saved || saved.deleted_at !== null) return err('会话不存在或已删除', 404, headers);
    return json(item(saved), 200, headers);
  }
  if (observationRequest) {
    if (!['POST', 'DELETE'].includes(request.method)) return err('不支持此操作', 405, headers);
    if (account !== user.id) return err('需要账号标识', 403, headers);
    const bytes = await readBodyBounded(request, 16_384);
    let observationId: string;
    let content = '';
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes ?? new ArrayBuffer(0)));
      if (
        !record(body) ||
        Object.keys(body).sort().join(',') !==
          (request.method === 'DELETE' ? 'id' : 'content,id') ||
        typeof body.id !== 'string' ||
        !ID.test(body.id) ||
        (request.method === 'POST' &&
          (typeof body.content !== 'string' ||
            !body.content.trim() ||
            body.content.length > 10_000))
      )
        throw new Error();
      observationId = body.id;
      if (request.method === 'POST') content = (body.content as string).trim();
    } catch {
      return err('观察事件无效', 400, headers);
    }
    if (request.method === 'DELETE') {
      const owner = await env.DB.prepare(
        `SELECT id FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL
         AND json_extract(metadata,'$.promptPresetId') IS NOT NULL`,
      )
        .bind(user.id, id)
        .first();
      if (!owner) return err('会话不存在或已删除', 404, headers);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO camera_observation_cancellations
           (user_id,conversation_id,observation_id,cancelled_at)
           VALUES (?,?,?,?) ON CONFLICT(user_id,conversation_id,observation_id) DO NOTHING`,
        ).bind(user.id, id, observationId, Date.now()),
        env.DB.prepare(
          `DELETE FROM server_conversation_messages WHERE user_id=? AND conversation_id=?
           AND id=? AND kind='camera_observation'`,
        ).bind(user.id, id, observationId),
      ]);
      return json({ cancelled: true }, 200, headers);
    }
    const cancelled = await env.DB.prepare(
      `SELECT 1 FROM camera_observation_cancellations
       WHERE user_id=? AND conversation_id=? AND observation_id=?`,
    )
      .bind(user.id, id, observationId)
      .first();
    if (cancelled) return err('观察已取消', 409, headers);
    const existing = await env.DB.prepare(
      `SELECT role,content,kind FROM server_conversation_messages
       WHERE user_id=? AND conversation_id=? AND id=?`,
    )
      .bind(user.id, id, observationId)
      .first<{ role: string; content: string; kind: string }>();
    if (existing) {
      if (existing.kind !== 'camera_observation' || existing.content !== content)
        return err('观察编号冲突', 409, headers);
    } else {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position,kind)
         SELECT ?,?,?,'assistant',?,?,COALESCE((SELECT MAX(position)+1 FROM server_conversation_messages
           WHERE user_id=? AND conversation_id=?),0),'camera_observation'
         WHERE EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL
           AND json_extract(metadata,'$.promptPresetId') IS NOT NULL)
           AND NOT EXISTS(SELECT 1 FROM camera_observation_cancellations
             WHERE user_id=? AND conversation_id=? AND observation_id=?)
         ON CONFLICT(user_id,conversation_id,id) DO NOTHING`,
      )
        .bind(
          user.id,
          id,
          observationId,
          content,
          now,
          user.id,
          id,
          user.id,
          id,
          user.id,
          id,
          observationId,
        )
        .run();
    }
    const saved = await env.DB.prepare(
      `SELECT ${url.searchParams.get('window') === '20' ? windowColumns : columns} FROM server_conversations WHERE user_id=? AND id=?`,
    )
      .bind(user.id, id)
      .first<Row>();
    if (!saved || saved.deleted_at !== null) return err('会话不存在或已删除', 404, headers);
    const confirmed = await env.DB.prepare(
      `SELECT 1 FROM server_conversation_messages WHERE user_id=? AND conversation_id=?
       AND id=? AND kind='camera_observation' AND content=?`,
    )
      .bind(user.id, id, observationId, content)
      .first();
    if (!confirmed) return err('观察编号冲突或会话不可用', 409, headers);
    return json(item(saved), 200, headers);
  }
  if (readRequest) {
    if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
    if (account !== user.id) return err('需要账号标识', 403, headers);
    const bytes = await readBodyBounded(request, 1024);
    let sequence: number;
    try {
      const body = JSON.parse(bytes ? new TextDecoder().decode(bytes) : '');
      if (Object.keys(body).length !== 1 || !timestamp(body.sequence)) throw new Error();
      sequence = body.sequence;
    } catch {
      return err('已读序号无效', 400, headers);
    }
    const saved = await env.DB.prepare(
      `UPDATE server_conversations
      SET read_sequence=MAX(COALESCE(read_sequence,0),?)
      WHERE user_id=? AND id=? AND deleted_at IS NULL AND last_sequence>=?
      RETURNING last_sequence,read_sequence`,
    )
      .bind(sequence, user.id, id, sequence)
      .first<{ last_sequence: number; read_sequence: number }>();
    if (!saved) return err('会话不存在、已删除或序号超出范围', 409, headers);
    return json(
      { lastSequence: saved.last_sequence, readSequence: saved.read_sequence },
      200,
      headers,
    );
  }
  const row = await env.DB.prepare(
    `SELECT ${request.method === 'GET' && url.searchParams.get('window') === '20' ? windowColumns : columns} FROM server_conversations WHERE user_id = ? AND id = ?`,
  )
    .bind(user.id, id)
    .first<Row>();
  if (request.method === 'GET') {
    if (!row) return err('会话不存在', 404, headers);
    return json(item(row), row.deleted_at === null ? 200 : 410, headers);
  }
  if (!['PUT', 'DELETE'].includes(request.method)) return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, MAX_BYTES);
  if (!bytes) return err('会话过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(parsed)) throw new Error();
    body = parsed;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  const expected = body.expectedRevision;
  if (!timestamp(expected)) return err('需要有效的 expectedRevision', 400, headers);
  if (
    Object.keys(body).some(
      (key) =>
        !['expectedRevision', ...(request.method === 'PUT' ? ['session'] : [])].includes(key),
    )
  )
    return err('包含不支持的字段', 400, headers);
  const conflict = () =>
    json({ error: '会话已变更或删除，请重新读取', revision: row?.revision ?? 0 }, 409, headers);
  if (row?.deleted_at != null || (row?.revision ?? 0) !== expected) return conflict();
  const now = Math.max(Date.now(), (row?.updated_at ?? 0) + 1);
  const token = crypto.randomUUID();
  if (request.method === 'DELETE') {
    if (!row) return err('会话不存在', 404, headers);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE server_conversations SET metadata='{}',revision=revision+1,updated_at=?,deleted_at=?,mutation_id=? WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
      ).bind(now, now, token, user.id, id, expected),
      env.DB.prepare(
        `DELETE FROM server_conversation_messages WHERE user_id=? AND conversation_id=? AND EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND mutation_id=?)`,
      ).bind(user.id, id, user.id, id, token),
    ]);
  } else {
    let incoming: PublicSession;
    try {
      incoming = sanitize(body.session, id);
    } catch (error) {
      return err(String(error), 400, headers);
    }
    const previousMetadata = row ? item(row).session!.metadata : {};
    // The character and private-relationship binding is set once, exactly like the
    // `/relationship` endpoint. A stale or forged full save must not move a transcript to
    // another character or attach pre-deletion history to a recreated relationship.
    for (const key of ['promptPresetId', 'relationshipId'] as const) {
      const before = previousMetadata[key];
      const after = incoming.metadata[key];
      if (typeof before === 'string' && before && after !== undefined && after !== before)
        return json({ error: '会话角色绑定不可更改', revision: row?.revision ?? 0 }, 409, headers);
    }
    const relationshipId = incoming.metadata.relationshipId;
    if (relationshipId && relationshipId !== previousMetadata.relationshipId) {
      const characterId = previousMetadata.promptPresetId || incoming.metadata.promptPresetId;
      const relationship = await env.DB.prepare(
        'SELECT id FROM character_relationships WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND character_id = ?',
      )
        .bind(user.id, relationshipId, characterId ?? null)
        .first();
      if (!relationship) return err('私人角色关系不存在', 400, headers);
    }
    let previousMessages: Message[] = [];
    if (row) {
      const previous = item(row).session!;
      previousMessages = previous.messages;
      const messages = new Map(previous.messages.map((message) => [message.id, message]));
      for (const message of incoming.messages) {
        const old = messages.get(message.id);
        if (
          old &&
          ((old.kind !== message.kind &&
            !(old.kind === 'camera_observation' && message.kind === undefined)) ||
            old.role !== message.role ||
            old.createdAt !== message.createdAt ||
            (old.content !== message.content &&
              (old.kind === 'camera_observation' ||
                !(old.role === 'assistant' && message.content.startsWith(old.content)))))
        )
          return err('已有消息不可改写；助手流式内容只能追加', 409, headers);
        messages.set(message.id, old?.kind === 'camera_observation' ? old : message);
      }
      if (
        incoming.messages.some(
          (message) =>
            message.kind === 'camera_observation' &&
            !previousMessages.some(
              (old) => old.id === message.id && old.kind === 'camera_observation',
            ),
        )
      )
        return err('摄像头观察只能通过观察事件接口创建', 400, headers);
      incoming = {
        ...incoming,
        createdAt: previous.createdAt,
        messages: [...messages.values()],
        metadata: { ...previous.metadata, ...incoming.metadata },
      };
    }
    if (!row && incoming.messages.some((message) => message.kind === 'camera_observation'))
      return err('摄像头观察只能通过观察事件接口创建', 400, headers);
    incoming.updatedAt = now;
    if (
      incoming.messages.length > 10_000 ||
      new TextEncoder().encode(JSON.stringify(incoming)).length > MAX_BYTES
    )
      return err('会话过大', 413, headers);
    await env.DB.batch([
      row
        ? env.DB.prepare(
            `UPDATE server_conversations SET metadata=?,revision=revision+1,updated_at=?,mutation_id=? WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
          ).bind(JSON.stringify(incoming.metadata), now, token, user.id, id, expected)
        : env.DB.prepare(
            `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES (?,?,?,?,1,?,?) ON CONFLICT(user_id,id) DO NOTHING`,
          ).bind(user.id, id, incoming.createdAt, JSON.stringify(incoming.metadata), now, token),
      ...messageStatements(env, user.id, incoming, token, previousMessages),
    ]);
  }
  const saved = await env.DB.prepare(
    `SELECT ${columns} FROM server_conversations WHERE user_id=? AND id=?`,
  )
    .bind(user.id, id)
    .first<Row>();
  return saved?.mutation_id === token
    ? json(item(saved), request.method === 'PUT' && !row ? 201 : 200, headers)
    : conflict();
}
