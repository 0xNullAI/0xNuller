// RoomDO: one instance per group (idFromName(roomCode)), and one per direct-message
// conversation (idFromName(dmRoomCode(a, b)) — see dm.ts).
// Responsibilities: WebSocket relay (replaces the public MQTT broker) + connection-level presence + chat history (SQLite) persistence and replay
//                   + durable ownership (an owner key hash, not a peerId) + owner-controlled lobby visibility
//                   + bounded retention (oldest messages and their R2 media dropped together) + idle media reconciliation.
//
// A room used to delete itself ten minutes after the last member left. It does not any more:
// a room is a group, it persists and so does its history. What replaced the self-destruct is
// a cap (see GROUP_MESSAGE_LIMIT) plus the sweep in alarm(), because "permanent" without a
// bound is just an unbounded Durable Object and an R2 prefix nothing ever cleans.
//
// A conversation is the same object with the group's *administration* removed: no ownership,
// no host and therefore no room agent, no lobby row. Everything else is identical on purpose —
// it is a room with two people in it, so history, media, presence and device control all work
// the way they do in a group, by being this class rather than a parallel implementation of the
// same problems. What differs is only what a two-person conversation cannot have.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { deleteRoomMedia, listRoomMedia } from './media';
import {
  canAdministerGroup,
  enforceMessageRetention,
  generateOwnerKey,
  hashOwnerKey,
  orphanMediaIds,
  type MediaStore,
  type MessageStore,
} from './group';
import { dmAllowsFrame, dmTicketRevoked, isDmRoomCode, type DmSummary } from './dm';
import {
  LOBBY_NAME,
  MAX_GROUP_NAME,
  ROOM_GRACE_MS,
  RESERVED_ROOM_CODE,
  RESERVED_ROOM_NAME,
  ROOM_AGENT_SENDER,
  type WireChat,
  type WireGroup,
  type RoomAgent,
} from './wire';

interface Attachment {
  peerId: string;
  name: string;
}

/** Minimum interval (ms) between lobby keepalive reports from a public group. */
const LOBBY_KEEPALIVE_MS = 20 * 1000;

