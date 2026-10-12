import type { OpossumVibrationPatternName } from '@dg-kit/core';
import type { GroupMembership } from '../../worker/wire';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { connectRoom, type RoomTransport, type TransportStatus } from '../lib/room-transport';
import {
  parseRoomCoyoteTargets,
  type ChatMessage,
  type ChatMedia,
  type ChatMention,
  type DeviceCommand,
  type MemberState,
  type CmdAction,
  type WaveformTransfer,
  type StateFast,
  type StateSlow,
} from '../lib/protocol';
import { type WireReply, type WireRoomAgent } from '../../worker/wire';
import {
  closeOwnedGroup,
  forgetGroup,
  loadOwnerKey,
  rememberGroup,
  saveOwnerKey,
} from '../lib/groups';
import {
  currentAuthUserId,
  subscribeAuthChanges,
  dmTicket,
  getChatTicket,
  getGroupAgentTicket,
} from '@0xnullai/auth';

const OPOSSUM_PATTERNS: readonly OpossumVibrationPatternName[] = [
  'constant',
  'pulse',
  'wave',
  'ramp',
  'heartbeat',
];
function isOpossumPattern(value: unknown): value is OpossumVibrationPatternName {
  return OPOSSUM_PATTERNS.includes(value as OpossumVibrationPatternName);
}

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * Joining a direct message rather than a group.
 *
 * The conversation id is not in here on purpose — it comes back from the account service
 * with the first ticket, so the client never computes where a conversation lives.
 */
export interface DmJoinOptions {
  /** The other account. */
  peerUserId: string;
  /** The ticket already minted to learn the conversation id, spent on the first connect. */
  firstTicket?: string;
  firstExpiresAt?: number;
}

/** Options for creating/joining a group. Public groups get registered in the lobby. */
export interface JoinOptions {
  public?: boolean;
  roomName?: string;
  /**
   * Ask the server to mint an owner key for this group. Set only on the create path: it is
   * what makes the creator the durable owner, and it is ignored once a group already has one.
   */
  claim?: boolean;
  /**
   * Join a direct message instead. Every group field above is meaningless here and is not
   * sent: a DM has no owner, no lobby entry and no name of its own.
   */
  dm?: DmJoinOptions;
}

/**
 * Peer ids are new on every page load, so history from an earlier visit or another device
 * is recognised by the sender account the server attaches; the peer id covers frames from
 * a server that does not send it yet.
 */
function isOwnMessage(frame: Record<string, unknown>): boolean {
  const account = currentAuthUserId();
  return typeof frame._account === 'string' && account
    ? frame._account === account
    : frame._from === selfId;
}

/** One match from the server-side history search, newest first. */
export interface ChatSearchHit {
  id: string;
  senderName: string;
  fromSelf: boolean;
  text: string;
  timestamp: number;
}

const SEARCH_TIMEOUT_MS = 8000;

/** Without the server echo by then, a sent message is shown as failed with a retry. */
const SEND_CONFIRM_TIMEOUT_MS = 15_000;

/** How much of a ticket's life has to be left for it to be worth spending on a connect. */
const TICKET_MIN_REMAINING_MS = 5000;

/**
 * Supply an admission ticket for each (re)connect.
 *
 * The first one was already minted by the caller — that is how it learned the conversation
 * id — so spending it saves a round trip on open. Everything after that is minted fresh,
 * which is the mechanism that re-checks the mutual follow: once the other person blocks or
 * unfollows you, the account service stops answering and the reconnect has nothing to
 * present.
 */
function dmTicketProvider(dm: DmJoinOptions): () => Promise<string | null> {
  let unspent = dm.firstTicket ?? null;
  const expiresAt = dm.firstExpiresAt ?? 0;
  return async () => {
    const first = unspent;
    unspent = null;
    if (first && expiresAt > Date.now() + TICKET_MIN_REMAINING_MS) return first;
    return (await dmTicket(dm.peerUserId))?.ticket ?? null;
  };
}

function chatTicketProvider(): () => Promise<string | null> {
  return async () => (await getChatTicket().catch(() => null))?.ticket ?? null;
}

/** A media reference already uploaded to R2, waiting to be sent with a chat message. */
export interface OutgoingMedia {
  kind: 'image' | 'audio';
  id: string;
  mime: string;
  size: number;
  durationMs?: number;
  w?: number;
  h?: number;
}

/** A media reference as it appears on the wire (from the DO / history replay). */
interface WireMedia {
  kind: 'image' | 'audio';
  id: string;
  mime: string;
  size: number;
  durationMs?: number;
  w?: number;
  h?: number;
}

const PRESENCE_INTERVAL_MS = 3000;
const PRESENCE_TIMEOUT_MS = 10000;
const FAST_THROTTLE_MS = 200;

/** An 8-character random ID (used for message ids). */
function shortId(): string {
  const arr = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const byte of arr) s += byte.toString(36).padStart(2, '0').slice(-1);
  const tail = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  return s + tail.toString(36).padStart(2, '0');
}

