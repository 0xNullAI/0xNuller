// RoomDO: one instance per room (idFromName(roomCode)).
// Responsibilities: WebSocket relay (replaces the public MQTT broker) + connection-level presence + chat history (SQLite) persistence and replay
//                   + reporting public rooms to LobbyDO + grace-period cleanup once the room is empty (history + R2 media + lobby deregistration).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { deleteRoomMedia } from './media';
import { LOBBY_NAME, ROOM_GRACE_MS, RESERVED_ROOM_CODE, RESERVED_ROOM_NAME, type WireChat, type Scene } from './wire';

interface Attachment {
  peerId: string;
  name: string;
}

/** Minimum interval (ms) between lobby keepalive reports from a public room. */
const LOBBY_KEEPALIVE_MS = 20 * 1000;

export class RoomDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastLobbyReport = 0;
  // In-memory cache of the scene / role claims (storage is the durable copy; reloaded lazily after hibernation wakes the DO).
  private sceneCache: Scene | null | undefined;
  private assignmentsCache: Record<string, string> | undefined;

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
        // Sync the current scene + host + role claim state.
        ws.send(JSON.stringify({ t: 'scene', scene: await this.getScene(), host }));
        ws.send(JSON.stringify({ t: 'role', assignments: await this.getAssignments() }));
        // Tell the other members that someone joined.
        this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'chat': {
        const scene = await this.getScene();
        const assignments = await this.getAssignments();
        // The host may speak on behalf of an AI-driven role (checked: sender=host and that role really is AI-driven).
        const aiAs = await this.aiSenderOk(att.peerId, msg.as, assignments);
        const fromId = aiAs ?? att.peerId;
        const chat: WireChat = {
          id: (msg.id as string) ?? crypto.randomUUID(),
          _from: fromId,
          n: (msg.n as string) || att.name,
          x: msg.x as string | undefined,
          m: msg.m as WireChat['m'],
          mentions: msg.mentions as WireChat['mentions'],
          senderRole: this.roleNameOf(fromId, scene, assignments),
          ts: (msg.ts as number) ?? Date.now(),
        };
        this.saveMessage(chat);
        // Normal message: the sender already has an optimistic copy, so exclude it from the broadcast;
        // AI-proxied message: the host has no local copy, so broadcast to everyone (host included).
        this.broadcast({ t: 'chat', ...chat }, aiAs ? undefined : ws);
        return;
      }

      case 'scene': {
        // Only the host may set/change the scene. Switching scenes clears the role claims (the role ids changed).
        const host = await this.ctx.storage.get<string>('hostPeerId');
        if (att.peerId !== host) return;
        const scene = (msg.scene as Scene | null) ?? null;
        this.sceneCache = scene;
        await this.ctx.storage.put('scene', scene);
        await this.setAssignments({});
        this.broadcast({ t: 'scene', scene, host });
        this.broadcast({ t: 'role', assignments: {} });
        // Refresh the lobby right away so the scene name (or its removal) shows up on the public room card immediately.
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'role': {
        // Claim/release (human); hand over to / take back from AI (host only). One role per person at most; the AI placeholder is "ai:<roleId>".
        const act = msg.act as 'claim' | 'release' | 'assign-ai' | 'release-ai';
        const roleId = msg.roleId as string;
        const assignments = { ...(await this.getAssignments()) };
        const aiHolder = `ai:${roleId}`;
        if (act === 'assign-ai' || act === 'release-ai') {
          const host = await this.ctx.storage.get<string>('hostPeerId');
          if (att.peerId !== host) return; // only the host may hand a role to / take it back from the AI
          if (act === 'assign-ai') {
            const role = (await this.getScene())?.roles.find(r => r.id === roleId);
            if (!role?.aiPlayable) return; // only aiPlayable roles can be handed to the AI
            assignments[roleId] = aiHolder; // overrides whoever currently holds it
          } else if (assignments[roleId] === aiHolder) {
            delete assignments[roleId];
          }
        } else if (act === 'claim') {
          if (assignments[roleId]?.startsWith('ai:')) return; // role held by the AI; the host has to take it back from the AI first
          for (const [rid, pid] of Object.entries(assignments)) {
            if (pid === att.peerId) delete assignments[rid];
          }
          if (!assignments[roleId]) assignments[roleId] = att.peerId;
        } else if (assignments[roleId] === att.peerId) {
          delete assignments[roleId];
        }
        await this.setAssignments(assignments);
        this.broadcast({ t: 'role', assignments });
        return;
      }

      case 'cmd':
      case 'wave': {
        // Forward directly to the target peer. The host may act on behalf of an AI-driven role (_from = ai:<roleId>, which the device side uses for authorization checks).
        const aiAs = await this.aiSenderOk(att.peerId, msg.as, await this.getAssignments());
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
      // Release the roles that member had claimed, and broadcast the update.
      const assignments = { ...(await this.getAssignments()) };
      let changed = false;
      for (const [rid, pid] of Object.entries(assignments)) {
        if (pid === att.peerId) {
          delete assignments[rid];
          changed = true;
        }
      }
      if (changed) {
        await this.setAssignments(assignments);
        this.broadcast({ t: 'role', assignments }, ws);
      }
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
      JSON.stringify({ x: chat.x, m: chat.m, mentions: chat.mentions, senderRole: chat.senderRole }),
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
        senderRole?: string;
      };
      return {
        id: r.id as string,
        _from: r.from_id as string,
        n: r.name as string,
        x: body.x,
        m: body.m,
        mentions: body.mentions,
        senderRole: body.senderRole,
        ts: r.ts as number,
      };
    });
  }

  // -- Scene / role claims --

  private async getScene(): Promise<Scene | null> {
    if (this.sceneCache === undefined) {
      this.sceneCache = (await this.ctx.storage.get<Scene>('scene')) ?? null;
    }
    return this.sceneCache;
  }

  private async getAssignments(): Promise<Record<string, string>> {
    if (this.assignmentsCache === undefined) {
      this.assignmentsCache = (await this.ctx.storage.get<Record<string, string>>('roleAssignments')) ?? {};
    }
    return this.assignmentsCache;
  }

  private async setAssignments(a: Record<string, string>): Promise<void> {
    this.assignmentsCache = a;
    await this.ctx.storage.put('roleAssignments', a);
  }

  /** Look up the name (= title) of the role a member currently holds. The AI placeholder "ai:<roleId>" resolves too. */
  private roleNameOf(peerId: string, scene: Scene | null, assignments: Record<string, string>): string | undefined {
    if (!scene) return undefined;
    const entry = Object.entries(assignments).find(([, pid]) => pid === peerId);
    if (!entry) return undefined;
    return scene.roles.find(r => r.id === entry[0])?.name;
  }

  /**
   * Check whether "the host speaking/acting on behalf of an AI-driven role" is legitimate.
   * Returns that AI placeholder id ("ai:<roleId>") when it is, otherwise null.
   * Conditions: `as` looks like ai:<roleId>, the sender is the host, and that role really is
   * currently AI-driven.
   */
  private async aiSenderOk(
    senderPeerId: string,
    as: unknown,
    assignments: Record<string, string>,
  ): Promise<string | null> {
    if (typeof as !== 'string' || !as.startsWith('ai:')) return null;
    const host = await this.ctx.storage.get<string>('hostPeerId');
    if (senderPeerId !== host) return null;
    const roleId = as.slice(3);
    return assignments[roleId] === as ? as : null;
  }

  /** Only public rooms report to the lobby; count=0 means the room is empty and gets removed from the lobby. */
  private async reportLobby(count: number): Promise<void> {
    const isPublic = await this.ctx.storage.get<boolean>('public');
    if (!isPublic) return;
    const code = (await this.ctx.storage.get<string>('code')) ?? '';
    const name = (await this.ctx.storage.get<string>('roomName')) ?? '';
    if (!code) return;
    const sceneName = (await this.getScene())?.name || undefined;
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName(LOBBY_NAME));
    await stub.fetch('https://lobby/update', {
      method: 'POST',
      body: JSON.stringify({ code, name, count, sceneName }),
    });
  }
}