export class RoomDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastLobbyReport = 0;
  // In-memory cache of the room agent (storage is the durable copy; reloaded lazily after hibernation wakes the DO).
  private agentCache: RoomAgent | null | undefined;
  // Same treatment for the code. It is read on every frame now that it decides whether this
  // instance is a DM, and hibernation can wake the DO straight into webSocketMessage without
  // fetch() ever running again — so it cannot be a field set on connect.
  private codeCache: string | undefined;

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
    // Second half of a DM's admission check. The Worker verified the ticket's signature and
    // that the account service issued it; only this object knows whether the conversation has
    // since been severed, because the mark lives in its storage. A ticket minted before the
    // block is dead even though it is still inside its minute.
    if (isDmRoomCode(code)) {
      const iat = Number(url.searchParams.get('iat')) || 0;
      if (dmTicketRevoked(iat, await this.ctx.storage.get<number>('revokedAt'))) {
        return new Response('revoked', { status: 403 });
      }
    }
    const peerId = url.searchParams.get('id') || crypto.randomUUID();
    await this.ctx.storage.put('code', code);
    this.codeCache = code;

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

    // A conversation relays everything a group does except the two administration frames —
    // see DM_REMOVED_FRAMES. Dropping them here rather than only in the UI is the point: a
    // forged client does not use the UI, and `group` is what would put a private conversation
    // into the public lobby.
    const dm = isDmRoomCode(await this.code());
    if (dm && !dmAllowsFrame(t)) return;

    switch (t) {
      case 'hello': {
        att.name = (msg.name as string) ?? '';
        ws.serializeAttachment(att);
        const code = await this.code();
        const reserved = code === RESERVED_ROOM_CODE;

        if (dm) {
          // Nothing to seed, nobody to make owner, no host to elect and no lobby to appear in.
          // A DM has exactly one durable thing: its history.
          ws.send(JSON.stringify({ t: 'history', messages: this.loadHistory() }));
          this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
          return;
        }

        await this.seedSettings(reserved, msg);
        const ownerKey = await this.claimIfRequested(code, reserved, msg);
        const owned = (await this.ctx.storage.get<string>('ownerKeyHash')) != null;
        const isOwner = ownerKey != null || (await this.provesOwnership(code, msg.ownerKey));

        // Host = whoever currently runs the AI agent loop, and only that. It is a live role,
        // not ownership: the group outlives every peerId, so a host left over in storage from
        // a session that ended is reassigned to someone who is actually connected — otherwise
        // a permanent group would end up with a host nobody can be, and no agent would ever run.
        // The permanent discussion room has no host (pure open chat): don't assign one, and
        // clear any leftover.
        let host = '';
        let hostChanged = false;
        if (reserved) {
          await this.ctx.storage.delete('hostPeerId');
        } else {
          const assigned = await this.ensureHost(att.peerId);
          host = assigned.host;
          hostChanged = assigned.changed;
        }

        // Replay the history to this connection (all retained messages and media references).
        ws.send(JSON.stringify({ t: 'history', messages: this.loadHistory() }));
        ws.send(JSON.stringify({ t: 'agent', agent: await this.getAgent(), host }));
        ws.send(JSON.stringify(await this.groupFrame(code, { owned, isOwner, ownerKey })));
        // Tell the other members that someone joined (and that the host moved, if it did).
        this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
        if (hostChanged) {
          this.broadcast({ t: 'agent', agent: await this.getAgent(), host }, ws);
        }
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
        // After the broadcast, never before it: trimming must not add latency to delivery, and
        // it does nothing at all until the group is actually over the cap.
        await this.trimHistory();
        return;
      }

      case 'group': {
        // Owner-only, and durable: the settings survive the session that changed them.
        const code = await this.code();
        // The permanent discussion room's settings are fixed by definition.
        if (code === RESERVED_ROOM_CODE) return;
        if (!(await this.canAdminister(code, att.peerId, msg.ownerKey))) return;

        const wasPublic = (await this.ctx.storage.get<boolean>('public')) === true;
        let changed = false;
        if (typeof msg.public === 'boolean') {
          await this.ctx.storage.put('public', msg.public);
          changed = true;
        }
        if (typeof msg.roomName === 'string') {
          await this.ctx.storage.put('roomName', msg.roomName.slice(0, MAX_GROUP_NAME));
          changed = true;
        }
        if (!changed) return;

        const isPublic = (await this.ctx.storage.get<boolean>('public')) === true;
        // Reflect it in the lobby immediately, in both directions: going public lists the group
        // even with nobody in it, going private takes the row away rather than leaving a stale one.
        if (isPublic) await this.pushLobby(this.ctx.getWebSockets().length, true);
        else if (wasPublic) await this.pushLobby(0, false);
        // The room learns the new settings; it never learns who changed them or with what key.
        this.broadcast(await this.groupFrame(code, {}));
        return;
      }

      case 'agent': {
        // Owner-only. The agent's device commands are authorized as ai:room on the host's
        // authority, so whoever defines it must be the group's owner — which is now a durable
        // key rather than "whoever joined first this session".
        const code = await this.code();
        if (!(await this.canAdminister(code, att.peerId, msg.ownerKey))) return;
        const raw = msg.agent as Record<string, unknown> | null | undefined;
        const next: RoomAgent | null = raw
          ? {
              name: String(raw.name ?? '').slice(0, 40),
              persona: String(raw.persona ?? '').slice(0, 4000),
            }
          : null;
        this.agentCache = next;
        await this.ctx.storage.put('agent', next);
        const host = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
        this.broadcast({ t: 'agent', agent: next, host });
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
        // Piggyback the presence heartbeat as the lobby keepalive (throttled), so a group with people in it never shows as empty.
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
    // Nothing is deleted here any more — a group and its history are permanent. What is left
    // is the housekeeping that used to be a side effect of the group dying: report the group
    // as empty, and reconcile R2 against the retained messages so an attachment whose message
    // never arrived does not sit in the bucket forever with nothing pointing at it.
    if (this.ctx.getWebSockets().length > 0) {
      // An upload can become orphaned while a room remains active. Keep a bounded
      // retry alive instead of waiting for a disconnect that may never happen.
      await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
      return;
    }
    await this.reportLobby(0);
    const code = await this.code();
    if (code) await this.sweepOrphanMedia(code);
  }

  // -- Direct messages (RPC, called by the Worker) --

  /** Ensure an upload with no following chat frame still gets an orphan sweep. */
  async noteMediaUpload(code: string): Promise<void> {
    const stored = await this.code();
    if (stored && stored !== code) throw new Error('room code mismatch');
    if (!stored) {
      await this.ctx.storage.put('code', code);
      this.codeCache = code;
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
  }

  /**
   * This conversation's state for the DM list: when it last had something in it, and how much
   * of that is newer than the caller has read.
   *
   * `since` comes from the client and only ever produces a smaller or larger badge, never
   * access to anything — the ticket is what decides which conversations may be asked about.
   * Nothing here writes, so asking about a conversation nobody has opened answers zeroes.
   */
  async dmSummary(room: string, since: number): Promise<DmSummary> {
    const last = this.sql.exec('SELECT MAX(ts) AS ts FROM messages').one().ts;
    const unread = this.sql
      .exec('SELECT COUNT(*) AS n FROM messages WHERE ts > ?', since)
      .one().n;
    return { room, lastTs: Number(last ?? 0), unread: Number(unread ?? 0) };
  }

  /**
   * Sever this conversation.
   *
   * Called when a block lands. Two effects, and both are needed: the mark makes every ticket
   * minted up to this instant unusable (a client holding one cannot reconnect with it), and
   * the close ends the sockets that are open right now. Without the second, blocking somebody
   * mid-conversation would leave them reading and writing until one side closed its laptop —
   * which is exactly the "gone means hidden" that 0004_contacts.sql refuses.
   *
   * The mark is an instant rather than a flag so unblocking needs no second message: a ticket
   * minted after it is simply newer, and passes.
   */
  async dmRevoke(at: number): Promise<void> {
    await this.ctx.storage.put('revokedAt', at);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, 'revoked');
      } catch {
        /* socket already gone; the mark is what matters */
      }
    }
  }

  // -- Internals --

  /** The room code, cached in memory. Storage is the durable copy. */
  private async code(): Promise<string> {
    if (this.codeCache === undefined) {
      this.codeCache = (await this.ctx.storage.get<string>('code')) ?? '';
    }
    return this.codeCache;
  }

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
      await this.handoverHost(att.peerId, remaining, ws);
    }
    await this.reportLobby(remaining.length);
    if (remaining.length === 0) {
      // Empty group: schedule the idle housekeeping. It no longer wipes anything.
      await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
    }
  }

  /**
   * Seed the group's durable settings from the very first hello, and only that one.
   *
   * `public` used to be applied from every hello, which meant any joiner could publish a
   * private group to the lobby just by asking. It is a setting now, changed through the
   * `group` frame with the owner key. The first hello still seeds it because that is the
   * only signal a client too old to know about ownership can send when it creates a group.
   */
  private async seedSettings(reserved: boolean, msg: Record<string, unknown>): Promise<void> {
    if (reserved) {
      await this.ctx.storage.put('public', true);
      await this.ctx.storage.put('roomName', RESERVED_ROOM_NAME);
      return;
    }
    if ((await this.ctx.storage.get<boolean>('public')) !== undefined) return;
    const isPublic = msg.public === true;
    // A public group needs a label in the lobby, so fall back to the creator's nickname the
    // way the old hello did. A private one is only ever seen by members who reach it by code,
    // and showing them somebody's nickname as the group's name would be worse than no name.
    const fallback = isPublic ? (msg.name as string) : '';
    await this.ctx.storage.put('public', isPublic);
    await this.ctx.storage.put(
      'roomName',
      String((msg.roomName as string) || fallback || '').slice(0, MAX_GROUP_NAME),
    );
  }

  /**
   * Mint the owner key when the creator asks for one, returning it exactly once.
   *
   * Gated on an explicit `claim` rather than "first hello wins": a client that predates
   * ownership would otherwise silently claim a group and throw away the key it never read,
   * leaving the group owned by nobody who can prove it. Without the claim the group simply
   * stays unowned and falls back to host authority.
   */
  private async claimIfRequested(
    code: string,
    reserved: boolean,
    msg: Record<string, unknown>,
  ): Promise<string | null> {
    if (reserved || msg.claim !== true) return null;
    if ((await this.ctx.storage.get<string>('ownerKeyHash')) != null) return null;
    const key = generateOwnerKey();
    await this.ctx.storage.put('ownerKeyHash', await hashOwnerKey(code, key));
    return key;
  }

  private async provesOwnership(code: string, presentedKey: unknown): Promise<boolean> {
    const ownerKeyHash = (await this.ctx.storage.get<string>('ownerKeyHash')) ?? null;
    if (!ownerKeyHash) return false;
    return canAdministerGroup({
      code,
      ownerKeyHash,
      presentedKey,
      senderPeerId: '',
      hostPeerId: null,
    });
  }

  private async canAdminister(
    code: string,
    senderPeerId: string,
    presentedKey: unknown,
  ): Promise<boolean> {
    return canAdministerGroup({
      code,
      ownerKeyHash: (await this.ctx.storage.get<string>('ownerKeyHash')) ?? null,
      presentedKey,
      senderPeerId,
      hostPeerId: (await this.ctx.storage.get<string>('hostPeerId')) ?? null,
    });
  }

  private async groupFrame(
    code: string,
    extra: { owned?: boolean; isOwner?: boolean; ownerKey?: string | null },
  ): Promise<WireGroup> {
    const frame: WireGroup = {
      t: 'group',
      code,
      name: (await this.ctx.storage.get<string>('roomName')) ?? '',
      public: (await this.ctx.storage.get<boolean>('public')) === true,
    };
    if (extra.owned !== undefined) frame.owned = extra.owned;
    if (extra.isOwner !== undefined) frame.isOwner = extra.isOwner;
    if (extra.ownerKey) frame.ownerKey = extra.ownerKey;
    return frame;
  }

  /** Current live peerIds, used to tell a real host from one left over in storage. */
  private livePeerIds(sockets: WebSocket[]): Set<string> {
    const ids = new Set<string>();
    for (const ws of sockets) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.peerId) ids.add(att.peerId);
      } catch {
        /* socket without an attachment; ignore */
      }
    }
    return ids;
  }

  private async ensureHost(candidate: string): Promise<{ host: string; changed: boolean }> {
    const stored = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
    if (stored && this.livePeerIds(this.ctx.getWebSockets()).has(stored)) {
      return { host: stored, changed: false };
    }
    await this.ctx.storage.put('hostPeerId', candidate);
    return { host: candidate, changed: true };
  }

  /** The host left: hand the agent loop to someone still connected, so exactly one browser runs it. */
  private async handoverHost(
    leavingPeerId: string,
    remaining: WebSocket[],
    except: WebSocket,
  ): Promise<void> {
    const stored = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
    if (!stored || stored !== leavingPeerId) return;
    const next = [...this.livePeerIds(remaining)][0] ?? '';
    await this.ctx.storage.put('hostPeerId', next);
    if (next) this.broadcast({ t: 'agent', agent: await this.getAgent(), host: next }, except);
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

  /** Apply the retention cap, dropping each message's R2 media along with its row. */
  private async trimHistory(): Promise<string[]> {
    const code = await this.code();
    const messages: MessageStore = {
      count: () => Number(this.sql.exec('SELECT COUNT(*) AS n FROM messages').one().n),
      oldest: n =>
        this.sql
          .exec('SELECT id, body FROM messages ORDER BY ts ASC, id ASC LIMIT ?', n)
          .toArray()
          .map(r => ({ id: r.id as string, mediaId: mediaIdOf(r.body as string) })),
      remove: ids => {
        for (const id of ids) this.sql.exec('DELETE FROM messages WHERE id = ?', id);
      },
    };
    const media: MediaStore = { delete: ids => deleteRoomMedia(this.env, code, ids) };
    return enforceMessageRetention(messages, media);
  }

  /** Delete R2 objects of this group that no retained message references any more. */
  private async sweepOrphanMedia(code: string): Promise<void> {
    const objects = await listRoomMedia(this.env, code);
    if (objects.length === 0) return;
    const referenced = new Set<string>();
    for (const row of this.sql.exec('SELECT body FROM messages').toArray()) {
      const id = mediaIdOf(row.body as string);
      if (id) referenced.add(id);
    }
    const orphans = orphanMediaIds(objects, referenced, Date.now() - ROOM_GRACE_MS);
    if (orphans.length > 0) await deleteRoomMedia(this.env, code, orphans);
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

  /** Only public groups touch the lobby, so a private group stays entirely invisible to it. */
  private async reportLobby(count: number): Promise<void> {
    const isPublic = await this.ctx.storage.get<boolean>('public');
    if (!isPublic) return;
    await this.pushLobby(count, true);
  }

  /**
   * Report to the lobby. `listed` false removes the row outright — the one case a public
   * group has to be able to reach, since count=0 no longer means "gone" for a permanent group.
   */
  private async pushLobby(count: number, listed: boolean): Promise<void> {
    const code = await this.code();
    if (!code) return;
    const name = (await this.ctx.storage.get<string>('roomName')) ?? '';
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName(LOBBY_NAME));
    await stub.fetch('https://lobby/update', {
      method: 'POST',
      body: JSON.stringify({ code, name, count, listed }),
    });
  }
}

/** The R2 object a stored message body references, if any. */
function mediaIdOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { m?: { id?: string } };
    return parsed.m?.id ?? null;
  } catch {
    return null;
  }
}
