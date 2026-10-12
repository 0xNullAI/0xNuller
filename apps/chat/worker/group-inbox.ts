import { authorizeDmToken, isDmRoomCode } from './dm';
import { signDmTicket, DM_TICKET_TTL_MS } from '../../../workers/auth/src/dm-ticket';
import type { RoomDO } from './room-do';
type Env = { DM_TICKET_SECRET: string; ROOM: DurableObjectNamespace<RoomDO> };
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      Vary: 'X-Account-Id',
    },
  });
async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > 65536) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
const validRoom = (room: unknown): room is string =>
  typeof room === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(room) && !isDmRoomCode(room);
export async function handleGroupInbox(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request);
  if (
    !body ||
    typeof body.ticket !== 'string' ||
    !Array.isArray(body.rooms) ||
    body.rooms.length > 50 ||
    !body.rooms.every(validRoom)
  )
    return response({ error: '请求无效' }, 400);
  const auth = await authorizeDmToken({
    secret: env.DM_TICKET_SECRET,
    token: body.ticket,
    audience: 'chat',
    now: Date.now(),
  });
  if (!auth.ok) return response({ error: auth.message }, auth.status);
  if (request.headers.get('X-Account-Id') !== auth.claims.sub)
    return response({ error: '账号不匹配' }, 403);
  const conversations = await Promise.all(
    [...new Set(body.rooms as string[])].map(async (room) => {
      const summary = await env.ROOM.get(env.ROOM.idFromName(room)).groupInboxSummary(
        room,
        auth.claims.sub,
      );
      if (!summary) return null;
      const now = Date.now();
      const readTicket = await signDmTicket(env.DM_TICKET_SECRET, {
        aud: 'group-read',
        sub: auth.claims.sub,
        room,
        membershipVersion: summary.membershipVersion,
        iat: now,
        exp: now + DM_TICKET_TTL_MS,
      });
      return { ...summary, readTicket };
    }),
  );
  return response({ accountId: auth.claims.sub, conversations: conversations.filter(Boolean) });
}
export async function handleGroupRead(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request);
  if (!body || typeof body.ticket !== 'string') return response({ ok: false }, 400);
  const value = body.messageId ?? body.sequence;
  if (
    (body.messageId !== undefined && body.sequence !== undefined) ||
    !(typeof value === 'string'
      ? /^[A-Za-z0-9._:-]{1,128}$/.test(value)
      : Number.isSafeInteger(value) && Number(value) >= 0)
  )
    return response({ ok: false }, 400);
  const auth = await authorizeDmToken({
    secret: env.DM_TICKET_SECRET,
    token: body.ticket,
    audience: 'group-read',
    now: Date.now(),
  });
  if (!auth.ok) return response({ ok: false }, auth.status);
  const { room, sub, membershipVersion } = auth.claims;
  if (
    request.headers.get('X-Account-Id') !== sub ||
    !validRoom(room) ||
    !Number.isSafeInteger(membershipVersion) ||
    Number(membershipVersion) < 1
  )
    return response({ ok: false }, 403);
  const ok = await env.ROOM.get(env.ROOM.idFromName(room)).groupMarkRead(
    room,
    sub,
    membershipVersion!,
    value as number | string,
  );
  return response({ ok }, ok ? 200 : 409);
}
