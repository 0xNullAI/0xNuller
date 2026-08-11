// Chat API entry point: room/DM WebSockets, lobby state and R2 media.
import { RoomDO } from './room-do';
import { LobbyDO } from './lobby-do';
import { handleMediaUpload, handleMediaRead } from './media';
import { LOBBY_NAME } from './wire';
import {
  DM_DIGEST_MAX_ROOMS,
  authorizeDmToken,
  authorizeDmUpgrade,
  isDmRoomCode,
  roomPathAllowsCode,
  type DmSummary,
} from './dm';

export interface Env extends Cloudflare.Env {
  /**
   * Shared with the account service, which mints the DM tickets this Worker verifies.
   *
   * Deployment configuration requires this secret so a release cannot silently ship with
   * direct messages disabled. The verifier still rejects a missing value at runtime as a
   * second fail-closed boundary.
   * **Never rotate it**: the conversation id is keyed with it, so a new value moves every
   * conversation to a different Durable Object and orphans all DM history.
   */
  DM_TICKET_SECRET: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/api/upload/') && request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'PUT,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,X-Media-Token',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Room WebSocket: /ws/room/:code -> the matching RoomDO instance.
    const roomMatch = pathname.match(/^\/ws\/room\/([^/]+)$/);
    if (roomMatch) {
      const code = decodeURIComponent(roomMatch[1]!);
      // A DM's Durable Object must not be reachable here. This path takes its code straight
      // from the URL and asks for no credential at all, so without this check the ticket on
      // /ws/dm would be decoration: anyone able to name a conversation could join it.
      if (!roomPathAllowsCode(code)) return new Response('not found', { status: 404 });
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // Pass the room code through to the DO (idFromName is not reversible, and the DO needs it for the R2 prefix / lobby reporting).
      const fwd = new URL(request.url);
      fwd.searchParams.set('code', code);
      return stub.fetch(new Request(fwd, request));
    }

    // DM WebSocket: /ws/dm?ticket=…
    //
    // The conversation id is **never supplied by the client**; it is read out of the signed
    // ticket, which the account service only mints for two accounts that follow each other.
    // So the mutual-follow check happens server-side, before this socket is allowed anywhere
    // near the Durable Object — not in the UI, and not by asking the client who it is.
    if (pathname === '/ws/dm') {
      const auth = await authorizeDmUpgrade({
        secret: env.DM_TICKET_SECRET,
        ticket: url.searchParams.get('ticket'),
        now: Date.now(),
      });
      if (!auth.ok) return new Response(auth.message, { status: auth.status });
      const stub = env.ROOM.get(env.ROOM.idFromName(auth.code));
      const fwd = new URL(request.url);
      // The DO has no use for the ticket and no business holding one.
      fwd.searchParams.delete('ticket');
      fwd.searchParams.set('code', auth.code);
      // When the ticket was minted, so the conversation can refuse anything issued before it
      // was revoked. See dmTicketRevoked.
      fwd.searchParams.set('iat', String(auth.iat));
      return stub.fetch(new Request(fwd, request));
    }

    // Unread counts for the sidebar: one signed ticket covering the conversations the caller
    // is party to, one fan-out over their Durable Objects. Bounded by the ticket, which the
    // account service caps — a client cannot ask about a conversation it was not listed for.
    if (pathname === '/api/dm/digest' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        ticket?: string;
        since?: Record<string, number>;
      };
      const auth = await authorizeDmToken({
        secret: env.DM_TICKET_SECRET,
        token: body.ticket ?? null,
        audience: 'digest',
        now: Date.now(),
      });
      if (!auth.ok) return json(auth.status, { error: auth.message });
      const rooms = (auth.claims.rooms ?? []).filter(isDmRoomCode).slice(0, DM_DIGEST_MAX_ROOMS);
      const since = body.since ?? {};
      const conversations: DmSummary[] = await Promise.all(
        rooms.map((room) =>
          env.ROOM.get(env.ROOM.idFromName(room)).dmSummary(room, Number(since[room]) || 0),
        ),
      );
      return json(200, { conversations });
    }

    // Internal: the account service tells a conversation that it has been severed.
    //
    // Reachable from the internet (the zone route is a prefix match and workers.dev is on), so
    // it carries its own signed token rather than trusting the caller's identity — a service
    // binding authenticates the hop, not the request, and this endpoint has to be safe either way.
    if (pathname === '/api/dm/revoke' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { token?: string };
      const auth = await authorizeDmToken({
        secret: env.DM_TICKET_SECRET,
        token: body.token ?? null,
        audience: 'revoke',
        now: Date.now(),
      });
      if (!auth.ok) return json(auth.status, { error: auth.message });
      const room = auth.claims.room;
      if (!room || !isDmRoomCode(room)) return json(400, { error: 'invalid room' });
      await env.ROOM.get(env.ROOM.idFromName(room)).dmRevoke(Date.now());
      return json(200, { ok: true });
    }

    // Lobby WebSocket + REST snapshot -> the singleton LobbyDO.
    if (pathname === '/ws/lobby' || pathname === '/api/lobby/rooms') {
      const id = env.LOBBY.idFromName(LOBBY_NAME);
      return env.LOBBY.get(id).fetch(request);
    }

    // Media upload: PUT /api/upload/:code
    const uploadMatch = pathname.match(/^\/api\/upload\/([^/]+)$/);
    if (uploadMatch && request.method === 'PUT') {
      return handleMediaUpload(request, env, decodeURIComponent(uploadMatch[1]!));
    }

    // Media read-back: GET /api/media/:code/:id
    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)\/([^/]+)$/);
    if (mediaMatch && request.method === 'GET') {
      return handleMediaRead(
        env,
        decodeURIComponent(mediaMatch[1]!),
        decodeURIComponent(mediaMatch[2]!),
      );
    }

    return new Response('not found', { status: 404 });
  },
};

export { RoomDO, LobbyDO };
