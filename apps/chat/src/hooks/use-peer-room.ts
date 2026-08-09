import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { connectRoom, type RoomTransport, type TransportStatus } from '../lib/room-transport';
import type {
  ChatMessage,
  ChatMedia,
  ChatMention,
  DeviceCommand,
  MemberState,
  CmdAction,
  WaveformTransfer,
  StateFast,
  StateSlow,
} from '../lib/protocol';
import { ROOM_AGENT_ID, ROOM_AGENT_SENDER, type RoomAgent } from '../../worker/wire';
import { loadOwnerKey, rememberGroup, saveOwnerKey } from '../lib/groups';
import { RESERVED_ROOM_CODE } from '../../shared/room-constants';

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Options for creating/joining a group. Public groups get registered in the lobby. */
export interface JoinOptions {
  public?: boolean;
  roomName?: string;
  /**
   * Ask the server to mint an owner key for this group. Set only on the create path: it is
   * what makes the creator the durable owner, and it is ignored once a group already has one.
   */
  claim?: boolean;
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
export function usePeerRoom(displayName: string) {
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [members, setMembers] = useState<Map<string, MemberState>>(new Map());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // —— Room AI ——
  const [agent, setAgentState] = useState<RoomAgent | null>(null);
  // The host is whoever the DO says it is. Only that browser runs the agent
  // loop, which is what keeps one @mention from producing several replies.
  // It is a live role that moves when the current host disconnects — not
  // ownership, which is durable and lives in the owner key below.
  const [hostPeerId, setHostPeerId] = useState<string | null>(null);
  // —— Group settings (durable, owner-controlled) ——
  const [isPublic, setIsPublic] = useState(false);
  const [groupName, setGroupName] = useState('');
  /** The group has an owner key on file at all (groups made by older clients do not). */
  const [groupOwned, setGroupOwned] = useState(false);
  /** This browser holds the key and the server accepted it. */
  const [isOwner, setIsOwner] = useState(false);

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
    transportRef.current?.send(payload);
  }, []);

  /** Close the connection and drop everything that belonged to that group. */
  const teardown = useCallback(() => {
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
    setHostPeerId(null);
    // Group-scoped state must go too, or the next group inherits the previous one's
    // agent and settings for as long as it takes the new frames to arrive.
    setAgentState(null);
    setIsOwner(false);
    setGroupOwned(false);
    setIsPublic(false);
    setGroupName('');
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
      joinOptsRef.current = options ?? {};
      console.log('[DG-Chat] join', roomCode, 'as', selfId);

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

        if (t === 'history') {
          const room = roomIdRef.current;
          const list = (data.messages as Array<Record<string, unknown>>) ?? [];
          setMessages(
            list.map((m) => ({
              id: m.id as string,
              fromSelf: m._from === selfId,
              senderId: (m._from as string) ?? '',
              senderName: (m.n as string) ?? '',
              text: (m.x as string) ?? '',
              timestamp: (m.ts as number) ?? 0,
              media: buildMedia(room, m.m as WireMedia | undefined),
              mentions: mapMentions(m.mentions),
            })),
          );
          return;
        }

        if (t === 'sys') {
          const peerId = data.peerId as string;
          if (data.kind === 'joined') touchPeer(peerId);
          else if (data.kind === 'left') removePeer(peerId);
          return;
        }

        if (t === 'agent') {
          setAgentState((data.agent as RoomAgent | null) ?? null);
          setHostPeerId((data.host as string) ?? null);
          return;
        }

        if (t === 'group') {
          // Every field is optional and an absent one means "unchanged": the frame that
          // follows a settings change is broadcast to the whole room and therefore carries
          // neither isOwner nor ownerKey, which are answers to one connection only.
          const code = (data.code as string) || roomIdRef.current || '';
          if (typeof data.public === 'boolean') setIsPublic(data.public);
          if (typeof data.owned === 'boolean') setGroupOwned(data.owned);
          if (typeof data.isOwner === 'boolean') setIsOwner(data.isOwner);
          if (typeof data.name === 'string') {
            setGroupName(data.name);
            if (code !== RESERVED_ROOM_CODE) rememberGroup(code, data.name);
          }
          // Arrives exactly once, in the reply to the connection that created the group.
          if (typeof data.ownerKey === 'string' && code) {
            saveOwnerKey(code, data.ownerKey);
            setIsOwner(true);
          }
          return;
        }

        const from = data._from as string;
        if (!from || from === selfId) return;

        switch (t) {
          case 'presence':
            touchPeer(from, data.n as string | undefined);
            break;
          case 'chat':
            setMessages((prev) => [
              ...prev,
              {
                id: (data.id as string) ?? shortId(),
                fromSelf: false,
                senderId: from,
                senderName: (data.n as string) ?? from.slice(0, 6),
                text: (data.x as string) ?? '',
                timestamp: (data.ts as number) ?? Date.now(),
                media: buildMedia(roomIdRef.current, data.m as WireMedia | undefined),
                mentions: mapMentions(data.mentions),
              },
            ]);
            break;
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
                allowAi: (data.aa as boolean | undefined) ?? cur.allowAi,
                opossumConnected: (data.oc as boolean | undefined) ?? cur.opossumConnected,
                // No `?? cur.X` fallback — App.tsx's 'ss' broadcast always
                // includes these keys (see the matching comment on the 'sf'
                // case above). sensorKind in particular gates SensorCard's
                // visibility (`!member.sensorKind` hides it), so preserving a
                // stale kind after disconnect left the card permanently stuck
                // visible for the rest of the room session.
                opossumBattery: (data.obt as number | null | undefined) ?? null,
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

      const transport = connectRoom({
        code: roomCode,
        peerId: selfId,
        onStatus: (s: TransportStatus) => setStatus(s),
        onOpen: () => {
          setRoomId(roomCode);
          // First frame on join: declare nickname, plus the settings the group is seeded
          // with if this is its first hello ever. A reconnect fires this too → the DO
          // replays history again.
          send({
            t: 'hello',
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
    (text: string, media?: OutgoingMedia, mentions?: ChatMention[]) => {
      const id = shortId();
      const now = Date.now();
      const name = displayNameRef.current;
      const room = roomIdRef.current;

      const localMedia: ChatMedia | undefined = media ? buildMedia(room, media) : undefined;

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
        },
      ]);

      send({
        t: 'chat',
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
      });
    },
    [send],
  );

  /**
   * Owner adds, edits, or removes the group's agent. The server verifies the key (and falls
   * back to host authority for a group that never got an owner, so older clients still work).
   */
  const setAgent = useCallback(
    (next: RoomAgent | null) => {
      const code = roomIdRef.current;
      send({
        t: 'agent',
        agent: next,
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

  /**
   * Host speaks as the room agent (called by the agent loop). The server
   * verifies the sender is the host and that the room really has an agent.
   */
  const sendChatAs = useCallback(
    (roleId: string, text: string, mentions?: ChatMention[]) => {
      const name = roleId === ROOM_AGENT_ID ? (agent?.name ?? 'AI') : 'AI';
      send({
        t: 'chat',
        as: `ai:${roleId}`,
        id: shortId(),
        n: name,
        x: text,
        ts: Date.now(),
        mentions: mentions?.map((x) => ({ peerId: x.peerId, n: x.displayName })),
      });
    },
    [send, agent],
  );

  /**
   * Host sends a device command as the room agent (an agent tool call).
   * _from is set to ai:<roleId> by the server.
   */
  const sendCommandAs = useCallback(
    (roleId: string, target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => {
      send({ t: 'cmd', as: `ai:${roleId}`, to: target, a: action, ...params });
    },
    [send],
  );

  const sendCommand = useCallback(
    (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => {
      send({ t: 'cmd', to: target, a: action, ...params });
    },
    [send],
  );

  const sendWaveform = useCallback(
    (targetPeerId: string, transfer: WaveformTransfer) => {
      send({ t: 'wave', to: targetPeerId, wid: transfer.wid, wn: transfer.wn, fr: transfer.fr });
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
        aa: s.allowAi,
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
    teardown();
  }, [teardown]);

  useEffect(() => {
    const timers = peerTimersRef.current;
    return () => {
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
      timers.forEach((timer) => clearTimeout(timer));
      transportRef.current?.send({ t: 'leave' });
      transportRef.current?.close();
    };
  }, []);

  // Synthesize the room agent as a pseudo-member (peerId = ROOM_AGENT_SENDER)
  // so it shows up in the member list and the @-mention candidates.
  const membersWithAi = useMemo(() => {
    if (!agent) return members;
    const m = new Map(members);
    m.set(ROOM_AGENT_SENDER, {
      ...emptyMember(ROOM_AGENT_SENDER),
      displayName: agent.name || 'AI',
      isAi: true,
    });
    return m;
  }, [members, agent]);

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
    status,
    connected: status === 'connected',
    error,
    roomId,
    peers,
    members: membersWithAi,
    messages,
    join,
    leave,
    sendMessage,
    sendCommand,
    sendWaveform,
    broadcastStateFast,
    broadcastStateSlow,
    setCommandHandler,
    setWaveformHandler,
    notifyLocal,
    // —— Room AI ——
    agent,
    setAgent,
    hostPeerId,
    isHost: hostPeerId === selfId,
    sendChatAs,
    sendCommandAs,
    // —— Group ——
    isPublic,
    groupName,
    isOwner,
    setGroupPublic,
    /**
     * May this browser change the group's settings and its agent?
     *
     * Mirrors the server's rule exactly: the owner key if the group has one, otherwise the
     * current host — which is what keeps a group created by a client too old to know about
     * ownership administrable by the people in it.
     */
    canManageGroup: isOwner || (!groupOwned && hostPeerId === selfId),
  };
}

function emptyMember(peerId: string): MemberState {
  return {
    peerId,
    displayName: '',
    deviceConnected: false,
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
