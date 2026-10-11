import { AccountRegistryDO } from './account-registry-do';
import { handleChatBackupExport } from './chat-backup-export';
import { handleChatAccountDeletion } from './account-deletion';
import { handleGroupInbox, handleGroupRead } from './group-inbox';
import { handleDmInbox, handleDmRead } from './dm-inbox';
// Chat API entry point: room/DM WebSockets, lobby state and R2 media.
import { RoomDO } from './room-do';
import { RoomIndexDO } from './room-index-do';
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
  /** Internal managed text service; the browser never receives a group billing ticket. */
  LLM: Fetcher;
  /** Named Auth RPC; no public push-send endpoint exists. */
  AUTH_PUSH: Fetcher & {
    enqueueChatPush(event: {
      kind: 'dm' | 'group';
      targetId: string;
      eventId: string;
      senderAccountId: string;
      recipientAccountIds: string[];
    }): Promise<void>;
  };
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
  /** Independent operator-only backup capability; never issued to app clients. */
  CHAT_BACKUP_TOKEN: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CROSS_ORIGIN_CLIENTS = new Set([
  'https://0xnullai.com',
  'https://www.0xnullai.com',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);

function clientCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get('Origin');
  if (origin && CROSS_ORIGIN_CLIENTS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type,X-Account-Id');
    headers.set('Access-Control-Max-Age', '86400');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/api/groups/backup/')) return handleChatBackupExport(request, env);

    // Auth alone calls this through its existing service binding. The path is outside
    // Chat's public zone routes, so clients cannot probe private group membership.
    if (pathname === '/internal/push/group-eligible' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        room?: unknown;
        account?: unknown;
      } | null;
      if (
        typeof body?.room !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(body.room) ||
        typeof body.account !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(body.account) ||
        isDmRoomCode(body.room)
      )
        return json(400, { error: 'invalid group' });
      const eligible = await env.ROOM.get(env.ROOM.idFromName(body.room)).groupPushEligible(
        body.room,
        body.account,
      );
      return json(200, { eligible });
    }

    if (
      request.method === 'POST' &&
      (pathname === '/api/groups/account-deletion' ||
        pathname === '/api/groups/account-deletion/room')
    )
      return handleChatAccountDeletion(request, env, pathname.endsWith('/room'));
    if (pathname.startsWith('/api/groups/')) {
      const cors = clientCorsHeaders(request);
      cors.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (
        request.method === 'POST' &&
        (pathname === '/api/groups/inbox' || pathname === '/api/groups/read')
      ) {
        const result = await (pathname.endsWith('/inbox')
          ? handleGroupInbox(request, env)
          : handleGroupRead(request, env));
        const headers = new Headers(result.headers);
        cors.forEach((value, key) => headers.set(key, value));
        return new Response(result.body, { status: result.status, headers });
      }
    }
    if (pathname.startsWith('/api/upload/') && request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'PUT,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,X-Media-Token,X-Account-Id',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (pathname === '/api/lobby/rooms' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: clientCorsHeaders(request) });
    }

    // Room WebSocket: /ws/room/:code -> the matching RoomDO instance.
    const roomMatch = pathname.match(/^\/ws\/room\/([^/]+)$/);
    if (roomMatch) {
      const chat = await authorizeDmToken({
        secret: env.DM_TICKET_SECRET,
        token: url.searchParams.get('ticket'),
        audience: 'chat',
        now: Date.now(),
      });
      if (!chat.ok) return new Response(chat.message, { status: chat.status });
      const code = decodeURIComponent(roomMatch[1]!);
      // A DM's Durable Object must not be reachable here. The general Chat ticket proves a
      // verified account, but it deliberately proves no entitlement to a specific DM.
      if (!roomPathAllowsCode(code)) return new Response('not found', { status: 404 });
      if (!env.ACCOUNT_REGISTRY) return json(503, { error: 'account registry unavailable' });
      try {
        if (
          !(
            await env.ACCOUNT_REGISTRY.get(
              env.ACCOUNT_REGISTRY.idFromName(chat.claims.sub),
            ).registerGroup(chat.claims.sub, code)
          ).allowed
        )
          return json(403, { error: 'account revoked' });
      } catch {
        return json(503, { error: 'account registry unavailable' });
      }
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // Pass the room code through to the DO (idFromName is not reversible, and the DO needs it for the R2 prefix / lobby reporting).
      const fwd = new URL(request.url);
      fwd.searchParams.delete('ticket');
      fwd.searchParams.set('code', code);
      const forwarded = new Request(fwd, request);
      forwarded.headers.set('X-Chat-Account', chat.claims.sub);
      forwarded.headers.set('X-Ticket-Expires-At', String(chat.claims.exp));
      return stub.fetch(forwarded);
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
      const forwarded = new Request(fwd, request);
      forwarded.headers.set('X-DM-Account', auth.self);
      forwarded.headers.set('X-DM-Peer-Account', auth.peer);
      forwarded.headers.set('X-Ticket-Expires-At', String(auth.exp));
      return stub.fetch(forwarded);
    }

    // Unread counts for the sidebar: one signed ticket covering the conversations the caller
    // is party to, one fan-out over their Durable Objects. Bounded by the ticket, which the
    // account service caps — a client cannot ask about a conversation it was not listed for.
    if (pathname === '/api/dm/read' && request.method === 'POST') return handleDmRead(request, env);
    if (pathname === '/api/dm/inbox' && request.method === 'POST')
      return handleDmInbox(request, env);

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
    // Reachable from the internet through the zone prefix route, so it carries its own signed
    // token rather than trusting the caller's identity — a service binding authenticates the hop,
    // not the request, and this endpoint has to be safe either way.
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
      const chat = await authorizeDmToken({
        secret: env.DM_TICKET_SECRET,
        token: url.searchParams.get('ticket'),
        audience: 'chat',
        now: Date.now(),
      });
      if (!chat.ok) return json(chat.status, { error: chat.message });
      try {
        if (
          !env.ACCOUNT_REGISTRY ||
          !(await env.ACCOUNT_REGISTRY.get(
            env.ACCOUNT_REGISTRY.idFromName(chat.claims.sub),
          ).isActive(chat.claims.sub))
        )
          return json(403, { error: 'account revoked' });
      } catch {
        return json(503, { error: 'account registry unavailable' });
      }
      url.searchParams.delete('ticket');
      const id = env.LOBBY.idFromName(LOBBY_NAME);
      const response = await env.LOBBY.get(id).fetch(new Request(url, request));
      if (pathname !== '/api/lobby/rooms') return response;
      const headers = new Headers(response.headers);
      clientCorsHeaders(request).forEach((value, key) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
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
        url.searchParams.get('token'),
      );
    }

    return new Response('not found', { status: 404 });
  },
};

export { RoomDO, LobbyDO, AccountRegistryDO, RoomIndexDO };
