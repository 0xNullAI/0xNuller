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
  canCompleteRoomAgentTurn,
  claimRoomAgentTurn,
  completeRoomAgentTurn,
  initializeRoomAgentTurns,
  managedRoomAgentTurnCurrent,
} from './room-agent-turn';
import { managedGroupAnswer, managedGroupPrompt } from './managed-group-ai';
import { sha256Body, signGroupAiTicket } from '../../../workers/auth/src/group-ai-ticket';
// RoomDO: one instance per group (idFromName(roomCode)), and one per direct-message
// conversation (idFromName(dmRoomCode(a, b)) — see dm.ts).
// Responsibilities: WebSocket relay (replaces the public MQTT broker) + connection-level presence + chat history (SQLite) persistence and replay
//                   + durable ownership (an owner key hash, not a peerId) + owner-controlled lobby visibility
//                   + bounded retention (oldest messages and their R2 media dropped together) + idle media reconciliation.
//
// Groups expire after seven consecutive days without connections; DMs retain history.
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
  resolveGroupOwner,
  orphanMediaIds,
  type MediaStore,
  type MessageStore,
} from './group';
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
  ROOM_AGENT_ID,
  validRoomAgents,
  type NamedRoomAgent,
  MAX_ROOM_AGENT_NAME,
  MAX_ROOM_AGENT_PERSONA,
  type WireChat,
  type WireGroup,
  type RoomAgent,
  type RoomAgentBillingMode,
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
  agentTurnCapable?: boolean;
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
  private pushFlushing = false;
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
  // In-memory cache of the room agent (storage is the durable copy; reloaded lazily after hibernation wakes the DO).
  private agentCache: RoomAgent | null | undefined;
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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS push_outbox (
      message_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,
      sender_account_id TEXT NOT NULL,recipient_accounts TEXT NOT NULL,
      created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,lease_until INTEGER)`);
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
      return new Response('room closed', { status: 410 });
    }
    if (!isDmRoomCode(code) && (await this.recycleIdleRoom(Date.now()))) {
      return new Response('room expired', { status: 410 });
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
        return new Response('membership revoked', { status: 403 });
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
    for (const existing of this.ctx.getWebSockets()) {
      try {
        if ((existing.deserializeAttachment() as Attachment | null)?.peerId === peerId)
          return new Response('peer identity already connected', { status: 409 });
      } catch {
        /* stale socket without a usable attachment */
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
        // Server-only envelopes must never be relayed from another participant.
        return;
      case 'renew': {
        await this.renewSocketLease(ws, att, dm, msg.ticket);
        return;
      }
      case 'hello': {
        att.name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : '';
        att.agentTurnCapable = msg.agentTurns === true;
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
          // Nothing to seed, nobody to make owner, no host to elect and no lobby to appear in.
          // A DM has exactly one durable thing: its history.
          this.sendAuthorized(
            ws,
            JSON.stringify(
              readHistoryPage(this.sql, undefined, msg.historyPaging === true ? 100 : 1000),
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

        // Host = whoever currently runs the AI agent loop, and only that. It is a live role,
        // not ownership: the group outlives every peerId, so a host left over in storage from
        // a session that ended is reassigned to someone who is actually connected — otherwise
        // a permanent group would end up with a host nobody can be, and no agent would ever run.
        // The permanent discussion room has no host (pure open chat): don't assign one, and
        // clear any leftover.
        const assigned = await this.ensureHost(att.peerId, att.accountId);
        const host = assigned.host;
        const hostChanged = assigned.changed;

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
            readHistoryPage(this.sql, undefined, msg.historyPaging === true ? 100 : 1000),
          ),
        );
        this.sendAuthorized(
          ws,
          JSON.stringify({
            t: 'agent',
            agent: await this.getAgent(),
            agents: await this.getAgents(),
            host,
            billingMode: await this.agentBillingMode(),
          }),
        );
        this.sendAuthorized(ws, JSON.stringify(await this.groupFrame(code, { owned, isOwner })));
        if (assignedOwner === 'legacy') {
          // A legacy group just got its first account owner. Tell everyone, so the members
          // who are not the owner see why their settings controls are read-only.
          this.broadcast({ t: 'sys', kind: 'owner-assigned', name: att.name });
        }
        // Tell the other members that someone joined (and that the host moved, if it did).
        this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
        if (hostChanged) {
          this.broadcast(
            { t: 'agent', agent: await this.getAgent(), agents: await this.getAgents(), host },
            ws,
          );
        }
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'history-before': {
        const before = parseHistoryCursor(msg.before);
        if (before) this.sendAuthorized(ws, JSON.stringify(readHistoryPage(this.sql, before)));
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
            messages: searchHistory(this.sql, query),
          }),
        );
        return;
      }
      case 'agent-claim': {
        if (
          dm ||
          typeof msg.requestId !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(msg.requestId)
        )
          return;
        const agents = await this.getAgents();
        const host = await this.ctx.storage.get<string>('hostPeerId');
        const hostAccount = await this.ctx.storage.get<string>('hostAccountId');
        let grantId: string | null = null;
        if (
          (await this.agentBillingMode()) === 'host-byok' &&
          host === att.peerId &&
          att.accountId &&
          hostAccount === att.accountId &&
          activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1) &&
          this.socketLeaseAlive(ws)
        ) {
          this.ensureRoomAgentTurns();
          grantId = claimRoomAgentTurn(
            this.sql,
            msg.triggerId,
            msg.roleId,
            att.peerId,
            agents,
            Date.now(),
          );
        }
        this.sendAuthorized(
          ws,
          JSON.stringify({
            t: 'agent-claim-result',
            requestId: msg.requestId,
            grantId,
          }),
        );
        return;
      }
      case 'chat': {
        // The host may speak as the room agent (checked: sender=host and the room really has an agent).
        const aiAs = await this.aiSenderOk(att, msg.as);
        if (msg.as !== undefined && !aiAs) return;
        const currentAgent = aiAs
          ? (await this.getAgents()).find((agent) => `ai:${agent.id}` === aiAs)
          : null;
        const fromId = aiAs ?? att.peerId;
        const chat: WireChat = {
          id:
            typeof msg.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(msg.id)
              ? msg.id
              : crypto.randomUUID(),
          _from: fromId,
          replyTo: resolveMessageReply(this.sql, msg.replyToId),
          n: currentAgent?.name ?? att.name,
          x: msg.x as string | undefined,
          m: msg.m as WireChat['m'],
          mentions: msg.mentions as WireChat['mentions'],
          ts: Date.now(),
        };
        if (typeof chat.x !== 'undefined' && (typeof chat.x !== 'string' || chat.x.length > 32000))
          return;
        if (
          !dm &&
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;
        if (aiAs && (await this.ctx.storage.get<string>('hostPeerId')) !== att.peerId) return;
        if (aiAs && (await this.ctx.storage.get<string>('hostAccountId')) !== att.accountId) return;
        if (!this.socketLeaseAlive(ws)) return;
        if (aiAs) {
          this.ensureRoomAgentTurns();
          const accepted = this.ctx.storage.transactionSync(() => {
            const triggerId = msg.triggerId;
            const roleId = aiAs.slice(3);
            if (
              !canCompleteRoomAgentTurn(
                this.sql,
                triggerId,
                roleId,
                currentAgent ?? undefined,
                msg.grantId,
                att.peerId,
                Date.now(),
              ) ||
              !this.saveMessage(chat)
            )
              return false;
            completeRoomAgentTurn(this.sql, triggerId as string, roleId, chat.id);
            if (att.accountId && this.env.AUTH_PUSH) this.queueChatPush(chat, att, dm);
            return true;
          });
          if (!accepted) return;
        } else {
          const saved = this.ctx.storage.transactionSync(() => {
            if (!this.saveMessage(chat)) return false;
            if (att.accountId && this.env.AUTH_PUSH) this.queueChatPush(chat, att, dm);
            return true;
          });
          if (!saved) {
            // A retry of a message this sender already saved: confirm it to the sender only,
            // so a lost echo cannot leave the message pending forever or send it twice.
            this.echoStoredMessage(ws, chat.id, fromId);
            return;
          }
        }
        if (att.accountId || (!dm && aiAs))
          this.sql.exec(
            'UPDATE message_sequences SET sender_account=? WHERE message_id=?',
            !dm && aiAs ? `agent:${aiAs}` : att.accountId!,
            chat.id,
          );
        // Echo the saved message to the sender so a local optimistic copy can become
        // server-confirmed before it can trigger any billable room AI turn.
        this.broadcast({
          t: 'chat',
          ...chat,
          ...(!aiAs && att.accountId ? { _account: att.accountId } : {}),
        });
        if (!aiAs && att.accountId && this.env.AUTH_PUSH && this.ctx.waitUntil)
          this.ctx.waitUntil(this.flushPushOutbox().catch(() => undefined));
        if (!dm && !aiAs && att.accountId && (await this.agentBillingMode()) === 'managed') {
          const agents = await this.getAgents();
          const payer = att.accountId;
          const responders = [...new Set((chat.mentions ?? []).map((m) => m?.peerId))]
            .filter((id) => agents.some((agent) => id === `ai:${agent.id}`))
            .slice(0, 1);
          for (const sender of responders) {
            const role = agents.find((agent) => sender === `ai:${agent.id}`);
            if (!role) continue;
            this.ensureRoomAgentTurns();
            const grantId = claimRoomAgentTurn(
              this.sql,
              chat.id,
              role.id,
              'managed',
              agents,
              Date.now(),
            );
            if (grantId)
              this.ctx.waitUntil(
                this.runManagedGroupTurn(chat.id, role, payer, grantId).catch(() => {
                  this.managedTurnNotice(
                    payer,
                    chat.id,
                    role.id,
                    '群 AI 未完成，请查看 Credit 账本后再发送新的 @ 消息',
                  );
                }),
              );
          }
        }
        // After the broadcast, never before it: trimming must not add latency to delivery, and
        // it does nothing at all until the group is actually over the cap.
        await this.trimHistory();
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
        if (recalled.mediaId) {
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
        if (leaveGroupMembership(this.sql, att.accountId, att.membershipVersion, Date.now()))
          await this.releaseOwnership(att.accountId);
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
          if (action !== 'restore') this.closeAccountSockets(msg.accountId);
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
        // Promotion is one-way: a routine settings frame cannot silently erase old history.
        if (msg.persistentHistory === true) {
          await this.ctx.storage.put('persistentHistory', true);
          changed = true;
        }
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

      case 'agent': {
        // Owner-only. The agent's device commands are authorized as ai:room on the host's
        // authority, so whoever defines it must be the group's owner account.
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
        if (Object.hasOwn(msg, 'agents')) {
          if (!validRoomAgents(msg.agents)) {
            this.sendAuthorized(
              ws,
              JSON.stringify({
                t: 'agent-error',
                message: '每群最多 1 位 AI；名字 1–40、人设最多 4000 字符，原配置未更改',
              }),
            );
            return;
          }
          const agents = msg.agents.map(({ id, name, persona }) => ({
            id,
            name: name.trim(),
            persona,
          }));
          const primary = agents.find((a) => a.id === ROOM_AGENT_ID);
          this.agentCache = primary ? { name: primary.name, persona: primary.persona } : null;
          await this.ctx.storage.put({
            agent: this.agentCache,
            additionalAgents: agents.filter((a) => a.id !== ROOM_AGENT_ID),
          });
          const host = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
          this.broadcast({ t: 'agent', agent: this.agentCache, agents, host });
          return;
        }
        const raw = msg.agent as Record<string, unknown> | null | undefined;
        if (
          raw != null &&
          (typeof raw !== 'object' ||
            typeof raw.name !== 'string' ||
            !raw.name.trim() ||
            raw.name.trim().length > MAX_ROOM_AGENT_NAME ||
            typeof raw.persona !== 'string' ||
            raw.persona.length > MAX_ROOM_AGENT_PERSONA)
        ) {
          this.sendAuthorized(
            ws,
            JSON.stringify({
              t: 'agent-error',
              message: `房间 AI 名字须为 1–${MAX_ROOM_AGENT_NAME} 个字符，人设最多 ${MAX_ROOM_AGENT_PERSONA} 个字符；原配置未更改`,
            }),
          );
          return;
        }
        const next: RoomAgent | null = raw
          ? { name: (raw.name as string).trim(), persona: raw.persona as string }
          : null;
        this.agentCache = next;
        await this.ctx.storage.put({ agent: next, additionalAgents: [] });
        const host = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
        this.broadcast({ t: 'agent', agent: next, agents: await this.getAgents(), host });
        return;
      }

      case 'agent-billing': {
        if (dm || (msg.mode !== 'host-byok' && msg.mode !== 'managed')) return;
        const code = await this.code();
        if (!(await this.canAdminister(code, att.accountId, msg.ownerKey))) return;
        if (
          !att.accountId ||
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;
        await this.ctx.storage.put('agentBillingMode', msg.mode);
        this.broadcast({
          t: 'agent',
          agent: await this.getAgent(),
          agents: await this.getAgents(),
          host: (await this.ctx.storage.get<string>('hostPeerId')) ?? '',
          billingMode: msg.mode,
        });
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
        const aiAs = await this.aiSenderOk(att, msg.as);
        if (
          !dm &&
          att.accountId &&
          !activeGroupMember(this.sql, att.accountId, att.membershipVersion ?? -1)
        )
          return;
        if (!this.socketLeaseAlive(ws)) return;
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
    for (const socket of this.ctx.getWebSockets()) this.socketLeaseAlive(socket);
    await this.flushPushOutbox();
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
    if (
      code &&
      !isDmRoomCode(code) &&
      (!(await this.ctx.storage.get<boolean>('persistentHistory')) ||
        (await this.ctx.storage.get<boolean>('closed')) === true)
    ) {
      const idleSince = (await this.ctx.storage.get<number>('idleSince')) ?? Date.now();
      await this.ctx.storage.put('idleSince', idleSince);
      const pushDue = this.nextPushDue();
      await this.ctx.storage.setAlarm(Math.min(idleSince + ROOM_IDLE_MS, pushDue ?? Infinity));
    } else {
      const pushDue = this.nextPushDue();
      if (pushDue !== null) await this.ctx.storage.setAlarm(pushDue);
    }
  }

  /** Server-side push recheck after an event waited in Auth's FCM outbox. */
  async groupPushEligible(room: string, account: string): Promise<boolean> {
    if (isDmRoomCode(room) || (await this.code()) !== room) return false;
    if ((await this.ctx.storage.get<boolean>('closed')) === true) return false;
    this.ensureGroupMembership();
    return !this.accountRevoked(account) && Boolean(activeGroupMember(this.sql, account));
  }

  // -- Direct messages (RPC, called by the Worker) --

  /** Ensure an upload with no following chat frame still gets an orphan sweep. */
  async noteMediaUpload(code: string, token: string): Promise<void> {
    if (!(await this.authorizeMediaUpload(code, token))) throw new Error('media token expired');
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
    const row = this.sql
      .exec('SELECT body,ts FROM messages ORDER BY ts DESC,id DESC LIMIT 1')
      .toArray()[0];
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
    const row = this.sql
      .exec('SELECT body,ts FROM messages ORDER BY ts DESC,id DESC LIMIT 1')
      .toArray()[0];
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
    if (att) {
      this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
      await this.handoverHost(att.peerId, remaining, ws);
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
      persistentHistory: msg.persistentHistory === true,
    });
    return true;
  }

  /** Internal RPC: legacy lobby rows supply the last report until an idle timestamp exists. */
  async recycleIdleRoom(lastReport: number): Promise<boolean> {
    const code = await this.code();
    if (!code || isDmRoomCode(code)) return false;
    if (
      (await this.ctx.storage.get<boolean>('persistentHistory')) === true &&
      (await this.ctx.storage.get<boolean>('closed')) !== true
    )
      return false;
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
    await this.ctx.storage.delete([
      'additionalAgents',
      'ownerKeyHash',
      'ownerAccountId',
      'agent',
      'hostPeerId',
      'roomName',
      'public',
    ]);
    this.agentCache = null;
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
      persistentHistory: (await this.ctx.storage.get<boolean>('persistentHistory')) === true,
    };
    if (extra.owned !== undefined) frame.owned = extra.owned;
    if (extra.isOwner !== undefined) frame.isOwner = extra.isOwner;
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

  private capablePeerIds(sockets: WebSocket[]): Set<string> {
    const ids = new Set<string>();
    for (const socket of sockets) {
      try {
        const att = socket.deserializeAttachment() as Attachment | null;
        if (att?.peerId && att.agentTurnCapable) ids.add(att.peerId);
      } catch {
        /* socket without an attachment; ignore */
      }
    }
    return ids;
  }

  private socketAccountForPeer(sockets: WebSocket[], peerId: string): string {
    for (const socket of sockets) {
      try {
        const att = socket.deserializeAttachment() as Attachment | null;
        if (att?.peerId === peerId) return att.accountId ?? '';
      } catch {
        /* socket without an attachment; ignore */
      }
    }
    return '';
  }

  private async ensureHost(
    candidate: string,
    accountId?: string,
  ): Promise<{ host: string; changed: boolean }> {
    const stored = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
    const storedAccount = (await this.ctx.storage.get<string>('hostAccountId')) ?? '';
    const sockets = this.ctx.getWebSockets();
    const live = this.livePeerIds(sockets);
    const capable = this.capablePeerIds(sockets);
    const liveAccount = this.socketAccountForPeer(sockets, stored);
    if (
      stored &&
      live.has(stored) &&
      (!storedAccount || storedAccount === liveAccount) &&
      (!capable.has(candidate) || capable.has(stored))
    ) {
      if (!storedAccount) {
        if (liveAccount) await this.ctx.storage.put('hostAccountId', liveAccount);
      }
      return { host: stored, changed: false };
    }
    await this.ctx.storage.put({ hostPeerId: candidate, hostAccountId: accountId ?? '' });
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
    const next =
      [...this.capablePeerIds(remaining)][0] ?? [...this.livePeerIds(remaining)][0] ?? '';
    const nextAccount = this.socketAccountForPeer(remaining, next);
    await this.ctx.storage.put({ hostPeerId: next, hostAccountId: nextAccount });
    if (next)
      this.broadcast(
        { t: 'agent', agent: await this.getAgent(), agents: await this.getAgents(), host: next },
        except,
      );
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
   * period instead would rotate the host, drop in-flight AI turns and lose unsent frames.
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
    await this.ctx.storage.setAlarm(
      Math.min(now + ROOM_GRACE_MS, this.nextPushDue() ?? Infinity, ...deadlines),
    );
  }

  private queueChatPush(chat: WireChat, sender: Attachment, dm: boolean): void {
    const account = sender.accountId;
    if (!account) return;
    const recipients = dm
      ? sender.dmPeerAccountId && sender.dmPeerAccountId !== account
        ? [sender.dmPeerAccountId]
        : []
      : this.sql
          .exec(
            "SELECT account_id FROM group_memberships WHERE state='active' AND account_id<>? ORDER BY account_id",
            account,
          )
          .toArray()
          .map((row) => String(row.account_id));
    if (recipients.length === 0) return;
    for (let index = 0; index < recipients.length; index += 200) {
      this.sql.exec(
        `INSERT OR IGNORE INTO push_outbox(message_id,event_id,kind,target_id,sender_account_id,recipient_accounts,created_at,next_attempt_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        `${chat.id}:push:${index / 200}`,
        chat.id,
        dm ? 'dm' : 'group',
        dm ? account : (this.codeCache ?? ''),
        account,
        JSON.stringify(recipients.slice(index, index + 200)),
        chat.ts,
        chat.ts,
      );
    }
  }

  private nextPushDue(): number | null {
    const row = this.sql
      .exec('SELECT MIN(MAX(next_attempt_at,COALESCE(lease_until,0))) AS due FROM push_outbox')
      .toArray()[0];
    return typeof row?.due === 'number' ? row.due : null;
  }

  private async flushPushOutbox(): Promise<void> {
    if (this.pushFlushing || !this.env.AUTH_PUSH) return;
    this.pushFlushing = true;
    try {
      const now = Date.now();
      const rows = this.sql
        .exec(
          `SELECT message_id,event_id,kind,target_id,sender_account_id,recipient_accounts,created_at,attempts
         FROM push_outbox WHERE next_attempt_at<=? AND COALESCE(lease_until,0)<=?
         ORDER BY created_at LIMIT 20`,
          now,
          now,
        )
        .toArray();
      for (const row of rows) {
        const id = String(row.message_id);
        const claimed =
          this.sql
            .exec(
              `UPDATE push_outbox SET lease_until=? WHERE message_id=? AND next_attempt_at<=?
           AND COALESCE(lease_until,0)<=? RETURNING message_id`,
              now + 60_000,
              id,
              now,
              now,
            )
            .toArray().length > 0;
        if (!claimed) continue;
        const sender = String(row.sender_account_id);
        const intended = JSON.parse(String(row.recipient_accounts)) as string[];
        const recipients =
          row.kind === 'group'
            ? intended.filter(
                (account) => account !== sender && !!activeGroupMember(this.sql, account),
              )
            : ((await this.ctx.storage.get<number>('revokedAt')) ?? 0) >= Number(row.created_at)
              ? []
              : intended.filter((account) => account !== sender);
        try {
          if (recipients.length)
            await this.env.AUTH_PUSH.enqueueChatPush({
              kind: row.kind as 'dm' | 'group',
              targetId: String(row.target_id),
              eventId: String(row.event_id),
              senderAccountId: sender,
              recipientAccountIds: recipients,
            });
          this.sql.exec(
            'DELETE FROM push_outbox WHERE message_id=? AND lease_until=?',
            id,
            now + 60_000,
          );
        } catch {
          const attempts = Number(row.attempts) + 1;
          this.sql.exec(
            'UPDATE push_outbox SET attempts=?,lease_until=NULL,next_attempt_at=? WHERE message_id=? AND lease_until=?',
            attempts,
            now + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts - 1, 6)),
            id,
            now + 60_000,
          );
        }
      }
      const due = this.nextPushDue();
      if (due !== null) await this.scheduleSocketAlarm();
    } finally {
      this.pushFlushing = false;
    }
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

  /** Apply the retention cap, dropping each message's R2 media along with its row. */
  private async trimHistory(): Promise<string[]> {
    const code = await this.code();
    if (isDmRoomCode(code) || (await this.ctx.storage.get<boolean>('persistentHistory')) === true)
      return [];
    const messages: MessageStore = {
      count: () => Number(this.sql.exec('SELECT COUNT(*) AS n FROM messages').one().n),
      oldest: (n) =>
        this.sql
          .exec('SELECT id, body FROM messages ORDER BY ts ASC, id ASC LIMIT ?', n)
          .toArray()
          .map((r) => ({ id: r.id as string, mediaId: mediaIdOf(r.body as string) })),
      remove: (ids) => {
        for (const id of ids) this.sql.exec('DELETE FROM messages WHERE id = ?', id);
      },
    };
    const media: MediaStore = { delete: (ids) => deleteRoomMedia(this.env, code, ids) };
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

  private async getAgents(): Promise<NamedRoomAgent[]> {
    const primary = await this.getAgent();
    if (primary) return [{ ...primary, id: ROOM_AGENT_ID }];
    // Old rooms may only have an additional role. Keep the first stored identity
    // readable without re-enabling several AI participants or changing its sender ID.
    const additional = (await this.ctx.storage.get<NamedRoomAgent[]>('additionalAgents')) ?? [];
    return additional.slice(0, 1);
  }

  private async agentBillingMode(): Promise<RoomAgentBillingMode> {
    return (await this.ctx.storage.get<RoomAgentBillingMode>('agentBillingMode')) === 'managed'
      ? 'managed'
      : 'host-byok';
  }

  private managedTurnNotice(
    payer: string,
    triggerId: string,
    roleId: string,
    message: string,
  ): void {
    const data = JSON.stringify({ t: 'agent-run-status', triggerId, roleId, message });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        if ((socket.deserializeAttachment() as Attachment | null)?.accountId === payer)
          this.sendAuthorized(socket, data);
      } catch {
        /* The notice is private and best effort; the durable billing state remains authoritative. */
      }
    }
  }

  /** The RoomDO alone builds the paid request; browsers never receive its signed billing ticket. */
  private async runManagedGroupTurn(
    triggerId: string,
    agent: NamedRoomAgent,
    payer: string,
    grantId: string,
  ): Promise<void> {
    const room = await this.code();
    const hostPeerId = await this.ctx.storage.get<string>('hostPeerId');
    const hostAccountId = await this.ctx.storage.get<string>('hostAccountId');
    const current = async () =>
      (await this.agentBillingMode()) === 'managed' &&
      (await this.ctx.storage.get<boolean>('closed')) !== true &&
      (await this.ctx.storage.get<string>('hostPeerId')) === hostPeerId &&
      (await this.ctx.storage.get<string>('hostAccountId')) === hostAccountId &&
      (await this.getAgents()).some(
        (role) =>
          role.id === agent.id && role.name === agent.name && role.persona === agent.persona,
      ) &&
      managedRoomAgentTurnCurrent(this.sql, triggerId, agent.id, agent, grantId, payer, Date.now());
    if (!room || !(await current())) return;
    if (!this.env.LLM) {
      this.managedTurnNotice(payer, triggerId, agent.id, '群 AI 服务暂不可用');
      return;
    }
    const payload = managedGroupPrompt(this.sql, triggerId, agent);
    if (!payload) return;
    const body = JSON.stringify(payload);
    const { ticket, reservationKey } = await signGroupAiTicket(this.env.DM_TICKET_SECRET, {
      payer,
      room,
      triggerId,
      roleId: agent.id,
      grantId,
      modelId: payload.model,
      bodyHash: await sha256Body(body),
    });
    // Recheck after ticket creation too: no paid request after an owner edit or member removal.
    if (!(await current())) return;
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
      this.managedTurnNotice(
        payer,
        triggerId,
        agent.id,
        '模型连接失败，请查看 Credit 账本后再尝试新的 @ 消息',
      );
      return;
    }
    let result: { credit_charged?: unknown; billing_status?: unknown; choices?: unknown } | null;
    try {
      result = (await response.json()) as typeof result;
    } catch {
      result = null;
    }
    if (!response.ok || typeof result?.credit_charged !== 'number') {
      this.managedTurnNotice(
        payer,
        triggerId,
        agent.id,
        response.status === 402
          ? 'Credit 不足，群 AI 未调用模型'
          : result?.billing_status === 'pending' || result?.billing_status === 'unknown'
            ? '群 AI 账务待核对，请勿重试同一条 @ 消息'
            : '群 AI 暂时无法回复；请用新的 @ 消息重试',
      );
      return;
    }
    const answer = managedGroupAnswer(result);
    if (!answer) {
      this.managedTurnNotice(
        payer,
        triggerId,
        agent.id,
        '群 AI 没有生成可发送的回复，本次已结算；可以换个说法再 @ 一次',
      );
      return;
    }
    if (!(await current())) {
      this.managedTurnNotice(payer, triggerId, agent.id, '角色或群状态已改变，已结算的回复未发送');
      return;
    }
    const chat: WireChat = {
      id: crypto.randomUUID(),
      _from: `ai:${agent.id}`,
      n: agent.name,
      x: answer,
      ts: Date.now(),
    };
    const accepted = this.ctx.storage.transactionSync(() => {
      if (
        !managedRoomAgentTurnCurrent(
          this.sql,
          triggerId,
          agent.id,
          agent,
          grantId,
          payer,
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
      // Members who are not in the room learn about the AI reply the same way as about a
      // person's message. The member who asked is excluded; their own @ started it.
      if (this.env.AUTH_PUSH) this.queueChatPush(chat, { accountId: payer } as Attachment, false);
      return true;
    });
    if (!accepted) return;
    this.broadcast({ t: 'chat', ...chat });
    if (this.env.AUTH_PUSH && this.ctx.waitUntil)
      this.ctx.waitUntil(this.flushPushOutbox().catch(() => undefined));
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
   * Conditions: `as` matches the one active agent identity, the sender is the host,
   * and the room actually has an agent.
   */
  private async aiSenderOk(sender: Attachment, as: unknown): Promise<string | null> {
    if (typeof as !== 'string' || !as.startsWith('ai:')) return null;
    if ((await this.agentBillingMode()) === 'managed') return null;
    const host = await this.ctx.storage.get<string>('hostPeerId');
    const account = await this.ctx.storage.get<string>('hostAccountId');
    if (sender.peerId !== host || !sender.accountId || sender.accountId !== account) return null;
    return (await this.getAgents()).some((agent) => as === `ai:${agent.id}`) ? as : null;
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
