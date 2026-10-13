import {
  initializeGroupMembership,
  groupMembership,
  joinGroupMembership,
  leaveGroupMembership,
  moderateGroupMembership,
  activeGroupMember,
} from './group-membership';
import { initializeDmReadState, dmReadState, advanceDmRead } from './dm-read-state';
import type { DmInboxSummary } from './wire';
import { resolveMessageReply } from './message-reply';
import { isRecalledBody, recallMessage } from './message-recall';
import {
  parseHistoryCursor,
  parseSearchQuery,
  readHistoryPage,
  searchHistory,
} from './room-history';
import {
  claimRoomAgentTurn,
  completeRoomAgentTurn,
  firstMentionedAgent,
  initializeRoomAgentTurns,
  managedRoomAgentTurnCurrent,
} from './room-agent-turn';
import {
  addRoomAgent,
  agentOverDailyCap,
  clearRoomAgents,
  initializeRoomAgents,
  listRoomAgents,
  migrateLegacyAgent,
  recordAgentSpend,
  removeOwnerAgents,
  removeRoomAgent,
  setRoomAgentDailyCap,
  wireRoomAgents,
  type RoomAgentRecord,
} from './room-agents';
import { mediaRefShape, mentionsShape, stateFrameShape } from './frame-shape';
import { clearHistoryFor, historyClearedAt, latestVisibleMessage } from './history-clears';
import { claimMedia, mediaStillReferenced, recordMediaUpload } from './media-ownership';
import {
  managedGroupAnswer,
  managedGroupPrompt,
  managedGroupToolCalls,
  type GroupChatMessage,
} from './managed-group-ai';
import {
  agentTargets,
  MAX_TOOL_CALLS_PER_ROUND,
  snapshotFromFast,
  snapshotFromSlow,
  toolCommand,
  type AgentTarget,
  type PeerSnapshot,
} from './room-agent-tools';
import {
  MAX_GROUP_AI_ROUNDS,
  sha256Body,
  signGroupAiTicket,
} from '../../../workers/auth/src/group-ai-ticket';
// RoomDO: one instance per group (idFromName(roomCode)), and one per direct-message
// conversation (idFromName(dmRoomCode(a, b)) — see dm.ts).
// Responsibilities: WebSocket relay (replaces the public MQTT broker) + connection-level presence + chat history (SQLite) persistence and replay
//                   + durable ownership (an owner key hash, not a peerId) + owner-controlled lobby visibility
//                   + bounded retention (oldest messages and their R2 media dropped together) + idle media reconciliation.
//
// Groups expire after seven consecutive days without connections; DMs retain history.
//
// A conversation is the same object with the group's *administration* removed: no ownership,
// no AIs, no lobby row. Everything else is identical on purpose —
// it is a room with two people in it, so history, media, presence and device control all work
// the way they do in a group, by being this class rather than a parallel implementation of the
// same problems. What differs is only what a two-person conversation cannot have.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { deleteRoomMedia, listRoomMedia } from './media';
import { canAdministerGroup, resolveGroupOwner, orphanMediaIds } from './group';
import {
  authorizeDmToken,
  authorizeDmUpgrade,
  dmAllowsFrame,
  dmTicketRevoked,
  isDmRoomCode,
  type DmSummary,
} from './dm';
import {
  LOBBY_NAME,
  validGroupName,
  ROOM_IDLE_MS,
  ROOM_GRACE_MS,
  LEGACY_ROOM_AGENT_ID,
  type NamedRoomAgent,
  type WireAgent,
  type WireChat,
  type WireGroup,
} from './wire';

interface Attachment {
  peerId: string;
  name: string;
  mediaToken: string;
  accountId?: string;
  dmPeerAccountId?: string;
  dmIssuedAt?: number;
  membershipVersion?: number;
  expiresAt?: number;
  leaseClosed?: boolean;
  indexRegistered?: boolean;
}

/** How long a group AI waits for the target's device to confirm a command. */
const AGENT_ACK_TIMEOUT_MS = 5_000;

interface AgentCommandOutcome {
  ok: boolean;
  message: string;
}

/** Minimum interval (ms) between lobby keepalive reports from a public group. */
const LOBBY_KEEPALIVE_MS = 20 * 1000;

/**
 * Upper bound on one admission. Clients renew in place with a fresh ticket well before
 * this; a socket that stops renewing (account revoked, ticket no longer minted) is closed.
 */
const SOCKET_LEASE_MS = 65_000;