function generatePeerId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = '';
  const arr = crypto.getRandomValues(new Uint8Array(20));
  for (const byte of arr) id += chars[byte % 62] ?? '0';
  return id;
}

const selfId = generatePeerId();

/** wire mentions ({peerId,n}) → ChatMention ({peerId,displayName}). */
function mapMentions(m: unknown): ChatMention[] | undefined {
  if (!Array.isArray(m)) return undefined;
  return (m as Array<{ peerId: string; n: string }>).map((x) => ({
    peerId: x.peerId,
    displayName: x.n,
  }));
}

/** Resolve an R2 media reference into a fetchable URL (same-origin /api/media/:code/:id). */
function buildMedia(room: string | null, m: WireMedia | undefined): ChatMedia | undefined {
  if (!m || !room) return undefined;
  return {
    kind: m.kind,
    objectId: m.id,
    url: `/api/media/${encodeURIComponent(room)}/${encodeURIComponent(m.id)}`,
    mime: m.mime,
    durationMs: m.durationMs,
    w: m.w,
    h: m.h,
  };
}

/**
 * Transport model (Cloudflare RoomDO, a single WebSocket):
 *
 * - State broadcasts owner→all: sf (strength/waveform/firing, throttled 200ms),
 *   ss (name/battery/queue/catalog, 5s heartbeat)
 * - Edge commands controller→owner: cmd (directed, to=peerId)
 * - Waveform transfer: wave (directed)
 * - presence: one heartbeat every 3s (carrying the nickname); nothing received
 *   for 10s means removePeer (the fallback for abnormal disconnects)
 * - Pushed by the DO: history (replayed on join), sys joined/left
 *   (connection-level presence, immediate)
 *
 * A single WS connection is ordered and reliable, so none of MQTT's
 * multi-broker fan-out / QoS / message dedup is needed.
 */
