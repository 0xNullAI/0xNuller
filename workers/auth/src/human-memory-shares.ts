import { DM_TICKET_TTL_MS, dmRoomCode, signDmTicket } from './dm-ticket';
import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';

type ChatKind = 'dm' | 'group';
type ShareEnv = SessionEnv & { CHAT: Fetcher; DM_TICKET_SECRET: string };
type Target = { kind: ChatKind; id: string; key: string; membershipVersion: number | null };
const BASE = '/api/auth/human-memory';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MEMORY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const GROUP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIVED_PAGE_SIZE = 50;

interface ShareRow {
  owner_id: string;
  memory_id: string;
  version: number;
  enabled: number;
  updated_at: number;
  membership_version: number | null;
}

async function dmAllowed(env: ShareEnv, account: string, peer: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM dm_threads t JOIN users u ON u.id=t.peer_id
     WHERE t.user_id=? AND t.peer_id=? AND u.banned_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=t.peer_id)
       AND EXISTS(SELECT 1 FROM user_follows f WHERE f.follower_id=t.user_id AND f.followee_id=t.peer_id)
       AND EXISTS(SELECT 1 FROM user_follows f WHERE f.follower_id=t.peer_id AND f.followee_id=t.user_id)
       AND NOT EXISTS(SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id=t.user_id AND b.blocked_id=t.peer_id)
            OR (b.blocker_id=t.peer_id AND b.blocked_id=t.user_id))`,
  )
    .bind(account, peer)
    .first();
  return !!row;
}

/** Chat's Durable Object, not an Auth bookmark, owns durable group membership. */
async function activeGroups(
  env: ShareEnv,
  account: string,
  rooms: string[],
): Promise<Map<string, number>> {
  if (!rooms.length) return new Map();
  if (!env.CHAT || !env.DM_TICKET_SECRET) throw new Error('Chat membership unavailable');
  const active = new Map<string, number>();
  for (let start = 0; start < rooms.length; start += 50) {
    const batch = rooms.slice(start, start + 50);
    const now = Date.now();
    const ticket = await signDmTicket(env.DM_TICKET_SECRET, {
      aud: 'chat',
      sub: account,
      iat: now,
      exp: now + DM_TICKET_TTL_MS,
    });
    const response = await env.CHAT.fetch('https://chat.internal/api/groups/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
      body: JSON.stringify({ ticket, rooms: batch }),
    });
    if (!response.ok) throw new Error('Chat membership unavailable');
    const data = (await response.json()) as {
      accountId?: string;
      conversations?: { room: string; membershipVersion: number }[];
    };
    if (
      data.accountId !== account ||
      !Array.isArray(data.conversations) ||
      data.conversations.some(
        (entry) =>
          !batch.includes(entry.room) ||
          !Number.isSafeInteger(entry.membershipVersion) ||
          entry.membershipVersion < 1,
      )
    )
      throw new Error('Chat membership response invalid');
    for (const entry of data.conversations) active.set(entry.room, entry.membershipVersion);
  }
  return active;
}

async function targetOf(
  env: ShareEnv,
  account: string,
  kind: string | null,
  id: string | null,
): Promise<Target | null> {
  if (kind === 'dm' && id && ID.test(id) && id !== account) {
    if (!(await dmAllowed(env, account, id))) return null;
    return {
      kind,
      id,
      key: await dmRoomCode(env.DM_TICKET_SECRET, account, id),
      membershipVersion: null,
    };
  }
  if (kind === 'group' && id && GROUP_ID.test(id)) {
    const membershipVersion = (await activeGroups(env, account, [id])).get(id);
    if (!membershipVersion) return null;
    return { kind, id, key: id, membershipVersion };
  }
  return null;
}

function shareView(row: ShareRow, target: Target) {
  return {
    memoryId: row.memory_id,
    enabled:
      row.enabled === 1 &&
      (target.kind === 'dm' || row.membership_version === target.membershipVersion),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export async function handleHumanMemoryShares(
  request: Request,
  env: ShareEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'private, no-store', Vary: 'X-Account-Id' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (!user.email_verified_at) return err('请先验证邮箱后使用 Chat', 403, headers);
  if (user.banned_at !== null || request.headers.get('X-Account-Id') !== user.id)
    return err('账号不可用或已切换', 403, headers);
  if (!env.DM_TICKET_SECRET) return err('聊天暂不可用', 503, headers);

  if (url.pathname === `${BASE}/conversations` && request.method === 'GET') {
    const dmOffset = url.searchParams.has('dmOffset')
      ? Number(url.searchParams.get('dmOffset'))
      : 0;
    const groupOffset = url.searchParams.has('groupOffset')
      ? Number(url.searchParams.get('groupOffset'))
      : 0;
    if (
      ![dmOffset, groupOffset].every(
        (value) => Number.isSafeInteger(value) && value >= -1 && value <= 100_000,
      )
    )
      return err('分页参数无效', 400, headers);
    const [dms, groups] = await Promise.all([
      dmOffset === -1
        ? Promise.resolve({ results: [] as { id: string; name: string }[] })
        : env.DB.prepare(
            `SELECT t.peer_id AS id,u.display_name AS name FROM dm_threads t
          JOIN users u ON u.id=t.peer_id WHERE t.user_id=?
          ORDER BY t.started_at DESC,t.peer_id DESC LIMIT 51 OFFSET ?`,
          )
            .bind(user.id, dmOffset)
            .all<{ id: string; name: string }>(),
      groupOffset === -1
        ? Promise.resolve({ results: [] as { id: string; name: string }[] })
        : env.DB.prepare(
            `SELECT code AS id,name FROM user_chat_rooms WHERE user_id=?
          ORDER BY updated_at DESC,code DESC LIMIT 101 OFFSET ?`,
          )
            .bind(user.id, groupOffset)
            .all<{ id: string; name: string }>(),
    ]);
    const validDms = await Promise.all(
      dms.results
        .slice(0, 50)
        .map(async (row) =>
          (await dmAllowed(env, user.id, row.id)) ? { kind: 'dm' as const, ...row } : null,
        ),
    );
    const rooms = groups.results.slice(0, 100).filter((row) => GROUP_ID.test(row.id));
    const active = await activeGroups(
      env,
      user.id,
      rooms.map((row) => row.id),
    );
    const nextDmOffset = dms.results.length > 50 ? dmOffset + 50 : null;
    const nextGroupOffset = groups.results.length > 100 ? groupOffset + 100 : null;
    return json(
      {
        conversations: [
          ...validDms.filter((row) => row !== null),
          ...rooms.filter((row) => active.has(row.id)).map((row) => ({ kind: 'group', ...row })),
        ],
        next:
          nextDmOffset !== null || nextGroupOffset !== null
            ? { dmOffset: nextDmOffset, groupOffset: nextGroupOffset }
            : null,
      },
      200,
      headers,
    );
  }

  const kind = url.searchParams.get('kind');
  const id = url.searchParams.get('id');
  let target: Target | null;
  try {
    target = await targetOf(env, user.id, kind, id);
  } catch {
    return err('群成员资格暂不可验证', 503, headers);
  }
  if (!target) return err('聊天不可访问', 403, headers);

  if (url.pathname === `${BASE}/shares` && request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT owner_id,memory_id,enabled,version,updated_at,membership_version
      FROM human_memory_shares WHERE owner_id=? AND chat_kind=? AND chat_key=?`,
    )
      .bind(user.id, target.kind, target.key)
      .all<ShareRow>();
    return json({ shares: rows.results.map((row) => shareView(row, target)) }, 200, headers);
  }

  if (url.pathname === `${BASE}/received` && request.method === 'GET') {
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      return err('分页参数无效', 400, headers);
    const rows = await env.DB.prepare(
      `SELECT s.owner_id,s.membership_version,
      u.display_name AS owner_name,m.id,m.kind,m.title,m.content,m.version,
      m.updated_at AS memory_updated_at
      FROM human_memory_shares s JOIN personal_memories m
        ON m.user_id=s.owner_id AND m.id=s.memory_id
      JOIN users u ON u.id=s.owner_id
      WHERE s.chat_kind=? AND s.chat_key=? AND s.enabled=1
        AND s.owner_id<>? AND m.scope='account' AND m.relationship_id IS NULL
        AND m.state='active' AND m.deleted_at IS NULL AND m.superseded_by_id IS NULL
        AND (m.expires_at IS NULL OR m.expires_at>?)
        AND u.banned_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=s.owner_id)
        AND NOT EXISTS(SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id=s.owner_id AND b.blocked_id=?)
             OR (b.blocker_id=? AND b.blocked_id=s.owner_id))
      ORDER BY s.updated_at DESC,s.owner_id DESC,s.memory_id DESC LIMIT 51 OFFSET ?`,
    )
      .bind(target.kind, target.key, user.id, Date.now(), user.id, user.id, offset)
      .all<{
        owner_id: string;
        owner_name: string;
        membership_version: number | null;
        id: string;
        kind: string;
        title: string;
        content: string;
        version: number;
        memory_updated_at: number;
      }>();
    const page = rows.results.slice(0, RECEIVED_PAGE_SIZE);
    const owners = [...new Set(page.map((row) => row.owner_id))];
    let visibleRows: typeof page;
    if (target.kind === 'dm') {
      visibleRows = page.filter((row) => row.owner_id === target.id);
    } else {
      try {
        const verdicts = await Promise.all(
          owners.map(async (owner) => ({
            owner,
            active: (await activeGroups(env, owner, [target.key])).get(target.key),
          })),
        );
        const versions = new Map(verdicts.map((item) => [item.owner, item.active]));
        visibleRows = page.filter((row) => versions.get(row.owner_id) === row.membership_version);
      } catch {
        return err('群成员资格暂不可验证', 503, headers);
      }
    }
    const items = visibleRows.map((row) => ({
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      memory: {
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        version: row.version,
        updatedAt: row.memory_updated_at,
      },
    }));
    return json(
      {
        items,
        nextOffset: rows.results.length > RECEIVED_PAGE_SIZE ? offset + RECEIVED_PAGE_SIZE : null,
      },
      200,
      headers,
    );
  }

  const match = /^\/api\/auth\/human-memory\/shares\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
  if (!match || request.method !== 'PUT') return err('不支持此操作', 405, headers);
  const memoryId = match[1]!;
  if (!MEMORY_ID.test(memoryId)) return err('记忆编号无效', 400, headers);
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
    Object.keys(body).some((key) => !['enabled', 'version', 'memoryVersion'].includes(key)) ||
    typeof body.enabled !== 'boolean' ||
    !Number.isSafeInteger(body.version) ||
    Number(body.version) < 0 ||
    !Number.isSafeInteger(body.memoryVersion) ||
    Number(body.memoryVersion) < 1
  )
    return err('共享设置无效', 400, headers);
  const now = Date.now();
  const liveMemory = `EXISTS(SELECT 1 FROM personal_memories m WHERE m.user_id=? AND m.id=?
    AND m.version=? AND m.scope='account' AND m.relationship_id IS NULL
    AND m.state='active' AND m.deleted_at IS NULL AND m.superseded_by_id IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>?))`;
  const row =
    body.version === 0
      ? await env.DB.prepare(
          `INSERT INTO human_memory_shares
        (owner_id,chat_kind,chat_key,dm_peer_id,membership_version,memory_id,enabled,version,updated_at)
        SELECT ?,?,?,?,?,?, ?,1,? WHERE ${liveMemory}
        ON CONFLICT DO NOTHING RETURNING owner_id,memory_id,enabled,version,updated_at,membership_version`,
        )
          .bind(
            user.id,
            target.kind,
            target.key,
            target.kind === 'dm' ? target.id : null,
            target.membershipVersion,
            memoryId,
            body.enabled ? 1 : 0,
            now,
            user.id,
            memoryId,
            body.memoryVersion,
            now,
          )
          .first<ShareRow>()
      : await env.DB.prepare(
          `UPDATE human_memory_shares SET enabled=?,membership_version=?,version=version+1,updated_at=?
        WHERE owner_id=? AND chat_kind=? AND chat_key=? AND memory_id=? AND version=?
          AND (?=0 OR ${liveMemory})
        RETURNING owner_id,memory_id,enabled,version,updated_at,membership_version`,
        )
          .bind(
            body.enabled ? 1 : 0,
            target.membershipVersion,
            now,
            user.id,
            target.kind,
            target.key,
            memoryId,
            body.version,
            body.enabled ? 1 : 0,
            user.id,
            memoryId,
            body.memoryVersion,
            now,
          )
          .first<ShareRow>();
  if (!row) return err('记忆或共享设置已变更，请刷新后重试', 409, headers);
  return json({ share: shareView(row, target) }, 200, headers);
}