export class RoomDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastLobbyReport = 0;
  private dmReadReady = false;
  private groupMembershipReady = false;
  private roomAgentTurnsReady = false;
  private ensureRoomAgentTurns(): void {
    if (!this.roomAgentTurnsReady) {
      initializeRoomAgentTurns(this.sql);
      this.roomAgentTurnsReady = true;
    }
  }
  private ensureGroupMembership(): void {
    if (!this.groupMembershipReady) {
      initializeGroupMembership(this.sql);
      this.groupMembershipReady = true;
    }
  }
  private ensureDmReadState(): void {
    if (!this.dmReadReady) {
      initializeDmReadState(this.sql);
      this.dmReadReady = true;
    }
  }
  private roomAgentsReady = false;
  /**
   * Messages are ordered by their timestamp, so two in the same millisecond could swap places
   * between devices. Each new message gets a strictly later time than the one before.
   */
  private lastMessageTs = 0;
  private nextMessageTs(): number {
    this.lastMessageTs = Math.max(Date.now(), this.lastMessageTs + 1);
    return this.lastMessageTs;
  }
  /**
   * Each member's latest device report, for choosing a group AI's targets. Memory only: a
   * woken object relearns it from the next 5 s heartbeat, and until then offers no targets.
   */
  private peerSnapshots = new Map<string, PeerSnapshot>();
  /** Device commands a group AI sent and is waiting on, by request id. */
  private pendingAgentCommands = new Map<
    string,
    { peerId: string; settle: (outcome: AgentCommandOutcome) => void }
  >();
  // Same treatment for the code. It is read on every frame now that it decides whether this
  // instance is a DM, and hibernation can wake the DO straight into webSocketMessage without
  // fetch() ever running again — so it cannot be a field set on connect.
  private codeCache: string | undefined;
  private roomIndexed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id TEXT, name TEXT, body TEXT, ts INTEGER)',
    );
    // System push (FCM) was retired. Its outbox held recipient account lists that nothing sends
    // any more, so drop it rather than keep that data around; a no-op once it is gone.
    this.sql.exec('DROP TABLE IF EXISTS push_outbox');
    this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.getWebSockets().length) await this.scheduleSocketAlarm();
    });
  }

  /** Backup RPC: raw persisted rows, newest first, with a stable (timestamp, id) cursor. */
  async exportBackupMessages(
    code: string,
    before?: { ts: number; id: string },
  ): Promise<{
    room: string;
    exists: boolean;
    messages: Record<string, SqlStorageValue>[];
    before: { ts: number; id: string } | null;
    totalMessages: number;
  }> {
    if ((await this.ctx.storage.get<string>('code')) !== code)
      return { room: code, exists: false, messages: [], before: null, totalMessages: 0 };
    const totalMessages = Number(this.sql.exec('SELECT COUNT(*) AS n FROM messages').one().n);
    const rows = this.sql
      .exec(
        // The sender account is what identifies a sender across restores; peer ids are per page load.
        `SELECT m.id,m.from_id,m.name,m.body,m.ts,s.sender_account FROM messages m LEFT JOIN message_sequences s ON s.message_id=m.id ${before ? 'WHERE m.ts < ? OR (m.ts = ? AND m.id < ?)' : ''} ORDER BY m.ts DESC,m.id DESC LIMIT 101`,
        ...(before ? [before.ts, before.ts, before.id] : []),
      )
      .toArray();
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return {
      room: code,
      exists: true,
      messages: page,
      before: rows.length > 100 && last ? { ts: Number(last.ts), id: String(last.id) } : null,
      totalMessages,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? '';
    const expiresAt = Number(request.headers.get('X-Ticket-Expires-At'));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      return new Response('admission expired', { status: 401 });
    if (!isDmRoomCode(code) && (await this.ctx.storage.get<boolean>('closed')) === true) {
      return endedSocket({ t: 'sys', kind: 'closed' }, 'room closed');
    }
    if (!isDmRoomCode(code) && (await this.recycleIdleRoom(Date.now()))) {
      return endedSocket({ t: 'sys', kind: 'closed' }, 'room expired');
    }
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
    if (!isDmRoomCode(code)) {
      this.ensureGroupMembership();
      const account = request.headers.get('X-Chat-Account');
      if (!account) return new Response('verified account required', { status: 401 });
      if (!(await this.registerAccountRoom(code, account)))
        return new Response('account unavailable', { status: 403 });
      const membership = account ? groupMembership(this.sql, account) : null;
      if (membership && ['removed', 'banned'].includes(membership.state))
        return endedSocket({ t: 'sys', kind: 'membership-revoked' }, 'membership revoked');
    }
    const peerId = url.searchParams.get('id') || crypto.randomUUID();
    if (
      peerId.length > 128 ||
      peerId.startsWith('ai:') ||
      [...peerId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return new Response('invalid peer identity', { status: 400 });
    await this.ctx.storage.put('code', code);
    this.codeCache = code;
    // Index only a room whose identity is now stored. Indexing before the object accepted
    // the request let any signed-in user plant codes that every backup run then refused.
    if (!this.roomIndexed) {
      try {
        await this.env.ROOM_INDEX.get(this.env.ROOM_INDEX.idFromName('all-rooms')).register(
          code,
          isDmRoomCode(code) ? 'dm' : 'group',
        );
        this.roomIndexed = true;
      } catch {
        return new Response('room index unavailable', { status: 503 });
      }
    }

    await this.ctx.storage.delete('idleSince');
    await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
    // The client proposes a peer ID, but a second live socket must never be able to
    // impersonate the elected host or another participant by reusing it.
    // The same account may take its own peer id back: after a network switch the old socket
    // can stay half-open until its lease runs out, and the client would be locked out meanwhile.
    const connectingAccount =
      request.headers.get(isDmRoomCode(code) ? 'X-DM-Account' : 'X-Chat-Account') ?? undefined;
    for (const existing of this.ctx.getWebSockets()) {
      let held: Attachment | null;
      try {
        held = existing.deserializeAttachment() as Attachment | null;
      } catch {
        continue; // stale socket without a usable attachment
      }
      if (held?.peerId !== peerId) continue;
      if (!connectingAccount || held.accountId !== connectingAccount)
        return new Response('peer identity already connected', { status: 409 });
      try {
        existing.close(1000, 'replaced by a new connection');
      } catch {
        /* already closing */
      }
      held.leaseClosed = true;
      try {
        existing.serializeAttachment(held);
      } catch {
        /* closed sockets may refuse; the lease check still treats it as gone */
      }
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      peerId,
      expiresAt: Math.min(expiresAt, Date.now() + SOCKET_LEASE_MS),
      accountId:
        request.headers.get(isDmRoomCode(code) ? 'X-DM-Account' : 'X-Chat-Account') ?? undefined,
      dmPeerAccountId: isDmRoomCode(code)
        ? (request.headers.get('X-DM-Peer-Account') ?? undefined)
        : undefined,
      dmIssuedAt: isDmRoomCode(code) ? Number(url.searchParams.get('iat')) : undefined,
      name: '',
      mediaToken: generateMediaToken(),
    } satisfies Attachment);

    await this.scheduleSocketAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 128_000) return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(message);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (!this.socketLeaseAlive(ws)) return;
    const att = ws.deserializeAttachment() as Attachment;
    const t = msg.t as string;

    // A conversation relays everything a group does except the two administration frames —
    // see DM_REMOVED_FRAMES. Dropping them here rather than only in the UI is the point: a
    // forged client does not use the UI, and `group` is what would put a private conversation
    // into the public lobby.
    const dm = isDmRoomCode(await this.code());
    if (dm && !dmAllowsFrame(t)) return;
    if (dm) this.ensureDmReadState();
    if (!dm) {
      this.ensureGroupMembership();
      this.ensureDmReadState();
    }
    if (!dm && att.accountId) {
      this.ensureGroupMembership();
      if (this.accountRevoked(att.accountId)) {
        ws.close(1008, 'account revoked');
        return;
      }
      if (!att.indexRegistered || t === 'hello') {
        if (!(await this.registerAccountRoom(await this.code(), att.accountId))) {
          ws.close(1008, 'account revoked');
          return;
        }
        att.indexRegistered = true;
        ws.serializeAttachment(att);
      }

      if (
        (t !== 'hello' || att.membershipVersion !== undefined) &&
        !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
      ) {
        ws.close(1008, 'membership revoked');
        return;
      }
    }

    if (!this.socketLeaseAlive(ws)) return;
    switch (t) {
      case 'history':
      case 'media-auth':
      case 'sys':
      case 'agent-error':
      case 'agent-claim-result':
      case 'agent-run-status':
      case 'search-result':
      case 'history-cleared':
        // Server-only envelopes must never be relayed from another participant.
        return;
      case 'renew': {
        await this.renewSocketLease(ws, att, dm, msg.ticket);
        return;
      }
      case 'hello': {
        att.name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : '';
        ws.serializeAttachment(att);
        // Upload is a separate HTTP request. This random capability ties it back to the
        // currently-live WebSocket instead of treating knowledge of a room code as write access.
        // `renew: true` tells the client this object accepts in-place lease renewal. Older
        // objects relay unknown frames to the room, so a client must never send a ticket
        // in a `renew` frame unless it saw this flag.
        this.sendAuthorized(
          ws,
          JSON.stringify({ t: 'media-auth', token: att.mediaToken, renew: true }),
        );
        const code = await this.code();
        if (dm) {
          // Nothing to seed, nobody to make owner, no AI and no lobby to appear in.
          // A DM has exactly one durable thing: its history.
          this.sendAuthorized(
            ws,
            JSON.stringify(
              readHistoryPage(
                this.sql,
                undefined,
                msg.historyPaging === true ? 100 : 1000,
                historyClearedAt(this.sql, att.accountId),
              ),
            ),
          );
          this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
          return;
        }

        if (!(await this.seedSettings(msg))) {
          this.sendAuthorized(
            ws,
            JSON.stringify({ t: 'sys', kind: 'closed', message: '房间名必须为 4–40 个字符' }),
          );
          ws.close(1008, '房间名必须为 4–40 个字符');
          return;
        }
        if (!this.socketLeaseAlive(ws) || (att.accountId && this.accountRevoked(att.accountId)))
          return;
        if (att.accountId) {
          // `join: false` marks an automatic reconnect. It keeps an active membership but
          // must not reactivate one the account left on another device; only an explicit
          // join (or a legacy client that sends neither) may.
          if (msg.join === false && groupMembership(this.sql, att.accountId)?.state === 'left') {
            // Tell the client to stop reconnecting, as for any other revoked membership.
            this.sendAuthorized(ws, JSON.stringify({ t: 'sys', kind: 'membership-revoked' }));
            ws.close(1008, 'membership revoked');
            return;
          }
          const membership = joinGroupMembership(this.sql, att.accountId, att.name, Date.now());
          if (!membership) {
            ws.close(1008, 'membership revoked');
            return;
          }
          att.membershipVersion = membership.version;
          ws.serializeAttachment(att);
        }
        const assignedOwner = await this.bindOwnerIfNeeded(code, msg, att.accountId);
        const owned = (await this.ctx.storage.get<string>('ownerAccountId')) != null;
        const isOwner = await this.canAdminister(code, att.accountId, msg.ownerKey);

        if (
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        ) {
          ws.close(1008, 'membership revoked');
          return;
        }
        // Replay the history to this connection (all retained messages and media references).
        this.sendAuthorized(
          ws,
          JSON.stringify(
            readHistoryPage(
              this.sql,
              undefined,
              msg.historyPaging === true ? 100 : 1000,
              historyClearedAt(this.sql, att.accountId),
            ),
          ),
        );
        this.sendAuthorized(ws, JSON.stringify(await this.agentFrame()));
        this.sendAuthorized(ws, JSON.stringify(await this.groupFrame(code, { owned, isOwner })));
        if (assignedOwner === 'legacy') {
          // A legacy group just got its first account owner. Tell everyone, so the members
          // who are not the owner see why their settings controls are read-only.
          this.broadcast({ t: 'sys', kind: 'owner-assigned', name: att.name });
        }
        this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'history-before': {
        const before = parseHistoryCursor(msg.before);
        if (before)
          this.sendAuthorized(
            ws,
            JSON.stringify(
              readHistoryPage(
                this.sql,
                before,
                undefined,
                historyClearedAt(this.sql, att.accountId),
              ),
            ),
          );
        return;
      }
      case 'search': {
        const query = parseSearchQuery(msg.q);
        if (
          !query ||
          typeof msg.requestId !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(msg.requestId)
        )
          return;
        this.sendAuthorized(
          ws,
          JSON.stringify({
            t: 'search-result',
            requestId: msg.requestId,
            messages: searchHistory(
              this.sql,
              query,
              undefined,
              historyClearedAt(this.sql, att.accountId),
            ),
          }),
        );
        return;
      }
      case 'agent-claim': {
        // Clients from before AIs ran on the server ask to run one. Nobody does any more.
        if (typeof msg.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(msg.requestId))
          return;
        this.sendAuthorized(
          ws,
          JSON.stringify({ t: 'agent-claim-result', requestId: msg.requestId, grantId: null }),
        );
        return;
      }
      case 'chat': {
        // Only the server speaks as an AI; a participant claiming to is dropped.
        if (msg.as !== undefined) return;
        const fromId = att.peerId;
        const chat: WireChat = {
          id:
            typeof msg.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(msg.id)
              ? msg.id
              : crypto.randomUUID(),
          _from: fromId,
          replyTo: resolveMessageReply(this.sql, msg.replyToId),
          n: att.name,
          x: msg.x as string | undefined,
          ts: this.nextMessageTs(),
        };
        const media = mediaRefShape(msg.m);
        const mentions = mentionsShape(msg.mentions);
        if (media === null) return;
        if (media) chat.m = media;
        if (mentions) chat.mentions = mentions;
        if (typeof chat.x !== 'undefined' && (typeof chat.x !== 'string' || chat.x.length > 32000))
          return;
        // Media is attached only by the account that uploaded it, to one message.
        if (media && !claimMedia(this.sql, media.id, att.accountId, chat.id)) {
          this.echoStoredMessage(ws, chat.id, fromId);
          return;
        }
        if (
          !dm &&
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;
        if (!this.socketLeaseAlive(ws)) return;
        const saved = this.ctx.storage.transactionSync(() => this.saveMessage(chat));
        if (!saved) {
          // A retry of a message this sender already saved: confirm it to the sender only,
          // so a lost echo cannot leave the message pending forever or send it twice.
          this.echoStoredMessage(ws, chat.id, fromId);
          return;
        }
        if (att.accountId)
          this.sql.exec(
            'UPDATE message_sequences SET sender_account=? WHERE message_id=?',
            att.accountId,
            chat.id,
          );
        // Echo the saved message to the sender so a local optimistic copy can become
        // server-confirmed before it can trigger any billable room AI turn.
        this.broadcast({
          t: 'chat',
          ...chat,
          ...(att.accountId ? { _account: att.accountId } : {}),
        });
        if (!dm && att.accountId) await this.startAgentTurn(chat, att.accountId);
        return;
      }

      case 'clear-history': {
        // Clears this account's view only; everyone else keeps the conversation as it is.
        if (!att.accountId) return;
        if (!dm && !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)) return;
        const account = att.accountId;
        // Message times can run a little ahead of the clock (see nextMessageTs); the cut-off
        // must cover every message already stored.
        const newest = this.sql.exec('SELECT MAX(ts) AS ts FROM messages').toArray()[0]?.ts;
        const now = Math.max(Date.now(), typeof newest === 'number' ? newest : 0);
        this.ensureDmReadState();
        this.ctx.storage.transactionSync(() => {
          clearHistoryFor(this.sql, account, now);
          const last = this.sql
            .exec('SELECT MAX(sequence) AS s FROM message_sequences')
            .toArray()[0]?.s;
          if (typeof last === 'number') advanceDmRead(this.sql, account, last);
        });
        // Every device of this account empties its view at once.
        for (const socket of this.ctx.getWebSockets()) {
          try {
            if ((socket.deserializeAttachment() as Attachment | null)?.accountId === account)
              this.sendAuthorized(socket, JSON.stringify({ t: 'history-cleared', at: now }));
          } catch {
            /* closing socket */
          }
        }
        return;
      }

      case 'recall': {
        if (!att.accountId) return;
        if (!dm && !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)) return;
        const accountId = att.accountId;
        const recalled = this.ctx.storage.transactionSync(() =>
          recallMessage(this.sql, msg.id, accountId, Date.now()),
        );
        if (!recalled) return;
        this.broadcast({ t: 'recall', id: msg.id as string });
        // Another message may still show the same object; the orphan sweep handles the rest.
        if (recalled.mediaId && !mediaStillReferenced(this.sql, recalled.mediaId)) {
          const code = await this.code();
          const removal = deleteRoomMedia(this.env, code, [recalled.mediaId]).catch(
            () => undefined,
          );
          if (this.ctx.waitUntil) this.ctx.waitUntil(removal);
        }
        return;
      }

      case 'membership-leave': {
        if (dm || !att.accountId || att.membershipVersion === undefined) return;
        if (leaveGroupMembership(this.sql, att.accountId, att.membershipVersion, Date.now())) {
          await this.releaseOwnership(att.accountId);
          await this.retireOwnerAgents(att.accountId);
        }
        this.closeAccountSockets(att.accountId);
        return;
      }
      case 'membership': {
        if (dm || !(await this.canAdminister(await this.code(), att.accountId, msg.ownerKey)))
          return;
        this.ensureGroupMembership();
        if (!this.socketLeaseAlive(ws)) return;
        if (
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;
        const action = msg.action;
        if (
          ['remove', 'ban', 'restore'].includes(String(action)) &&
          typeof msg.accountId === 'string' &&
          msg.accountId !== att.accountId
        ) {
          moderateGroupMembership(
            this.sql,
            msg.accountId,
            action as 'remove' | 'ban' | 'restore',
            Date.now(),
          );
          if (action !== 'restore') {
            await this.retireOwnerAgents(msg.accountId);
            this.closeAccountSockets(msg.accountId);
          }
        }
        this.sendAuthorized(
          ws,
          JSON.stringify({
            t: 'membership-state',
            members: this.sql
              .exec(
                'SELECT account_id,name,state,version,updated_at FROM group_memberships ORDER BY updated_at DESC LIMIT 200',
              )
              .toArray(),
          }),
        );
        return;
      }
      case 'membership-state':
        return;

      case 'group': {
        // Owner-only, and durable: the settings survive the session that changed them.
        const code = await this.code();
        if (
          !(await this.canAdminister(code, att.accountId, msg.ownerKey)) ||
          !this.socketLeaseAlive(ws)
        )
          return;
        if (
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;

        if (msg.closed === true) {
          await this.env.ROOM_INDEX?.get(this.env.ROOM_INDEX.idFromName('all-rooms')).tombstone(
            code,
            'group',
            'closed',
          );
          await this.ctx.storage.put('closed', true);
          this.ensureGroupMembership();
          this.sql.exec(
            "UPDATE group_memberships SET state='removed',version=version+1,updated_at=? WHERE state='active'",
            Date.now(),
          );
          await this.ensureRoomAgents();
          clearRoomAgents(this.sql);
          await this.pushLobby(0, false);
          this.broadcast({ t: 'sys', kind: 'closed' });
          for (const socket of this.ctx.getWebSockets()) {
            try {
              socket.close(4000, '房间已关闭');
            } catch {
              /* already closing */
            }
          }
          return;
        }

        if (msg.roomName !== undefined && !validGroupName(msg.roomName)) return;
        const wasPublic = (await this.ctx.storage.get<boolean>('public')) === true;
        let changed = false;
        if (typeof msg.public === 'boolean') {
          await this.ctx.storage.put('public', msg.public);
          changed = true;
        }
        if (typeof msg.roomName === 'string') {
          await this.ctx.storage.put('roomName', msg.roomName.trim());
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

      case 'agent':
      case 'agent-billing': {
        // Pre-ownership clients configured one group-wide AI. AIs belong to members now.
        if (dm) return;
        this.sendAuthorized(
          ws,
          JSON.stringify({ t: 'agent-error', message: '请更新到最新版本后再设置群 AI' }),
        );
        return;
      }

      case 'agent-add': {
        if (dm || !att.accountId) return;
        const code = await this.code();
        const ticket = await authorizeDmToken({
          secret: this.env.DM_TICKET_SECRET,
          token: typeof msg.ticket === 'string' ? msg.ticket : null,
          audience: 'group-agent',
          now: Date.now(),
        });
        // The account service vouches that this member owns the character and has Credit;
        // the ticket names this group so it cannot be replayed into another one.
        if (
          !ticket.ok ||
          ticket.claims.sub !== att.accountId ||
          ticket.claims.room !== code ||
          !ticket.claims.characterId
        ) {
          this.sendAuthorized(
            ws,
            JSON.stringify({ t: 'agent-error', message: '无法确认角色归属，请重试' }),
          );
          return;
        }
        if (
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1) ||
          !this.socketLeaseAlive(ws)
        )
          return;
        await this.ensureRoomAgents();
        const added = addRoomAgent(
          this.sql,
          {
            owner: att.accountId,
            ownerName: att.name,
            characterId: ticket.claims.characterId,
            name: typeof msg.name === 'string' ? msg.name : '',
            persona: typeof msg.persona === 'string' ? msg.persona : '',
          },
          Date.now(),
        );
        if (!added.ok) {
          this.sendAuthorized(ws, JSON.stringify({ t: 'agent-error', message: added.message }));
          return;
        }
        this.broadcast(await this.agentFrame());
        return;
      }

      case 'agent-cap': {
        if (dm || !att.accountId) return;
        if (!activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)) return;
        await this.ensureRoomAgents();
        if (setRoomAgentDailyCap(this.sql, msg.agentId, att.accountId, msg.dailyCap))
          this.broadcast(await this.agentFrame());
        return;
      }

      case 'agent-remove': {
        if (dm || !att.accountId) return;
        if (!activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)) return;
        await this.ensureRoomAgents();
        const agent = listRoomAgents(this.sql).find((candidate) => candidate.id === msg.agentId);
        // The owner withdraws their own AI; the group's owner may remove anyone's.
        if (
          !agent ||
          (agent.owner !== att.accountId &&
            !(await this.canAdminister(await this.code(), att.accountId, msg.ownerKey)))
        )
          return;
        if (removeRoomAgent(this.sql, agent.id)) this.broadcast(await this.agentFrame());
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
        // Forward directly to the target peer under the sender's own identity. No participant
        // may act as an AI: a device must never mistake a member's command for an AI's.
        if (
          !dm &&
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;
        if (!this.socketLeaseAlive(ws)) return;
        const { as: _ignored, ...forwarded } = msg;
        this.sendTo(msg.to as string, { ...forwarded, _from: att.peerId });
        return;
      }

      case 'cmd-ack': {
        // Only the device the command went to may answer it.
        const pending =
          typeof msg.rid === 'string' ? this.pendingAgentCommands.get(msg.rid) : undefined;
        if (!pending || pending.peerId !== att.peerId) return;
        pending.settle({
          ok: msg.ok === true,
          message:
            typeof msg.r === 'string' && msg.r.trim()
              ? msg.r.trim().slice(0, 200)
              : msg.ok === true
                ? '已执行'
                : '对方设备拒绝了这个操作',
        });
        return;
      }

      case 'leave': {
        this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
        return;
      }

      default: {
        // Only presence and device state reach everyone through here, each rebuilt from the
        // fields clients read; anything else has its own case or is dropped.
        if (t !== 'presence' && t !== 'ss' && t !== 'sf') return;
        msg = stateFrameShape(t, msg);
        if (!dm && att.accountId && (t === 'ss' || t === 'sf')) {
          const prev = this.peerSnapshots.get(att.peerId);
          const next =
            t === 'ss'
              ? snapshotFromSlow(prev, att.accountId, msg, Date.now())
              : snapshotFromFast(prev, msg);
          if (next) this.peerSnapshots.set(att.peerId, next);
          else this.peerSnapshots.delete(att.peerId);
        }
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
    for (const socket of this.ctx.getWebSockets()) this.socketLeaseAlive(socket);
    const code = await this.code();
    if (await this.recycleIdleRoom(Date.now())) return;
    if (code) await this.sweepOrphanMedia(code);
    if (this.ctx.getWebSockets().length > 0) {
      // Active rooms can still abandon uploads. Sweep first, then keep a bounded recurring
      // reconciliation alive. A thrown R2 error lets the platform retry this alarm.
      await this.scheduleSocketAlarm();
      return;
    }
    await this.reportLobby(0);
    if (code && !isDmRoomCode(code)) {
      const idleSince = (await this.ctx.storage.get<number>('idleSince')) ?? Date.now();
      await this.ctx.storage.put('idleSince', idleSince);
      await this.ctx.storage.setAlarm(idleSince + ROOM_IDLE_MS);
    }
  }

  // -- Direct messages (RPC, called by the Worker) --

  /** Ensure an upload with no following chat frame still gets an orphan sweep. */
  async noteMediaUpload(code: string, token: string, id?: string): Promise<void> {
    if (!(await this.authorizeMediaUpload(code, token))) throw new Error('media token expired');
    const uploader = this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Attachment | null)
      .find((att) => att?.mediaToken && mediaTokenEqual(att.mediaToken, token))?.accountId;
    if (id && uploader) recordMediaUpload(this.sql, id, uploader, Date.now());
    const stored = await this.code();
    if (stored && stored !== code) throw new Error('room code mismatch');
    if (!stored) {
      await this.ctx.storage.put('code', code);
      this.codeCache = code;
    }
    await this.scheduleSocketAlarm();
  }

  /** True only while the WebSocket that received this capability is still attached. */
  async authorizeMediaUpload(code: string, token: string): Promise<boolean> {
    if (!token || (await this.code()) !== code) return false;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (!this.socketLeaseAlive(ws)) continue;
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.mediaToken && mediaTokenEqual(att.mediaToken, token)) {
          if (!att.accountId) return false;
          if (isDmRoomCode(code)) {
            if (
              !att.dmPeerAccountId ||
              !att.dmIssuedAt ||
              dmTicketRevoked(att.dmIssuedAt, await this.ctx.storage.get<number>('revokedAt')) ||
              !this.env.ACCOUNT_REGISTRY
            )
              return false;
            try {
              if (
                !(await this.env.ACCOUNT_REGISTRY.get(
                  this.env.ACCOUNT_REGISTRY.idFromName(att.accountId),
                ).isActive(att.accountId))
              )
                return false;
            } catch {
              return false;
            }
          } else if (!(await this.registerAccountRoom(code, att.accountId))) return false;
          return this.socketLeaseAlive(ws);
        }
      } catch {
        /* malformed legacy attachment; it has no upload capability */
      }
    }
    return false;
  }

  /** Private media is readable only through the current DM socket's short-lived capability. */
  async authorizeMediaRead(code: string, token: string): Promise<boolean> {
    return isDmRoomCode(code) && this.authorizeMediaUpload(code, token);
  }

  /**
   * This conversation's state for the DM list: when it last had something in it, and how much
   * of that is newer than the caller has read.
   *
   * `since` comes from the client and only ever produces a smaller or larger badge, never
   * access to anything — the ticket is what decides which conversations may be asked about.
   * Nothing here writes, so asking about a conversation nobody has opened answers zeroes.
   */
  /** Read-only inbox metadata, bounded by a verified digest ticket and this room's revocation mark. */
  async dmInboxSummary(
    room: string,
    issuedAt: number,
    account?: string,
  ): Promise<DmInboxSummary | null> {
    if (
      !isDmRoomCode(room) ||
      dmTicketRevoked(issuedAt, await this.ctx.storage.get<number>('revokedAt'))
    )
      return null;
    const stored = await this.ctx.storage.get<string>('code');
    if (stored && stored !== room) return null;
    this.ensureDmReadState();
    const row = latestVisibleMessage(this.sql, account);
    const read = account
      ? dmReadState(this.sql, account)
      : { unread: null, lastSequence: 0, readSequence: null };
    if (!row) return { room, lastMessageAt: null, preview: '', ...read };
    const body = JSON.parse(row.body as string) as { x?: string; m?: { kind?: string } };
    const preview = (
      isRecalledBody(row.body)
        ? '消息已撤回'
        : typeof body.x === 'string' && body.x
          ? body.x
          : body.m?.kind === 'image'
            ? '[图片]'
            : body.m?.kind === 'audio'
              ? '[语音]'
              : '[消息]'
    )
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    return { room, lastMessageAt: Number(row.ts), preview, ...read };
  }

  async dmMarkRead(
    room: string,
    issuedAt: number,
    account: string,
    sequence: number | string,
  ): Promise<boolean> {
    if (
      !isDmRoomCode(room) ||
      dmTicketRevoked(issuedAt, await this.ctx.storage.get<number>('revokedAt'))
    )
      return false;
    const stored = await this.ctx.storage.get<string>('code');
    if (stored && stored !== room) return false;
    this.ensureDmReadState();
    const resolved =
      typeof sequence === 'string'
        ? this.sql
            .exec(
              'SELECT s.sequence FROM message_sequences s JOIN messages m ON m.id=s.message_id WHERE m.id=?',
              sequence,
            )
            .toArray()[0]?.sequence
        : sequence;
    return typeof resolved === 'number' && advanceDmRead(this.sql, account, resolved);
  }

  async groupInboxSummary(
    room: string,
    account: string,
  ): Promise<(DmInboxSummary & { membershipVersion: number }) | null> {
    if (
      isDmRoomCode(room) ||
      (await this.ctx.storage.get<string>('code')) !== room ||
      (await this.ctx.storage.get<boolean>('closed')) === true
    )
      return null;
    this.ensureGroupMembership();
    if (!(await this.registerAccountRoom(room, account))) return null;
    const membership = activeGroupMember(this.sql, account);
    if (!membership) return null;
    this.ensureDmReadState();
    const row = latestVisibleMessage(this.sql, account);
    const body = row
      ? (JSON.parse(row.body as string) as { x?: string; m?: { kind?: string } })
      : null;
    const preview = (
      (row && isRecalledBody(row.body) ? '消息已撤回' : '') ||
      body?.x ||
      (body?.m?.kind === 'image' ? '[图片]' : body?.m?.kind === 'audio' ? '[语音]' : '')
    )
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    return {
      room,
      lastMessageAt: row ? Number(row.ts) : null,
      preview,
      ...dmReadState(this.sql, account),
      membershipVersion: membership.version,
    };
  }
  async groupMarkRead(
    room: string,
    account: string,
    version: number,
    sequence: number | string,
  ): Promise<boolean> {
    if (
      isDmRoomCode(room) ||
      (await this.ctx.storage.get<string>('code')) !== room ||
      (await this.ctx.storage.get<boolean>('closed')) === true
    )
      return false;
    this.ensureGroupMembership();
    if (!(await this.registerAccountRoom(room, account))) return false;
    if (!activeGroupMember(this.sql, account, version)) return false;
    this.ensureDmReadState();
    const resolved =
      typeof sequence === 'string'
        ? this.sql
            .exec(
              'SELECT s.sequence FROM message_sequences s JOIN messages m ON m.id=s.message_id WHERE m.id=?',
              sequence,
            )
            .toArray()[0]?.sequence
        : sequence;
    return typeof resolved === 'number' && advanceDmRead(this.sql, account, resolved);
  }

  async dmSummary(room: string, since: number): Promise<DmSummary> {
    const last = this.sql.exec('SELECT MAX(ts) AS ts FROM messages').one().ts;
    const unread = this.sql.exec('SELECT COUNT(*) AS n FROM messages WHERE ts > ?', since).one().n;
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
    const remaining = this.ctx.getWebSockets().filter((w) => w !== ws);
    // A socket replaced by the same peer's new connection leaves nobody behind.
    const replaced =
      !!att &&
      remaining.some((socket) => {
        try {
          return (socket.deserializeAttachment() as Attachment | null)?.peerId === att.peerId;
        } catch {
          return false;
        }
      });
    if (att && !replaced) {
      this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
      this.peerSnapshots.delete(att.peerId);
      for (const pending of [...this.pendingAgentCommands.values()])
        if (pending.peerId === att.peerId) pending.settle({ ok: false, message: '对方已离开' });
    }
    if (remaining.length === 0) {
      // Keep the first empty instant stable across duplicate close/error callbacks.
      if ((await this.ctx.storage.get<number>('idleSince')) === undefined) {
        await this.ctx.storage.put('idleSince', Date.now());
      }
      await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
    }
    await this.reportLobby(remaining.length);
  }

  /**
   * Seed the group's durable settings from the very first hello, and only that one.
   *
   * `public` used to be applied from every hello, which meant any joiner could publish a
   * private group to the lobby just by asking. It is a setting now, changed through the
   * `group` frame with the owner key. The first hello still seeds it because that is the
   * only signal a client too old to know about ownership can send when it creates a group.
   */
  private async seedSettings(msg: Record<string, unknown>): Promise<boolean> {
    if ((await this.ctx.storage.get<boolean>('public')) !== undefined) return true;
    if (!validGroupName(msg.roomName)) return false;
    await this.ctx.storage.put({
      public: msg.public === true,
      roomName: msg.roomName.trim(),
    });
    return true;
  }

  /** Internal RPC: legacy lobby rows supply the last report until an idle timestamp exists. */
  async recycleIdleRoom(lastReport: number): Promise<boolean> {
    const code = await this.code();
    if (!code || isDmRoomCode(code)) return false;
    const count = this.ctx.getWebSockets().length;
    if (count > 0) {
      // Correct stale legacy lobby reports so occupied rows cannot starve later sweep batches.
      await this.reportLobby(count);
      return false;
    }
    const idleSince = (await this.ctx.storage.get<number>('idleSince')) ?? lastReport;
    if (Date.now() - idleSince < ROOM_IDLE_MS) return false;
    await this.env.ROOM_INDEX?.get(this.env.ROOM_INDEX.idFromName('all-rooms')).tombstone(
      code,
      'group',
      'expired',
    );
    // Close admission before external I/O; retries continue cleanup without reopening the code.
    await this.ctx.storage.put({ closed: true, idleSince });
    this.ensureGroupMembership();
    this.sql.exec(
      "UPDATE group_memberships SET state='removed',version=version+1,updated_at=? WHERE state='active'",
      Date.now(),
    );
    await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
    await this.pushLobby(0, false);
    const objects = await listRoomMedia(this.env, code);
    for (let i = 0; i < objects.length; i += 1000) {
      await deleteRoomMedia(
        this.env,
        code,
        objects.slice(i, i + 1000).map((object) => object.id),
      );
    }
    this.sql.exec('DELETE FROM messages');
    await this.ensureRoomAgents();
    clearRoomAgents(this.sql);
    await this.ctx.storage.delete([
      'additionalAgents',
      'ownerKeyHash',
      'ownerAccountId',
      'agent',
      'agentBillingMode',
      'hostPeerId',
      'hostAccountId',
      'roomName',
      'public',
    ]);
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  /**
   * Bind the group to an owner account when it has none yet. Runs only after the hello
   * passed membership admission, so the owner is always an active signed-in member.
   * Returns 'new' for a group created by this hello, 'legacy' when an older group got its
   * first owner, or null when nothing changed.
   */
  private async bindOwnerIfNeeded(
    code: string,
    msg: Record<string, unknown>,
    accountId: string | undefined,
  ): Promise<'new' | 'legacy' | null> {
    const ownerAccountId = (await this.ctx.storage.get<string>('ownerAccountId')) ?? null;
    const ownerKeyHash = (await this.ctx.storage.get<string>('ownerKeyHash')) ?? null;
    const owner = await resolveGroupOwner({
      code,
      ownerAccountId,
      ownerKeyHash,
      senderAccountId: accountId,
      claim: msg.claim === true,
      presentedKey: msg.ownerKey,
    });
    if (!owner) return null;
    await this.ctx.storage.put('ownerAccountId', owner);
    // The browser key was only a bridge to an account owner; it grants nothing from now on.
    if (ownerKeyHash) await this.ctx.storage.delete('ownerKeyHash');
    return msg.claim === true ? 'new' : 'legacy';
  }

  private async canAdminister(
    code: string,
    senderAccountId: string | undefined,
    presentedKey: unknown,
  ): Promise<boolean> {
    return canAdministerGroup({
      code,
      ownerAccountId: (await this.ctx.storage.get<string>('ownerAccountId')) ?? null,
      senderAccountId,
      ownerKeyHash: (await this.ctx.storage.get<string>('ownerKeyHash')) ?? null,
      presentedKey,
    });
  }

  private async groupFrame(
    code: string,
    extra: { owned?: boolean; isOwner?: boolean },
  ): Promise<WireGroup> {
    const frame: WireGroup = {
      t: 'group',
      code,
      name: (await this.ctx.storage.get<string>('roomName')) ?? '',
      public: (await this.ctx.storage.get<boolean>('public')) === true,
      // Every group keeps its full history now; older clients read this to hide their upgrade prompt.
      persistentHistory: true,
    };
    if (extra.owned !== undefined) frame.owned = extra.owned;
    if (extra.isOwner !== undefined) frame.isOwner = extra.isOwner;
    return frame;
  }

  private accountRevoked(account: string): boolean {
    this.ensureGroupMembership();
    return (
      this.sql
        .exec('SELECT 1 AS revoked FROM group_account_revocations WHERE account_id=?', account)
        .toArray().length > 0
    );
  }
  private async registerAccountRoom(room: string, account: string): Promise<boolean> {
    this.ensureGroupMembership();
    if (this.accountRevoked(account) || !this.env.ACCOUNT_REGISTRY) return false;
    try {
      const registry = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName(account));
      const result = await registry.registerGroup(
        account,
        room,
        groupMembership(this.sql, account) !== null,
      );
      if (!result.allowed) {
        await this.revokeGroupAccount(room, account, result.deletionId ?? 'account-revoked');
        if (result.deletionId)
          await this.env.ACCOUNT_REGISTRY.get(
            this.env.ACCOUNT_REGISTRY.idFromName(account),
          ).acknowledge(account, result.deletionId, room);
        return false;
      }
      return !this.accountRevoked(account);
    } catch {
      return false;
    }
  }
  async revokeGroupAccount(room: string, account: string, deletionId: string): Promise<void> {
    if (isDmRoomCode(room)) throw new Error('group only');
    const stored = await this.code();
    if (stored && stored !== room) throw new Error('room mismatch');
    this.ensureGroupMembership();
    this.ensureDmReadState();
    this.sql.exec(
      'INSERT OR IGNORE INTO group_account_revocations(account_id,deletion_id,revoked_at) VALUES(?,?,?)',
      account,
      deletionId,
      Date.now(),
    );
    this.sql.exec(
      "UPDATE group_memberships SET state='removed',name='',version=version+1,updated_at=? WHERE account_id=? AND (state<>'removed' OR name<>'')",
      Date.now(),
      account,
    );
    this.sql.exec('DELETE FROM dm_read_cursors WHERE account_id=?', account);
    await this.releaseOwnership(account);
    await this.retireOwnerAgents(account);
    this.closeAccountSockets(account);
  }

  /**
   * A deleted or departed owner must not leave the group ownerless forever: clear the
   * binding so the next signed-in member to reconnect becomes the owner.
   */
  private async releaseOwnership(account: string): Promise<void> {
    if ((await this.ctx.storage.get<string>('ownerAccountId')) === account)
      await this.ctx.storage.delete('ownerAccountId');
  }
  /**
   * Extends a live socket's admission with a freshly minted ticket for the same account
   * (and, for a DM, the same conversation). Closing and reopening the socket every lease
   * period instead would drop presence and lose unsent frames.
   * Any ticket that does not prove the same identity leaves the lease to expire normally.
   */
  private async renewSocketLease(
    ws: WebSocket,
    att: Attachment,
    dm: boolean,
    ticket: unknown,
  ): Promise<void> {
    if (typeof ticket !== 'string' || ticket.length > 4096 || !att.accountId) return;
    const now = Date.now();
    let expiresAt: number;
    if (dm) {
      const auth = await authorizeDmUpgrade({ secret: this.env.DM_TICKET_SECRET, ticket, now });
      if (
        !auth.ok ||
        auth.code !== (await this.code()) ||
        auth.self !== att.accountId ||
        auth.peer !== att.dmPeerAccountId ||
        dmTicketRevoked(auth.iat, await this.ctx.storage.get<number>('revokedAt'))
      )
        return;
      expiresAt = auth.exp;
    } else {
      const auth = await authorizeDmToken({
        secret: this.env.DM_TICKET_SECRET,
        token: ticket,
        audience: 'chat',
        now,
      });
      if (!auth.ok || auth.claims.sub !== att.accountId) return;
      if (!(await this.registerAccountRoom(await this.code(), att.accountId))) {
        ws.close(1008, 'account revoked');
        return;
      }
      expiresAt = auth.claims.exp;
    }
    if (!this.socketLeaseAlive(ws)) return;
    const current = ws.deserializeAttachment() as Attachment;
    current.expiresAt = Math.max(
      current.expiresAt ?? 0,
      Math.min(expiresAt, now + SOCKET_LEASE_MS),
    );
    ws.serializeAttachment(current);
    await this.scheduleSocketAlarm();
  }

  private socketLeaseAlive(ws: WebSocket): boolean {
    const att = ws.deserializeAttachment() as Attachment | null;
    const expiry = att?.expiresAt;
    if (
      !att?.leaseClosed &&
      typeof expiry === 'number' &&
      Number.isSafeInteger(expiry) &&
      expiry > Date.now()
    )
      return true;
    try {
      if (att) ws.serializeAttachment({ ...att, leaseClosed: true });
      ws.close(1008, 'admission expired; reconnect');
    } catch {
      /* closed */
    }
    return false;
  }
  private sendAuthorized(ws: WebSocket, payload: string): void {
    if (this.socketLeaseAlive(ws)) ws.send(payload);
  }
  private async scheduleSocketAlarm(): Promise<void> {
    const now = Date.now();
    const deadlines = this.ctx.getWebSockets().flatMap((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.leaseClosed) return [];
      return [typeof att?.expiresAt === 'number' ? Math.max(now + 1, att.expiresAt) : now + 1];
    });
    await this.ctx.storage.setAlarm(Math.min(now + ROOM_GRACE_MS, ...deadlines));
  }

  private closeAccountSockets(account: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      if ((socket.deserializeAttachment() as Attachment | null)?.accountId === account) {
        try {
          socket.serializeAttachment({ ...socket.deserializeAttachment(), leaseClosed: true });
        } catch {
          /* legacy attachment */
        }
        try {
          socket.send(JSON.stringify({ t: 'sys', kind: 'membership-revoked' }));
        } catch {
          /* notification is best effort; closure must still be attempted */
        }
        try {
          socket.close(1008, 'membership revoked');
        } catch {
          /* already closed */
        }
      }
    }
  }

  private broadcast(payload: unknown, except?: WebSocket): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        this.sendAuthorized(ws, data);
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
          this.sendAuthorized(ws, data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private echoStoredMessage(ws: WebSocket, id: string, fromId: string): void {
    const row = this.sql
      .exec('SELECT id,from_id,name,body,ts FROM messages WHERE id=? AND from_id=?', id, fromId)
      .toArray()[0] as
      { id: string; from_id: string; name: string; body: string; ts: number } | undefined;
    if (!row) return;
    let body: {
      x?: string;
      m?: WireChat['m'];
      mentions?: WireChat['mentions'];
      replyToId?: string;
    };
    try {
      body = JSON.parse(row.body);
    } catch {
      return;
    }
    if (isRecalledBody(row.body)) {
      this.sendAuthorized(
        ws,
        JSON.stringify({
          t: 'chat',
          id: row.id,
          _from: row.from_id,
          n: row.name,
          ts: row.ts,
          recalled: true,
        }),
      );
      return;
    }
    this.sendAuthorized(
      ws,
      JSON.stringify({
        t: 'chat',
        id: row.id,
        _from: row.from_id,
        n: row.name,
        x: body.x,
        m: body.m,
        mentions: body.mentions,
        replyTo: resolveMessageReply(this.sql, body.replyToId),
        ts: row.ts,
      }),
    );
  }

  private saveMessage(chat: WireChat): boolean {
    return (
      this.sql
        .exec(
          'INSERT INTO messages (id, from_id, name, body, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id',
          chat.id,
          chat._from ?? '',
          chat.n,
          JSON.stringify({
            x: chat.x,
            m: chat.m,
            mentions: chat.mentions,
            replyToId: chat.replyTo?.id,
          }),
          chat.ts,
        )
        .toArray().length > 0
    );
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

  /**
   * Create the AI table on first use and move a pre-ownership AI into it. That AI goes to the
   * group's owner, who pays for it from now on; until the group has an owner it stays stored.
   */
  private async ensureRoomAgents(): Promise<void> {
    if (this.roomAgentsReady) return;
    initializeRoomAgents(this.sql);
    const primary = (await this.ctx.storage.get<NamedRoomAgent>('agent')) ?? null;
    const additional = (await this.ctx.storage.get<NamedRoomAgent[]>('additionalAgents')) ?? [];
    const legacy = primary
      ? { name: primary.name, persona: primary.persona, id: LEGACY_ROOM_AGENT_ID }
      : (additional[0] ?? null);
    const ownerAccount = (await this.ctx.storage.get<string>('ownerAccountId')) ?? null;
    this.ensureGroupMembership();
    const owner =
      ownerAccount && activeGroupMember(this.sql, ownerAccount)
        ? {
            account: ownerAccount,
            name: String(
              this.sql
                .exec('SELECT name FROM group_memberships WHERE account_id=?', ownerAccount)
                .toArray()[0]?.name ?? '',
            ),
          }
        : null;
    if (legacy && !migrateLegacyAgent(this.sql, legacy, owner, Date.now())) return;
    if (legacy)
      await this.ctx.storage.delete([
        'agent',
        'additionalAgents',
        'agentBillingMode',
        'hostPeerId',
        'hostAccountId',
      ]);
    this.roomAgentsReady = true;
  }

  private async roomAgents(): Promise<RoomAgentRecord[]> {
    await this.ensureRoomAgents();
    return listRoomAgents(this.sql);
  }

  private async agentFrame(): Promise<WireAgent> {
    const agents = wireRoomAgents(await this.roomAgents());
    const first = agents[0];
    return {
      t: 'agent',
      agents,
      agent: first ? { name: first.name, persona: first.persona } : null,
      host: '',
      billingMode: 'managed',
    };
  }

  /** The member is gone from the group, so is every AI they brought. */
  private async retireOwnerAgents(account: string): Promise<void> {
    await this.ensureRoomAgents();
    if (removeOwnerAgents(this.sql, account)) this.broadcast(await this.agentFrame());
  }

  /** A saved human message that @-mentions an AI starts that AI's turn, paid by its owner. */
  private async startAgentTurn(chat: WireChat, requester: string): Promise<void> {
    if (
      !chat.mentions?.some(
        (mention) => typeof mention?.peerId === 'string' && mention.peerId.startsWith('ai:'),
      )
    )
      return;
    const agents = await this.roomAgents();
    const agentId = firstMentionedAgent(chat.mentions, agents);
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return;
    if (agentOverDailyCap(this.sql, agent, Date.now())) {
      this.agentNotice(agent, requester, chat.id, '今日额度已用完', '今天的群 AI 额度已用完');
      return;
    }
    this.ensureRoomAgentTurns();
    const grantId = claimRoomAgentTurn(this.sql, chat.id, agent.id, agents, Date.now());
    if (!grantId) return;
    this.ctx.waitUntil(
      this.runManagedGroupTurn(chat.id, agent, requester, grantId).catch(() => {
        this.agentNotice(
          agent,
          requester,
          chat.id,
          '暂时无法回复，请稍后再 @',
          '群 AI 未完成，请查看 Credit 账本',
        );
      }),
    );
  }

  /**
   * Tell the member who asked why the AI stayed silent, and its owner the real reason. A
   * failure is never written into the conversation.
   */
  private agentNotice(
    agent: RoomAgentRecord,
    requester: string,
    triggerId: string,
    forRequester: string,
    forOwner: string,
  ): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const account = (socket.deserializeAttachment() as Attachment | null)?.accountId;
        const message =
          account === agent.owner
            ? `「${agent.name}」${forOwner}`
            : account === requester
              ? `「${agent.name}」${forRequester}`
              : null;
        if (message)
          this.sendAuthorized(
            socket,
            JSON.stringify({ t: 'agent-run-status', triggerId, roleId: agent.id, message }),
          );
      } catch {
        /* The notice is private and best effort; the durable billing state remains authoritative. */
      }
    }
  }

  /** Members whose fresh report allows this AI, still connected and still in the group. */
  private agentTargetsFor(agentId: string): AgentTarget[] {
    return agentTargets(this.peerSnapshots, agentId, Date.now(), (peerId, account) =>
      this.ctx.getWebSockets().some((socket) => {
        try {
          const att = socket.deserializeAttachment() as Attachment | null;
          return (
            att?.peerId === peerId &&
            att.accountId === account &&
            !att.leaseClosed &&
            (att.expiresAt === undefined || att.expiresAt > Date.now()) &&
            activeGroupMember(this.sql, account, att.membershipVersion ?? -1)
          );
        } catch {
          return false;
        }
      }),
    );
  }

  /**
   * Send one command to the target's device and wait for its own verdict. The device checks
   * its consent, lease and limits; silence is reported as silence, never as success.
   */
  private sendAgentCommand(
    agent: RoomAgentRecord,
    target: AgentTarget,
    command: Record<string, unknown>,
  ): Promise<AgentCommandOutcome> {
    const rid = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ ok: false, message: '对方设备没有回应' }),
        AGENT_ACK_TIMEOUT_MS,
      );
      const settle = (outcome: AgentCommandOutcome) => {
        clearTimeout(timer);
        this.pendingAgentCommands.delete(rid);
        resolve(outcome);
      };
      this.pendingAgentCommands.set(rid, { peerId: target.peerId, settle });
      this.sendTo(target.peerId, {
        t: 'cmd',
        to: target.peerId,
        ...command,
        rid,
        _from: `ai:${agent.id}`,
      });
    });
  }

  /**
   * The RoomDO alone builds the paid requests; browsers never receive a signed billing ticket.
   * A turn is at most MAX_GROUP_AI_ROUNDS model calls, each reserved and settled on its own
   * and each counted against the owner's daily cap; device tools run between them.
   */
  private async runManagedGroupTurn(
    triggerId: string,
    agent: RoomAgentRecord,
    requester: string,
    grantId: string,
  ): Promise<void> {
    const room = await this.code();
    const owner = agent.owner;
    const current = async () =>
      (await this.ctx.storage.get<boolean>('closed')) !== true &&
      (await this.roomAgents()).some(
        (role) =>
          role.id === agent.id &&
          role.owner === owner &&
          role.name === agent.name &&
          role.persona === agent.persona,
      ) &&
      managedRoomAgentTurnCurrent(this.sql, triggerId, agent.id, agent, grantId, owner, Date.now());
    const notice = (forRequester: string, forOwner: string) =>
      this.agentNotice(agent, requester, triggerId, forRequester, forOwner);
    if (!room || !(await current())) return;
    if (!this.env.LLM) {
      notice('暂时无法回复', '群 AI 服务暂不可用');
      return;
    }
    const targets = this.agentTargetsFor(agent.id);
    const base = managedGroupPrompt(this.sql, triggerId, agent, targets);
    if (!base) return;
    const messages: GroupChatMessage[] = [...base.messages];
    const actions: string[] = [];
    let answer: string | null = null;
    // Set once the turn has ended early and already told whoever needs telling.
    let stopped = false;
    for (let round = 0; round < MAX_GROUP_AI_ROUNDS && !stopped; round++) {
      if (round > 0 && agentOverDailyCap(this.sql, agent, Date.now())) {
        notice('今日额度已用完', '今天的群 AI 额度已用完，后续操作没有继续');
        stopped = true;
        break;
      }
      const last = round === MAX_GROUP_AI_ROUNDS - 1;
      const payload = {
        ...base,
        messages,
        // The last call may only talk: it reports what the tools did, it cannot do more.
        ...(base.tools && last ? { tool_choice: 'none' } : {}),
      };
      const body = JSON.stringify(payload);
      const { ticket, reservationKey } = await signGroupAiTicket(this.env.DM_TICKET_SECRET, {
        payer: owner,
        room,
        triggerId,
        roleId: agent.id,
        grantId,
        modelId: payload.model,
        bodyHash: await sha256Body(body),
        ...(agent.characterId ? { characterId: agent.characterId } : {}),
        ...(round ? { round } : {}),
      });
      // Recheck after ticket creation too: no paid request after a removal or persona change.
      if (!(await current())) {
        stopped = true;
        break;
      }
      let response: Response;
      try {
        response = await this.env.LLM.fetch(
          new Request('https://llm.0xnullai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': reservationKey,
              'X-0xNullAI-Group-Ticket': ticket,
            },
            body,
          }),
        );
      } catch {
        notice('暂时无法回复，请稍后再 @', '模型连接失败，请查看 Credit 账本');
        stopped = true;
        break;
      }
      let result: { credit_charged?: unknown; billing_status?: unknown; choices?: unknown } | null;
      try {
        result = (await response.json()) as typeof result;
      } catch {
        result = null;
      }
      if (typeof result?.credit_charged === 'number')
        recordAgentSpend(this.sql, agent.id, result.credit_charged, Date.now());
      if (!response.ok || typeof result?.credit_charged !== 'number') {
        notice(
          '暂时无法回复',
          response.status === 402
            ? 'Credit 不足，没有回复'
            : response.status === 401
              ? '对应的角色已删除或账号不可用，请撤出这个 AI'
              : result?.billing_status === 'pending' || result?.billing_status === 'unknown'
                ? '账务待核对，请查看 Credit 账本'
                : '暂时无法回复',
        );
        stopped = true;
        break;
      }
      const calls = last ? [] : managedGroupToolCalls(result, MAX_TOOL_CALLS_PER_ROUND);
      if (calls.length === 0 || !base.tools) {
        answer = managedGroupAnswer(result, actions.length > 0);
        break;
      }
      const said = (result.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
        ?.message?.content;
      messages.push({
        role: 'assistant',
        content: typeof said === 'string' ? said : '',
        tool_calls: calls,
      });
      for (const call of calls) {
        let outcome: AgentCommandOutcome;
        const planned = toolCommand(call, targets);
        if (!planned.ok) outcome = { ok: false, message: planned.message };
        else if (!(await current())) {
          stopped = true;
          outcome = { ok: false, message: '这次请求已失效' };
        } else {
          // Consent may have been withdrawn since the turn began; ask the live reports again.
          const live = this.agentTargetsFor(agent.id).find(
            (candidate) => candidate.peerId === planned.target.peerId,
          );
          outcome = live
            ? await this.sendAgentCommand(agent, live, planned.command)
            : { ok: false, message: '对方已撤销授权或离开' };
          if (outcome.ok) actions.push(planned.summary);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `${outcome.ok ? '成功' : '未执行'}：${outcome.message}`,
        });
      }
    }
    // What really happened on someone's device is always published, even without a reply.
    const record = actions.length ? `〔已操作〕${actions.join('；')}` : '';
    const text = [answer, record].filter(Boolean).join('\n\n');
    if (!text) {
      if (!stopped)
        notice('没有生成可发送的回复，可以换个说法再 @', '没有生成可发送的回复，本次已结算');
      return;
    }
    if (!actions.length && !(await current())) {
      notice('已离开或设置已改变', '已离开或设置已改变，已结算的回复未发送');
      return;
    }
    const chat: WireChat = {
      id: crypto.randomUUID(),
      _from: `ai:${agent.id}`,
      n: agent.name,
      x: text.slice(0, 4000),
      ts: this.nextMessageTs(),
    };
    const accepted = this.ctx.storage.transactionSync(() => {
      if (
        !managedRoomAgentTurnCurrent(
          this.sql,
          triggerId,
          agent.id,
          agent,
          grantId,
          owner,
          Date.now(),
        ) ||
        !this.saveMessage(chat)
      )
        return false;
      completeRoomAgentTurn(this.sql, triggerId, agent.id, chat.id);
      this.sql.exec(
        'UPDATE message_sequences SET sender_account=? WHERE message_id=?',
        `agent:ai:${agent.id}`,
        chat.id,
      );
      return true;
    });
    if (!accepted) return;
    this.broadcast({ t: 'chat', ...chat });
  }

  /** Only public groups touch the lobby, so a private group stays entirely invisible to it. */
  private async reportLobby(count: number): Promise<void> {
    const isPublic = await this.ctx.storage.get<boolean>('public');
    if (!isPublic || (await this.ctx.storage.get<boolean>('closed'))) return;
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

/**
 * A browser cannot read the status of a refused WebSocket upgrade, so a plain 403/410 looked
 * like a network error and the client retried forever. Accept, say why, and close: the same
 * notices a live socket gets, which every client version already stops reconnecting on.
 */
function endedSocket(frame: object, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.send(JSON.stringify(frame));
  server.close(1008, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
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

function generateMediaToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Fixed-length random capabilities; compare every byte rather than a shared prefix. */
function mediaTokenEqual(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