export interface RoomReadAdmission {
  account: string;
  room: string;
}
export function usePeerRoom(displayName: string) {
  const readAdmissionRef = useRef<RoomReadAdmission | null>(null);
  const [readAdmission, setReadAdmission] = useState<RoomReadAdmission | null>(null);
  const isReadAdmissionCurrent = useCallback(
    (candidate: RoomReadAdmission) => readAdmissionRef.current === candidate,
    [],
  );
  useEffect(() => {
    let previous = currentAuthUserId();
    return subscribeAuthChanges(() => {
      const current = currentAuthUserId();
      if (current !== previous) {
        readAdmissionRef.current = null;
        setReadAdmission(null);
      }
      previous = current;
    });
  }, []);

  const [status, setStatus] = useState<RoomStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [members, setMembers] = useState<Map<string, MemberState>>(new Map());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mediaUploadToken, setMediaUploadToken] = useState<string | null>(null);
  // —— Group AIs: each belongs to the member who brought it in and runs on the server ——
  const [agents, setAgentsState] = useState<WireRoomAgent[]>([]);
  // —— Group settings (durable, owner-controlled) ——
  const [isPublic, setIsPublic] = useState(false);
  const [historyBefore, setHistoryBefore] = useState<{ ts: number; id: string } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [groupMemberships, setGroupMemberships] = useState<GroupMembership[]>([]);
  const [groupName, setGroupName] = useState('');
  /** The group has an owner key on file at all (groups made by older clients do not). */
  /** This browser holds the key and the server accepted it. */
  const [isOwner, setIsOwner] = useState(false);
  /**
   * The account on the other end, when this connection is a direct message.
   *
   * Everything a DM does *not* have hangs off this being non-null on the client — but only
   * as a matter of not drawing dead controls. The server is what actually refuses a device
   * frame in a DM; hiding a button stops nobody who is not using the button.
   */
  const [dmPeerUserId, setDmPeerUserId] = useState<string | null>(null);

  const transportRef = useRef<RoomTransport | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const joinOptsRef = useRef<JoinOptions>({});
  const onCommandRef = useRef<((cmd: DeviceCommand, peerId: string) => void) | null>(null);
  const onWaveformRef = useRef<((transfer: WaveformTransfer, peerId: string) => void) | null>(null);
  const presenceTimerRef = useRef<number | null>(null);
  const peerTimersRef = useRef<Map<string, number>>(new Map());
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  const fastThrottleRef = useRef<{
    lastSent: number;
    pending: StateFast | null;
    timer: number | null;
  }>({
    lastSent: 0,
    pending: null,
    timer: null,
  });

  const setCommandHandler = useCallback((handler: (cmd: DeviceCommand, peerId: string) => void) => {
    onCommandRef.current = handler;
  }, []);

  const setWaveformHandler = useCallback(
    (handler: (transfer: WaveformTransfer, peerId: string) => void) => {
      onWaveformRef.current = handler;
    },
    [],
  );

  const removePeer = useCallback((peerId: string) => {
    setPeers((prev) => prev.filter((p) => p !== peerId));
    setMembers((prev) => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    const timer = peerTimersRef.current.get(peerId);
    if (timer) clearTimeout(timer);
    peerTimersRef.current.delete(peerId);
  }, []);

  const send = useCallback((payload: object) => {
    return transportRef.current?.send(payload) ?? false;
  }, []);

  /** Search requests awaiting their `search-result` frame. */
  const searchesRef = useRef(
    new Map<string, { resolve: (hits: ChatSearchHit[]) => void; timer: number }>(),
  );

  /** Outgoing chat frames awaiting the server echo, kept so a retry resends the same id. */
  const pendingSendsRef = useRef(new Map<string, { payload: object; timer: number }>());

  const clearPendingSend = useCallback((id: string) => {
    const pending = pendingSendsRef.current.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSendsRef.current.delete(id);
  }, []);

  const trackPendingSend = useCallback((id: string, payload: object) => {
    const previous = pendingSendsRef.current.get(id);
    if (previous) clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      if (!pendingSendsRef.current.has(id)) return;
      setMessages((current) =>
        current.map((message) =>
          message.id === id && !message.serverConfirmed
            ? { ...message, sendFailed: true }
            : message,
        ),
      );
    }, SEND_CONFIRM_TIMEOUT_MS);
    pendingSendsRef.current.set(id, { payload, timer });
  }, []);

  /** Close the connection and drop everything that belonged to that group. */
  const teardown = useCallback(() => {
    for (const pending of pendingSendsRef.current.values()) clearTimeout(pending.timer);
    pendingSendsRef.current.clear();
    readAdmissionRef.current = null;
    setReadAdmission(null);
    send({ t: 'leave' });

    if (presenceTimerRef.current) {
      clearInterval(presenceTimerRef.current);
      presenceTimerRef.current = null;
    }
    peerTimersRef.current.forEach((timer) => clearTimeout(timer));
    peerTimersRef.current.clear();
    if (fastThrottleRef.current.timer) {
      clearTimeout(fastThrottleRef.current.timer);
      fastThrottleRef.current = { lastSent: 0, pending: null, timer: null };
    }

    transportRef.current?.close();
    transportRef.current = null;
    roomIdRef.current = null;
    setStatus('idle');
    setError(null);
    setRoomId(null);
    setPeers([]);
    setMembers(new Map());
    setMessages([]);
    setHistoryBefore(null);
    setHistoryLoading(false);
    setMediaUploadToken(null);
    // Group-scoped state must go too, or the next group inherits the previous one's
    // AIs and settings for as long as it takes the new frames to arrive.
    setAgentsState([]);
    setIsOwner(false);
    setGroupMemberships([]);
    setIsPublic(false);
    setGroupName('');
    setDmPeerUserId(null);
  }, [send]);

  const join = useCallback(
    (roomCode: string, options?: JoinOptions) => {
      if (transportRef.current) {
        // Already here. A reconnect is the transport's job, not ours.
        if (roomIdRef.current === roomCode) return;
        // Switching groups. This used to be a bare early return, which made every entry in
        // the sidebar — and the create dialog — a no-op once you were connected to anything.
        teardown();
      }
      setStatus('connecting');
      setError(null);
      roomIdRef.current = roomCode;
      const account = currentAuthUserId();
      const admission = account ? { account, room: roomCode } : null;
      readAdmissionRef.current = admission;
      setReadAdmission(admission);
      joinOptsRef.current = options ?? {};
      const dm = options?.dm ?? null;
      setDmPeerUserId(dm?.peerUserId ?? null);
      // A conversation id is derived from two account ids and is not something to put in a
      // log; the room code of a group is public enough to be typed by hand.
      console.log('[DG-Chat] join', dm ? '(dm)' : roomCode, 'as', selfId);

      function touchPeer(peerId: string, name?: string) {
        if (peerId === selfId) return;
        setPeers((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
        const existing = peerTimersRef.current.get(peerId);
        if (existing) clearTimeout(existing);
        peerTimersRef.current.set(
          peerId,
          window.setTimeout(() => {
            removePeer(peerId);
          }, PRESENCE_TIMEOUT_MS),
        );
        if (name) {
          setMembers((prev) => {
            const cur = prev.get(peerId);
            if (cur && cur.displayName === name) return prev;
            const next = new Map(prev);
            next.set(peerId, { ...(cur ?? emptyMember(peerId)), displayName: name });
            return next;
          });
        }
      }

      function handleMessage(data: Record<string, unknown>) {
        const t = data.t as string;

        if (t === 'search-result') {
          const search = searchesRef.current.get(String(data.requestId));
          if (!search) return;
          searchesRef.current.delete(String(data.requestId));
          clearTimeout(search.timer);
          const list = Array.isArray(data.messages)
            ? (data.messages as Array<Record<string, unknown>>)
            : [];
          search.resolve(
            list.map((m) => ({
              id: String(m.id),
              senderName: typeof m.n === 'string' ? m.n : '',
              fromSelf: isOwnMessage(m),
              text: typeof m.x === 'string' ? m.x : '',
              timestamp: typeof m.ts === 'number' ? m.ts : 0,
            })),
          );
          return;
        }

        if (t === 'agent-run-status' || t === 'agent-error') {
          if (typeof data.message === 'string') setError(data.message.slice(0, 200));
          return;
        }

        if (t === 'membership-state') {
          setGroupMemberships(
            Array.isArray(data.members) ? (data.members as GroupMembership[]) : [],
          );
          return;
        }
        if (t === 'history') {
          const room = roomIdRef.current;
          const list = (data.messages as Array<Record<string, unknown>>) ?? [];
          const page: ChatMessage[] = list.map((m) => ({
            id: m.id as string,
            serverConfirmed: true,
            fromSelf: isOwnMessage(m),
            senderId: (m._from as string) ?? '',
            senderName: (m.n as string) ?? '',
            text: (m.x as string) ?? '',
            timestamp: (m.ts as number) ?? 0,
            media: buildMedia(room, m.m as WireMedia | undefined),
            mentions: mapMentions(m.mentions),
            replyTo: m.replyTo as WireReply | undefined,
            ...(m.recalled === true ? { recalled: true } : {}),
          }));
          for (const message of page) clearPendingSend(message.id);
          setMessages((previous) => {
            if (data.older === true)
              return [
                ...new Map([...page, ...previous].map((message) => [message.id, message])).values(),
              ].sort(
                (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
              );
            // A reconnect replays history. Unconfirmed local sends are not in it yet; keep
            // them (and their text) after the replay instead of silently dropping them.
            const replayed = new Set(page.map((message) => message.id));
            const unconfirmed = previous.filter(
              (message) =>
                message.fromSelf && !message.serverConfirmed && !replayed.has(message.id),
            );
            return [...page, ...unconfirmed];
          });
          const before = data.before as { ts?: unknown; id?: unknown } | null;
          setHistoryBefore(
            before && typeof before.ts === 'number' && typeof before.id === 'string'
              ? { ts: before.ts, id: before.id }
              : null,
          );
          setHistoryLoading(false);
          return;
        }

        if (t === 'media-auth') {
          setMediaUploadToken(typeof data.token === 'string' ? data.token : null);
          return;
        }

        if (t === 'sys') {
          if (data.kind === 'closed') {
            setError('群聊已解散');
            const code = roomIdRef.current;
            if (code) void closeOwnedGroup(code).finally(() => forgetGroup(code));
            return;
          }
          if (data.kind === 'membership-revoked') {
            teardown();
            setError('已退出或被移出群聊');
            return;
          }
          const peerId = data.peerId as string;
          if (data.kind === 'joined') touchPeer(peerId);
          else if (data.kind === 'left') removePeer(peerId);
          return;
        }

        if (t === 'agent') {
          setAgentsState(parseRoomAgents(data.agents));
          return;
        }

        if (t === 'group') {
          // Every field is optional and an absent one means "unchanged": the frame that
          // follows a settings change is broadcast to the whole room and therefore carries
          // neither isOwner nor ownerKey, which are answers to one connection only.
          const code = (data.code as string) || roomIdRef.current || '';
          if (typeof data.public === 'boolean') setIsPublic(data.public);
          if (typeof data.isOwner === 'boolean') setIsOwner(data.isOwner);
          if (typeof data.name === 'string') {
            setGroupName(data.name);
            rememberGroup(code, data.name);
          }
          // Arrives exactly once, in the reply to the connection that created the group.
          if (typeof data.ownerKey === 'string' && code) {
            saveOwnerKey(code, data.ownerKey);
            setIsOwner(true);
          }
          return;
        }

        const from = data._from as string;
        if (!from) return;
        if (from === selfId && t !== 'chat') return;

        switch (t) {
          case 'presence':
            touchPeer(from, data.n as string | undefined);
            break;
          case 'chat':
            if (from === selfId && typeof data.id === 'string') clearPendingSend(data.id);
            setMessages((prev) => {
              const confirmed: ChatMessage = {
                id: (data.id as string) ?? shortId(),
                serverConfirmed: true,
                fromSelf: isOwnMessage(data),
                senderId: from,
                senderName: (data.n as string) ?? from.slice(0, 6),
                text: (data.x as string) ?? '',
                timestamp: (data.ts as number) ?? Date.now(),
                media: buildMedia(roomIdRef.current, data.m as WireMedia | undefined),
                mentions: mapMentions(data.mentions),
                replyTo: data.replyTo as WireReply | undefined,
                ...(data.recalled === true ? { recalled: true } : {}),
              };
              const existing = prev.findIndex((message) => message.id === confirmed.id);
              if (existing < 0) return [...prev, confirmed];
              const next = [...prev];
              next[existing] = confirmed;
              return next;
            });
            break;
          case 'recall': {
            // Only the server sends this, after checking the sender and the time window.
            const recalledId = data.id;
            if (typeof recalledId !== 'string') break;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === recalledId
                  ? {
                      ...message,
                      recalled: true,
                      text: '',
                      media: undefined,
                      mentions: undefined,
                      replyTo: undefined,
                    }
                  : message.replyTo?.id === recalledId
                    ? {
                        ...message,
                        replyTo: { ...message.replyTo, text: '消息已撤回', recalled: true },
                      }
                    : message,
              ),
            );
            break;
          }
          case 'cmd':
            onCommandRef.current?.(
              {
                action: data.a as CmdAction,
                kind: data.kind as DeviceCommand['kind'],
                // Absent on every command from a client that predates
                // multi-device — which stays undefined here and so keeps
                // meaning "the primary device of that kind".
                deviceId: data.deviceId as string | undefined,
                c: data.c as 'A' | 'B' | undefined,
                v: data.v as number | undefined,
                w: data.w as string | undefined,
                d: data.d as string | undefined,
                q: data.q as string[] | undefined,
                mode: data.mode as DeviceCommand['mode'],
                iv: data.iv as number | undefined,
                color: data.color as number | undefined,
                ms: data.ms as number | undefined,
                // Only a known rhythm name; anything else stays undefined and is refused.
                pattern: isOpossumPattern(data.pattern) ? data.pattern : undefined,
              },
              from,
            );
            break;
          case 'wave':
            onWaveformRef.current?.(
              {
                wid: data.wid as string,
                wn: data.wn as string,
                fr: data.fr as [number, number][],
                modality: data.mo as 'electrostimulation' | 'vibration' | undefined,
              },
              from,
            );
            break;
          case 'sf':
            touchPeer(from);
            setMembers((prev) => {
              const cur = prev.get(from) ?? emptyMember(from);
              const next = new Map(prev);
              next.set(from, {
                ...cur,
                strengthA: (data.sa as number) ?? cur.strengthA,
                strengthB: (data.sb as number) ?? cur.strengthB,
                waveA: (data.wa as string | null) ?? null,
                waveB: (data.wb as string | null) ?? null,
                firingA: (data.fA as boolean) ?? cur.firingA,
                firingB: (data.fB as boolean) ?? cur.firingB,
                opossumIntensityA: (data.oa as number | undefined) ?? cur.opossumIntensityA,
                opossumIntensityB: (data.ob as number | undefined) ?? cur.opossumIntensityB,
                // No `?? cur.X` fallback here — App.tsx always includes these
                // keys in every 'sf' broadcast (unlike opossumIntensityA/B,
                // which really can be legitimately absent from an
                // opossum-less broadcast payload shape upstream). Falling
                // back to the cached value on an explicit `null` (sent on
                // sensor disconnect) would mask the clear and leave stale
                // sensor readings displayed forever — see bluetooth.ts's
                // disconnectSensor().
                sensorLastEvent: (data.se as string | null | undefined) ?? null,
                sensorLastValue: (data.sv as number | null | undefined) ?? null,
                sensorLastEventAt: (data.sea as number | null | undefined) ?? null,
              });
              return next;
            });
            break;
          case 'ss':
            touchPeer(from);
            setMembers((prev) => {
              const cur = prev.get(from) ?? emptyMember(from);
              const next = new Map(prev);
              next.set(from, {
                ...cur,
                displayName: (data.n as string) ?? cur.displayName,
                // No `?? cur.username` fallback, for the reason given on the
                // send side: 'ss' always carries this key, so an absent one
                // means an older client that has no account to report.
                username: (data.u as string | null | undefined) ?? null,
                deviceConnected: (data.dc as boolean) ?? cur.deviceConnected,
                coyotes: parseRoomCoyoteTargets(data.cy),
                battery: (data.b as number | null) ?? null,
                waveformCatalog:
                  (data.cat as MemberState['waveformCatalog']) ?? cur.waveformCatalog,
                queueA: (data.qA as string[]) ?? cur.queueA,
                queueB: (data.qB as string[]) ?? cur.queueB,
                playModeA: (data.mA as MemberState['playModeA']) ?? cur.playModeA,
                playModeB: (data.mB as MemberState['playModeB']) ?? cur.playModeB,
                intervalA: (data.iA as number) ?? cur.intervalA,
                intervalB: (data.iB as number) ?? cur.intervalB,
                currentIndexA: (data.ciA as number) ?? cur.currentIndexA,
                currentIndexB: (data.ciB as number) ?? cur.currentIndexB,
                deviceAccess: typeof data.da === 'boolean' ? data.da : cur.deviceAccess,
                opossumConnected: (data.oc as boolean | undefined) ?? cur.opossumConnected,
                // No `?? cur.X` fallback — App.tsx's 'ss' broadcast always
                // includes these keys (see the matching comment on the 'sf'
                // case above). sensorKind in particular gates SensorCard's
                // visibility (`!member.sensorKind` hides it), so preserving a
                // stale kind after disconnect left the card permanently stuck
                // visible for the rest of the room session.
                opossumBattery: (data.obt as number | null | undefined) ?? null,
                opossumLastButtons: (data.obtn as string | null | undefined) ?? null,
                sensorKind: (data.sk as MemberState['sensorKind'] | null | undefined) ?? null,
                sensorConnected: (data.sc as boolean | undefined) ?? cur.sensorConnected,
                sensorBattery: (data.sbt as number | null | undefined) ?? null,
              });
              return next;
            });
            break;
          case 'leave':
            removePeer(from);
            break;
        }
      }

      // Only the first hello of this join may reactivate a membership the account left;
      // an automatic reconnect must not undo a leave made on another device meanwhile.
      let explicitJoinSent = false;
      const transport = connectRoom({
        code: roomCode,
        peerId: selfId,
        dm: dm !== null,
        ticket: dm ? dmTicketProvider(dm) : chatTicketProvider(),
        onStatus: (s: TransportStatus) => {
          setStatus(s);
          if (s !== 'connected') {
            setHistoryLoading(false);
            setMediaUploadToken(null);
          }
        },
        onOpen: () => {
          setRoomId(roomCode);
          if (dm) {
            // A DM's hello carries the nickname and nothing else. There is no visibility to
            // seed, no ownership to claim and no key to present — none of those exist for a
            // conversation between two accounts, and sending them anyway would be asking the
            // server to ignore them.
            send({ t: 'hello', name: displayNameRef.current, historyPaging: true });
            return;
          }
          // First frame on join: declare nickname, plus the settings the group is seeded
          // with if this is its first hello ever. A reconnect fires this too → the DO
          // replays history again.
          const join = !explicitJoinSent;
          explicitJoinSent = true;
          send({
            t: 'hello',
            join,
            historyPaging: true,
            name: displayNameRef.current,
            public: joinOptsRef.current.public,
            roomName: joinOptsRef.current.roomName,
            claim: joinOptsRef.current.claim,
            // Proof of ownership when this browser created the group. Absent for everyone
            // else, and the server answers with isOwner:false rather than refusing the join.
            ownerKey: loadOwnerKey(roomCode) ?? undefined,
          });
        },
        onMessage: handleMessage,
      });
      transportRef.current = transport;

      // presence heartbeat (carries the nickname, so others can discover us and
      // keep names in sync).
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
      presenceTimerRef.current = window.setInterval(() => {
        send({ t: 'presence', n: displayNameRef.current });
      }, PRESENCE_INTERVAL_MS);
    },
    [removePeer, send, teardown],
  );

  const sendMessage = useCallback(
    (text: string, media?: OutgoingMedia, mentions?: ChatMention[], replyTo?: WireReply) => {
      const id = shortId();
      const now = Date.now();
      const name = displayNameRef.current;
      const room = roomIdRef.current;

      const localMedia: ChatMedia | undefined = media ? buildMedia(room, media) : undefined;

      const payload = {
        t: 'chat',
        replyToId: replyTo?.id,
        id,
        n: name,
        x: text,
        ts: now,
        m: media
          ? {
              kind: media.kind,
              id: media.id,
              mime: media.mime,
              size: media.size,
              durationMs: media.durationMs,
              w: media.w,
              h: media.h,
            }
          : undefined,
        mentions: mentions?.map((x) => ({ peerId: x.peerId, n: x.displayName })),
      };
      if (!send(payload)) return false;
      trackPendingSend(id, payload);

      setMessages((prev) => [
        ...prev,
        {
          id,
          fromSelf: true,
          senderId: selfId,
          senderName: name,
          text,
          timestamp: now,
          media: localMedia,
          mentions,
          replyTo,
        },
      ]);
      return true;
    },
    [send, trackPendingSend],
  );

  /** Resend a failed message with its original id; the server confirms a duplicate once. */
  const retryMessage = useCallback(
    (id: string) => {
      const pending = pendingSendsRef.current.get(id);
      if (!pending || !send(pending.payload)) return false;
      trackPendingSend(id, pending.payload);
      setMessages((current) =>
        current.map((message) => (message.id === id ? { ...message, sendFailed: false } : message)),
      );
      return true;
    },
    [send, trackPendingSend],
  );

  /** Drop a failed local message the user no longer wants to send. */
  const discardMessage = useCallback(
    (id: string) => {
      clearPendingSend(id);
      setMessages((current) =>
        current.filter((message) => message.id !== id || message.serverConfirmed),
      );
    },
    [clearPendingSend],
  );

  /**
   * Bring one of this account's own characters into the group as its AI. The account service
   * vouches for ownership and Credit with a ticket bound to this group; the AI then answers
   * whoever @-mentions it and bills this account. Resolves false when nothing was sent.
   */
  const addMyAgent = useCallback(
    async (character: { id: string; name: string; persona: string }): Promise<boolean> => {
      const room = roomIdRef.current;
      const account = currentAuthUserId();
      if (!room || room.startsWith('dm:') || !account) return false;
      let ticket: string;
      try {
        ticket = (await getGroupAgentTicket(room, character.id)).ticket;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法把 AI 带进群');
        return false;
      }
      // Never deliver a ticket into a group or account the user has since left.
      if (roomIdRef.current !== room || currentAuthUserId() !== account) return false;
      return send({ t: 'agent-add', ticket, name: character.name, persona: character.persona });
    },
    [send],
  );

  /** The owner sets how much Credit their AI may spend per day here; null removes the cap. */
  const setAgentDailyCap = useCallback(
    (agentId: string, dailyCap: number | null) => {
      send({ t: 'agent-cap', agentId, dailyCap });
    },
    [send],
  );

  /** The owner withdraws their AI, or the group owner removes anyone's. */
  const removeAgent = useCallback(
    (agentId: string) => {
      const code = roomIdRef.current;
      send({
        t: 'agent-remove',
        agentId,
        ownerKey: (code ? loadOwnerKey(code) : null) ?? undefined,
      });
    },
    [send],
  );

  /** Owner shows or hides the group in the lobby. Takes effect there immediately. */
  const setGroupPublic = useCallback(
    (next: boolean) => {
      const code = roomIdRef.current;
      if (!code) return;
      send({ t: 'group', public: next, ownerKey: loadOwnerKey(code) ?? undefined });
    },
    [send],
  );

  const renameGroup = useCallback(
    (name: string) => {
      const code = roomIdRef.current;
      if (!code || !name.trim()) return;
      send({ t: 'group', roomName: name.trim(), ownerKey: loadOwnerKey(code) ?? undefined });
    },
    [send],
  );

  const closeGroup = useCallback(() => {
    const code = roomIdRef.current;
    if (!code) return;
    send({ t: 'group', closed: true, ownerKey: loadOwnerKey(code) ?? undefined });
    forgetGroup(code);
  }, [send]);

  const sendCommand = useCallback(
    (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => {
      send({ t: 'cmd', to: target, a: action, ...params });
    },
    [send],
  );

  const sendWaveform = useCallback(
    (targetPeerId: string, transfer: WaveformTransfer) => {
      send({
        t: 'wave',
        to: targetPeerId,
        wid: transfer.wid,
        wn: transfer.wn,
        fr: transfer.fr,
        ...(transfer.modality ? { mo: transfer.modality } : {}),
      });
    },
    [send],
  );

  /** High-frequency state broadcast: sent immediately on change, throttled to 200ms. */
  const broadcastStateFast = useCallback(
    (s: StateFast) => {
      const emit = (state: StateFast) => {
        send({
          t: 'sf',
          sa: state.strengthA,
          sb: state.strengthB,
          wa: state.waveA,
          wb: state.waveB,
          fA: state.firingA,
          fB: state.firingB,
          oa: state.opossumIntensityA,
          ob: state.opossumIntensityB,
          obtn: state.opossumLastButtons,
          se: state.sensorLastEvent,
          sv: state.sensorLastValue,
          sea: state.sensorLastEventAt,
        });
      };
      const ref = fastThrottleRef.current;
      const now = Date.now();
      const elapsed = now - ref.lastSent;
      if (elapsed >= FAST_THROTTLE_MS) {
        ref.lastSent = now;
        ref.pending = null;
        emit(s);
      } else {
        ref.pending = s;
        if (ref.timer == null) {
          ref.timer = window.setTimeout(() => {
            ref.timer = null;
            if (ref.pending) {
              ref.lastSent = Date.now();
              const p = ref.pending;
              ref.pending = null;
              emit(p);
            }
          }, FAST_THROTTLE_MS - elapsed);
        }
      }
    },
    [send],
  );

  /** Low-frequency state broadcast: a 5s heartbeat, plus one call whenever the catalog changes. */
  const broadcastStateSlow = useCallback(
    (s: StateSlow) => {
      send({
        t: 'ss',
        n: s.displayName,
        // Explicit null when signed out, never undefined: JSON.stringify drops
        // undefined keys, and the receiver reads a missing key as "no update"
        // and keeps the previous value — signing out would leave a stale
        // account handle attached to this peer for the rest of the session.
        u: s.username ?? null,
        dc: s.deviceConnected,
        cy: s.coyotes,
        b: s.battery,
        ...(s.waveformCatalog ? { cat: s.waveformCatalog } : {}),
        qA: s.queueA,
        qB: s.queueB,
        mA: s.playModeA,
        mB: s.playModeB,
        iA: s.intervalA,
        iB: s.intervalB,
        ciA: s.currentIndexA,
        ciB: s.currentIndexB,
        da: s.deviceAccess,
        oc: s.opossumConnected,
        obt: s.opossumBattery,
        sk: s.sensorKind,
        sc: s.sensorConnected,
        sbt: s.sensorBattery,
      });
    },
    [send],
  );

  const leave = useCallback(() => {
    if (roomIdRef.current && !joinOptsRef.current.dm) send({ t: 'membership-leave' });
    teardown();
  }, [teardown, send]);

  useEffect(() => {
    const timers = peerTimersRef.current;
    return () => {
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
      timers.forEach((timer) => clearTimeout(timer));
      transportRef.current?.send({ t: 'leave' });
      transportRef.current?.close();
    };
  }, []);

  // Each group AI is a pseudo-member (peerId = ai:<id>) so it shows up in the member list
  // and the @-mention candidates, labelled with whose AI it is.
  const membersWithAi = useMemo(() => {
    const m = new Map(members);
    for (const agent of agents) {
      const sender = `ai:${agent.id}`;
      m.set(sender, {
        ...emptyMember(sender),
        displayName: agent.name || 'AI',
        isAi: true,
        aiOwnerName: agent.ownerName,
      });
    }
    return m;
  }, [members, agents]);

  /**
   * Show a remote peer's notice as a line in the transcript.
   *
   * Local only — never sent back to the room. It exists so the `alert`
   * command has a non-blocking way to reach the user.
   */
  const notifyLocal = useCallback((text: string) => {
    const body = text.trim();
    if (!body) return;
    setMessages((prev) => [
      ...prev,
      {
        id: `notice-${crypto.randomUUID()}`,
        fromSelf: false,
        senderId: 'system',
        senderName: '提示',
        text: body,
        timestamp: Date.now(),
      },
    ]);
  }, []);

  return {
    selfId,
    readAdmission,
    isReadAdmissionCurrent,
    status,
    connected: status === 'connected',
    error,
    roomId,
    peers,
    members: membersWithAi,
    messages,
    groupMemberships,
    manageGroupMembership: (action: 'list' | 'remove' | 'ban' | 'restore', accountId?: string) => {
      const code = roomIdRef.current;
      if (code && !joinOptsRef.current.dm)
        send({ t: 'membership', action, accountId, ownerKey: loadOwnerKey(code) ?? undefined });
    },
    historyLoading,
    hasOlderHistory: historyBefore !== null,
    loadOlderHistory: () => {
      if (historyLoading || !historyBefore || status !== 'connected') return;
      setHistoryLoading(true);
      send({ t: 'history-before', before: historyBefore });
    },
    /** Text search over this conversation's retained server history. */
    searchMessages: (query: string) =>
      new Promise<ChatSearchHit[]>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        if (!send({ t: 'search', q: query, requestId })) {
          reject(new Error('未连接'));
          return;
        }
        const timer = window.setTimeout(() => {
          searchesRef.current.delete(requestId);
          reject(new Error('搜索超时'));
        }, SEARCH_TIMEOUT_MS);
        searchesRef.current.set(requestId, { resolve, timer });
      }),
    mediaUploadToken,
    join,
    leave,
    sendMessage,
    retryMessage,
    discardMessage,
    /** Ask the server to withdraw one of this account's messages (RECALL_WINDOW_MS). */
    recallMessage: (id: string) => send({ t: 'recall', id }),
    sendCommand,
    sendWaveform,
    broadcastStateFast,
    broadcastStateSlow,
    setCommandHandler,
    setWaveformHandler,
    notifyLocal,
    // —— Group AIs ——
    agents,
    addMyAgent,
    setAgentDailyCap,
    removeAgent,
    // —— Direct message ——
    /** The account on the other end, or null when this is a group. */
    dmPeerUserId,
    isDm: dmPeerUserId !== null,
    // —— Group ——
    isPublic,
    groupName,
    isOwner,
    setGroupPublic,
    renameGroup,
    closeGroup,
    /**
     * May this browser change the group's settings and remove anyone's AI?
     *
     * Mirrors the server's rule: only the group's owner account.
     */
    canManageGroup: isOwner,
  };
}

