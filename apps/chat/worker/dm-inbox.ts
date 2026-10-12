import { authorizeDmUpgrade, authorizeDmToken, DM_DIGEST_MAX_ROOMS, isDmRoomCode } from './dm';
import type { RoomDO } from './room-do';
export async function handleDmInbox(
  request: Request,
  env: { DM_TICKET_SECRET: string; ROOM: DurableObjectNamespace<RoomDO> },
): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
    Vary: 'X-Account-Id',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  const text = await request.text();
  if (text.length > 65536) return json({ error: '请求过大' }, 413);
  let body: { ticket?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: '无效请求' }, 400);
  }
  if (!body || typeof body !== 'object' || typeof body.ticket !== 'string')
    return json({ error: '缺少会话凭据' }, 401);
  const auth = await authorizeDmToken({
    secret: env.DM_TICKET_SECRET,
    token: body.ticket,
    audience: 'digest',
    now: Date.now(),
  });
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  if (request.headers.get('X-Account-Id') !== auth.claims.sub)
    return json({ error: '账户不匹配' }, 403);
  const rooms = [...new Set(auth.claims.rooms ?? [])]
    .filter(isDmRoomCode)
    .slice(0, DM_DIGEST_MAX_ROOMS);
  const summaries = await Promise.all(
    rooms.map((room) =>
      env.ROOM.get(env.ROOM.idFromName(room)).dmInboxSummary(
        room,
        auth.claims.iat,
        auth.claims.sub,
      ),
    ),
  );
  return json({
    accountId: auth.claims.sub,
    conversations: summaries.filter((item) => item !== null),
  });
}

export async function handleDmRead(
  request: Request,
  env: Parameters<typeof handleDmInbox>[1],
): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };
  const result = (ok: boolean, status: number) =>
    new Response(JSON.stringify({ ok }), { status, headers });
  const text = await request.text();
  if (text.length > 65536) return result(false, 413);
  let body: { ticket?: unknown; sequence?: unknown; messageId?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return result(false, 400);
  }
  if (
    !body ||
    typeof body.ticket !== 'string' ||
    !(
      (Number.isSafeInteger(body.sequence) &&
        Number(body.sequence) >= 0 &&
        body.messageId === undefined) ||
      (body.sequence === undefined &&
        typeof body.messageId === 'string' &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(body.messageId))
    )
  )
    return result(false, 400);
  const auth = await authorizeDmUpgrade({
    secret: env.DM_TICKET_SECRET,
    ticket: body.ticket,
    now: Date.now(),
  });
  if (!auth.ok) return result(false, auth.status);
  if (request.headers.get('X-Account-Id') !== auth.self) return result(false, 403);
  const ok = await env.ROOM.get(env.ROOM.idFromName(auth.code)).dmMarkRead(
    auth.code,
    auth.iat,
    auth.self,
    typeof body.messageId === 'string' ? body.messageId : Number(body.sequence),
  );
  return result(ok, ok ? 200 : 409);
}
