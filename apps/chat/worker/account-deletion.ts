import { verifyDmTicket, isDmRoomCode } from '../../../workers/auth/src/dm-ticket';
import type { Env } from './index';
interface Claims {
  aud: string;
  sub: string;
  deletionId: string;
  iat: number;
  exp: number;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
export async function handleChatAccountDeletion(
  request: Request,
  env: Env,
  roomRequest: boolean,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 65536) return json({ error: 'too large' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid request' }, 400);
  }
  if (!body || typeof body.token !== 'string') return json({ error: 'token required' }, 401);
  const claims = (await verifyDmTicket(
    env.DM_TICKET_SECRET,
    body.token,
    Date.now(),
  )) as unknown as Claims | null;
  if (
    !claims ||
    claims.aud !== 'chat-account-delete' ||
    typeof claims.deletionId !== 'string' ||
    !claims.deletionId ||
    claims.deletionId.length > 512
  )
    return json({ error: 'invalid token' }, 403);
  const validRoom = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !isDmRoomCode(value);
  if (
    roomRequest
      ? !validRoom(body.room)
      : body.cursor !== undefined && body.cursor !== '' && !validRoom(body.cursor)
  )
    return json({ error: 'invalid room or cursor' }, 400);
  if (!env.ACCOUNT_REGISTRY) return json({ error: 'account registry unavailable' }, 503);
  try {
    const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName(claims.sub));
    const result = await registry.tombstone(
      claims.sub,
      claims.deletionId,
      typeof body.cursor === 'string' ? body.cursor : '',
    );
    await env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName('all-rooms')).tombstoneAccount(
      claims.sub,
      claims.deletionId,
    );
    if (!roomRequest) return json(result);
    const room = body.room as string;
    await env.ROOM.get(env.ROOM.idFromName(room)).revokeGroupAccount(
      room,
      claims.sub,
      claims.deletionId,
    );
    await registry.acknowledge(claims.sub, claims.deletionId, room);
    return json({ accountId: claims.sub, room, revoked: true });
  } catch {
    return json({ error: 'account revocation pending' }, 503);
  }
}
