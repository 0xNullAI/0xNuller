// RoomDO: one instance per room (idFromName(roomCode)).
// Responsibilities: WebSocket relay (replaces the public MQTT broker) + connection-level presence + chat history (SQLite) persistence and replay
//                   + reporting public rooms to LobbyDO + grace-period cleanup once the room is empty (history + R2 media + lobby deregistration).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { deleteRoomMedia } from './media';
import { LOBBY_NAME, ROOM_GRACE_MS, RESERVED_ROOM_CODE, RESERVED_ROOM_NAME, ROOM_AGENT_SENDER, type WireChat, type RoomAgent } from './wire';

interface Attachment {
  peerId: string;
  name: string;
}

/** Minimum interval (ms) between lobby keepalive reports from a public room. */
const LOBBY_KEEPALIVE_MS = 20 * 1000;

export class RoomDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastLobbyReport = 0;
  // In-memory cache of the room agent (storage is the durable copy; reloaded lazily after hibernation wakes the DO).
  private agentCache: RoomAgent | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id TEXT, name TEXT, body TEXT, ts INTEGER)',
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? '';
    const peerId = url.searchParams.get('id') || crypto.randomUUID();
    await this.ctx.storage.put('code', code);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, name: '' } satisfies Attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    const t = msg.t as string;

    switch (t) {
      case 'hello': {
        att.name = (msg.name as string) ?? '';
        ws.serializeAttachment(att);
        const helloCode = (await this.ctx.storage.get<string>('code')) ?? '';
        const reserved = helloCode === RESERVED_ROOM_CODE;
        if (msg.public || reserved) {
          await this.ctx.storage.put('public', true);
          await this.ctx.storage.put(
            'roomName',
            reserved ? RESERVED_ROOM_NAME : (msg.roomName as string) || att.name || '',
          );
        }
        // Host = the first person to join. The permanent discussion room has no host (pure open chat): don't assign one, and clear any leftover.
        let host = '';
        if (reserved) {
          await this.ctx.storage.delete('hostPeerId');
        } else {
          host = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
          if (!host) {
            host = att.peerId;
            await this.ctx.storage.put('hostPeerId', host);
          }
        }
        // Replay the history to this connection (all earlier messages and media references).
        ws.send(JSON.stringify({ t: 'history', messages: this.loadHistory() }));
        ws.send(JSON.stringify({ t: 'agent', agent: await this.getAgent(), host }));
        // Tell the other members that someone joined.
        this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'chat': {
        // The host may speak as the room agent (checked: sender=host and the room really has an agent).
        const aiAs = await this.aiSenderOk(att.peerId, msg.as);
        const fromId = aiAs ?? att.peerId;
        const chat: WireChat = {
          id: (msg.id as string) ?? crypto.randomUUID(),
          _from: fromId,
          n: (msg.n as string) || att.name,
          x: msg.x as string | undefined,
          m: msg.m as WireChat['m'],
          mentions: msg.mentions as WireChat['mentions'],
          ts: (msg.ts as number) ?? Date.now(),
        };
        this.saveMessage(chat);
        // Normal message: the sender already has an optimistic copy, so exclude it from the broadcast;
        // AI-proxied message: the host has no local copy, so broadcast to everyone (host included).
        this.broadcast({ t: 'chat', ...chat }, aiAs ? undefined : ws);
        return;
      }

      case 'agent': {
        // Host-only. The agent's device commands are authorized as ai:room on
        // the host's authority, so whoever defines it must be the room owner.
        const agentHost = await this.ctx.storage.get<string>('hostPeerId');
        if (att.peerId !== agentHost) return;
        const raw = msg.agent as Record<string, unknown> | null | undefined;
        const next: RoomAgent | null = raw
          ? {
              name: String(raw.name ?? '').slice(0, 40),
              persona: String(raw.persona ?? '').slice(0, 4000),
            }
          : null;
        this.agentCache = next;
        await this.ctx.storage.put('agent', next);
        this.broadcast({ t: 'agent', agent: next, host: agentHost ?? '' });
        return;
      }

      // Legacy roleplay frames from pre-removal clients: drop silently.
      //
      // These two cases must stay here permanently. Android has no hot update,
      // so pre-removal APKs keep talking to this Worker indefinitely, and the
      // default branch below relays anything it does not recognise to the whole
      // room with a trusted _from injected. Deleting these cases would hand the
      // old clients a working peer-to-peer roleplay channel through the relay —
      // with the host-only checks that used to guard it gone.
      case 'scene':
      case 'role':
        return;

      case 'cmd':
      case 'wave': {
        // Forward directly to the target peer. The host may act as the room agent (_from = ai:room, which the device side uses for authorization checks).
        const aiAs = await this.aiSenderOk(att.peerId, msg.as);
        this.sendTo(msg.to as string, { ...msg, _from: aiAs ?? att.peerId });
        return;
      }

      case 'leave': {
        this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
        return;
      }

      default: {
        // sf / ss / presence: broadcast to the rest of the room, injecting a trusted _from.
        this.broadcast({ ...msg, _from: att.peerId }, ws);
        // Piggyback the presence heartbeat as the lobby keepalive (throttled), so a room with people in it never gets expired away.
        if (t === 'presence') {
          const now = Date.now();
          if (now - this.lastLobbyReport >= LOBBY_KEEPALIVE_MS) {
            this.lastLobbyReport = now;
            await this.reportLobby(this.ctx.getWebSockets().length);
          }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  async alarm(): Promise<void> {
    // Grace period is up: if still nobody is connected, wipe the room completely. Otherwise someone reconnected, so cancel the cleanup.
    if (this.ctx.getWebSockets().length > 0) return;
    const code = (await this.ctx.storage.get<string>('code')) ?? '';
    // The permanent discussion room is never cleaned up: keep the history, just report it as idle (the lobby keeps it via pinned).
    if (code === RESERVED_ROOM_CODE) {
      await this.reportLobby(0);
      return;
    }
    this.sql.exec('DELETE FROM messages');
    if (code) await deleteRoomMedia(this.env, code);
    await this.reportLobby(0);
    await this.ctx.storage.deleteAll();
  }

  // -- Internals --

  private async onDisconnect(ws: WebSocket): Promise<void> {
    let att: Attachment | undefined;
    try {
      att = ws.deserializeAttachment() as Attachment;
    } catch {
      att = undefined;
    }
    const remaining = this.ctx.getWebSockets().filter(w => w !== ws);
    if (att) {
      this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
    }
    await this.reportLobby(remaining.length);
    if (remaining.length === 0) {
      // Room is empty: keep the history for one grace period; if nobody reconnects within it, the alarm cleans it up.
      await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
    }
  }

  private broadcast(payload: unknown, except?: WebSocket): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* socket gone; ignore */
      }
    }
  }

  private sendTo(toPeerId: string, payload: unknown): void {
    if (!toPeerId) return;
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.peerId === toPeerId) {
        try {
          ws.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private saveMessage(chat: WireChat): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO messages (id, from_id, name, body, ts) VALUES (?, ?, ?, ?, ?)',
      chat.id,
      chat._from ?? '',
      chat.n,
      JSON.stringify({ x: chat.x, m: chat.m, mentions: chat.mentions }),
      chat.ts,
    );
  }

  private loadHistory(): WireChat[] {
    const rows = this.sql
      .exec('SELECT id, from_id, name, body, ts FROM messages ORDER BY ts ASC, id ASC')
      .toArray();
    return rows.map(r => {
      const body = JSON.parse(r.body as string) as {
        x?: string;
        m?: WireChat['m'];
        mentions?: WireChat['mentions'];
      };
      return {
        id: r.id as string,
        _from: r.from_id as string,
        n: r.name as string,
        x: body.x,
        m: body.m,
        mentions: body.mentions,
        ts: r.ts as number,
      };
    });
  }

  private async getAgent(): Promise<RoomAgent | null> {
    if (this.agentCache === undefined) {
      this.agentCache = (await this.ctx.storage.get<RoomAgent>('agent')) ?? null;
    }
    return this.agentCache;
  }

  /**
   * Check whether "the host speaking/acting as the room agent" is legitimate.
   * Returns the agent's sender id when it is, otherwise null.
   * Conditions: `as` is exactly ROOM_AGENT_SENDER, the sender is the host, and the room
   * actually has an agent.
   */
  private async aiSenderOk(senderPeerId: string, as: unknown): Promise<string | null> {
    if (as !== ROOM_AGENT_SENDER) return null;
    const host = await this.ctx.storage.get<string>('hostPeerId');
    if (senderPeerId !== host) return null;
    return (await this.getAgent()) ? ROOM_AGENT_SENDER : null;
  }

  /** Only public rooms report to the lobby; count=0 means the room is empty and gets removed from the lobby. */
  private async reportLobby(count: number): Promise<void> {
    const isPublic = await this.ctx.storage.get<boolean>('public');
    if (!isPublic) return;
    const code = (await this.ctx.storage.get<string>('code')) ?? '';
    const name = (await this.ctx.storage.get<string>('roomName')) ?? '';
    if (!code) return;
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName(LOBBY_NAME));
    await stub.fetch('https://lobby/update', {
      method: 'POST',
      body: JSON.stringify({ code, name, count }),
    });
  }
}