/** Keep only well-formed AIs from the server frame; anything else is dropped, not guessed. */
export function parseRoomAgents(value: unknown): WireRoomAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const agent = entry as Partial<WireRoomAgent> | null;
    if (
      !agent ||
      typeof agent.id !== 'string' ||
      typeof agent.name !== 'string' ||
      typeof agent.persona !== 'string' ||
      typeof agent.owner !== 'string' ||
      typeof agent.ownerName !== 'string'
    )
      return [];
    return [
      {
        id: agent.id,
        name: agent.name,
        persona: agent.persona,
        owner: agent.owner,
        ownerName: agent.ownerName,
        dailyCap: typeof agent.dailyCap === 'number' ? agent.dailyCap : null,
      },
    ];
  });
}

function emptyMember(peerId: string): MemberState {
  return {
    peerId,
    displayName: '',
    deviceConnected: false,
    coyotes: [],
    strengthA: 0,
    strengthB: 0,
    waveA: null,
    waveB: null,
    battery: null,
    queueA: [],
    queueB: [],
    playModeA: 'single',
    playModeB: 'single',
    intervalA: 30,
    intervalB: 30,
    currentIndexA: 0,
    currentIndexB: 0,
    firingA: false,
    firingB: false,
    opossumConnected: false,
    opossumIntensityA: 0,
    opossumIntensityB: 0,
    opossumBattery: null,
    sensorConnected: false,
    sensorBattery: null,
    sensorLastEvent: null,
    sensorLastValue: null,
    sensorLastEventAt: null,
  };
}
