import { DM_TICKET_TTL_MS, dmRoomCode, signDmTicket } from './dm-ticket';

export interface AccountChatDeletionEnv {
  DB: D1Database;
  CHAT: Fetcher;
  DM_TICKET_SECRET: string;
}

const GROUP_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REGISTRY_PAGES_PER_RUN = 50;

async function sendChat(
  env: AccountChatDeletionEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!env.CHAT || !env.DM_TICKET_SECRET) throw new Error('Chat 撤销服务尚未配置');
  const response = await env.CHAT.fetch(`https://chat.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Chat 撤销失败：${response.status}`);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Chat 撤销回执无效');
  return data;
}

/**
 * The account_deletions row remains the durable retry marker until every Chat room
 * acknowledges revocation. Never cascade away dm_threads or saved group hints first.
 */
export async function revokeAccountChat(
  env: AccountChatDeletionEnv,
  userId: string,
): Promise<void> {
  if (!env.CHAT || !env.DM_TICKET_SECRET) throw new Error('Chat 撤销服务尚未配置');
  const deletion = await env.DB.prepare(
    'SELECT requested_at FROM account_deletions WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ requested_at: number }>();
  if (!deletion) throw new Error('缺少账号删除任务');
  const deletionId = `${userId}:${deletion.requested_at}`;
  const token = () => {
    const now = Date.now();
    return signDmTicket(env.DM_TICKET_SECRET, {
      aud: 'chat-account-delete',
      sub: userId,
      deletionId,
      iat: now,
      exp: now + DM_TICKET_TTL_MS,
    });
  };
  const pendingRooms = async (): Promise<string[]> => {
    const data = await sendChat(env, '/api/groups/account-deletion', { token: await token() });
    if (
      data.accountId !== userId ||
      data.deletionId !== deletionId ||
      data.tombstoned !== true ||
      data.coverage !== 'registered-and-observed' ||
      data.legacyCoverage !== 'unknown' ||
      !Array.isArray(data.rooms) ||
      data.rooms.length > 100 ||
      (data.nextCursor !== null &&
        (typeof data.nextCursor !== 'string' || !GROUP_CODE.test(data.nextCursor))) ||
      (data.rooms.length === 0 && data.nextCursor !== null) ||
      data.rooms.some((room) => typeof room !== 'string' || !GROUP_CODE.test(room))
    )
      throw new Error('Chat 账号撤销回执无效');
    return data.rooms as string[];
  };
  const revokeRoom = async (room: string): Promise<void> => {
    const data = await sendChat(env, '/api/groups/account-deletion/room', {
      token: await token(),
      room,
    });
    if (data.accountId !== userId || data.room !== room || data.revoked !== true)
      throw new Error('Chat 群成员撤销回执无效');
  };

  // Tombstone first: once it is durable in Chat, even a previously minted group
  // ticket cannot create a new membership while the old rooms are being revoked.
  let rooms = await pendingRooms();

  // Auth's old saved-room list is only a compatibility hint. It cannot prove
  // complete membership, but reaches some rooms created before the new index.
  const saved = await env.DB.prepare(
    'SELECT code FROM user_chat_rooms WHERE user_id = ? ORDER BY code',
  )
    .bind(userId)
    .all<{ code: string }>();
  for (const row of saved.results ?? []) {
    if (!GROUP_CODE.test(row.code)) continue;
    await revokeRoom(row.code);
  }

  for (let page = 0; rooms.length > 0; page++) {
    if (page >= MAX_REGISTRY_PAGES_PER_RUN) throw new Error('Chat 撤销尚未完成，等待下一次重试');
    for (const room of rooms) await revokeRoom(room);
    rooms = await pendingRooms();
  }

  const threads = await env.DB.prepare(
    'SELECT peer_id FROM dm_threads WHERE user_id = ? ORDER BY peer_id',
  )
    .bind(userId)
    .all<{ peer_id: string }>();
  for (const thread of threads.results ?? []) {
    const now = Date.now();
    const revoke = await signDmTicket(env.DM_TICKET_SECRET, {
      aud: 'revoke',
      sub: userId,
      room: await dmRoomCode(env.DM_TICKET_SECRET, userId, thread.peer_id),
      iat: now,
      exp: now + DM_TICKET_TTL_MS,
    });
    const data = await sendChat(env, '/api/dm/revoke', { token: revoke });
    if (data.ok !== true) throw new Error('Chat 私聊撤销回执无效');
  }
}
