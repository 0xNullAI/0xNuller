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
  Scene,
} from '../lib/protocol';

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Options for creating/joining a room. Public rooms get registered in the lobby. */
export interface JoinOptions {
  public?: boolean;
  roomName?: string;
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

/** Look up the name of the role a member has claimed in the current scene (= their title). */
function roleNameOf(
  peerId: string,
  scene: Scene | null,
  assignments: Record<string, string>,
): string | undefined {
  if (!scene) return undefined;
  const entry = Object.entries(assignments).find(([, pid]) => pid === peerId);
  return entry ? scene.roles.find((r) => r.id === entry[0])?.name : undefined;
}

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
  // —— Scene roleplay ——
  const [scene, setSceneState] = useState<Scene | null>(null);
  const [roleAssignments, setRoleAssignments] = useState<Record<string, string>>({});
  const [hostPeerId, setHostPeerId] = useState<string | null>(null);

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

  const join = useCallback(
    (roomCode: string, options?: JoinOptions) => {
      if (transportRef.current) return;
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
              senderRole: m.senderRole as string | undefined,
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

        if (t === 'scene') {
          setSceneState((data.scene as Scene | null) ?? null);
          setHostPeerId((data.host as string) ?? null);
          return;
        }

        if (t === 'role') {
          setRoleAssignments((data.assignments as Record<string, string>) ?? {});
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
                senderRole: data.senderRole as string | undefined,
              },
            ]);
            break;
          case 'cmd':
            onCommandRef.current?.(
              {
                action: data.a as CmdAction,
                kind: data.kind as DeviceCommand['kind'],
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
          // First frame on join: declare nickname / public flag / room name.
          // A reconnect fires this too → the DO replays history again.
          send({
            t: 'hello',
            name: displayNameRef.current,
            public: joinOptsRef.current.public,
            roomName: joinOptsRef.current.roomName,
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
    [removePeer, send],
  );

  const sendMessage = useCallback(
    (text: string, media?: OutgoingMedia, mentions?: ChatMention[]) => {
      const id = shortId();
      const now = Date.now();
      const name = displayNameRef.current;
      const room = roomIdRef.current;

      const localMedia: ChatMedia | undefined = media ? buildMedia(room, media) : undefined;
      // The local optimistic message works out its own title (the DO doesn't
      // echo messages back to their sender).
      const myRole = roleNameOf(selfId, scene, roleAssignments);

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
          senderRole: myRole,
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
    [send, scene, roleAssignments],
  );

  /** Host sets/changes the scene (changing scenes clears all role claims). */
  const setScene = useCallback(
    (s: Scene | null) => {
      send({ t: 'scene', scene: s });
    },
    [send],
  );

  /** Claim a role (exclusive). */
  const claimRole = useCallback(
    (roleId: string) => {
      send({ t: 'role', act: 'claim', roleId });
    },
    [send],
  );

  /** Release a role. */
  const releaseRole = useCallback(
    (roleId: string) => {
      send({ t: 'role', act: 'release', roleId });
    },
    [send],
  );

  /** Host: hand an aiPlayable role over to the AI / take it back. */
  const assignAi = useCallback(
    (roleId: string) => {
      send({ t: 'role', act: 'assign-ai', roleId });
    },
    [send],
  );
  const releaseAi = useCallback(
    (roleId: string) => {
      send({ t: 'role', act: 'release-ai', roleId });
    },
    [send],
  );

  /**
   * Host speaks on behalf of an AI-held role (called by the agent loop). The
   * server verifies the sender is the host and that the role really is AI-held.
   */
  const sendChatAs = useCallback(
    (roleId: string, text: string, mentions?: ChatMention[]) => {
      const role = scene?.roles.find((r) => r.id === roleId);
      send({
        t: 'chat',
        as: `ai:${roleId}`,
        id: shortId(),
        n: role?.name ?? 'AI',
        x: text,
        ts: Date.now(),
        mentions: mentions?.map((x) => ({ peerId: x.peerId, n: x.displayName })),
      });
    },
    [send, scene],
  );

  /**
   * Host sends a device command on behalf of an AI-held role (an agent tool
   * call). _from is set to ai:<roleId> by the server.
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
    setSceneState(null);
    setRoleAssignments({});
    setHostPeerId(null);
  }, [send]);

  useEffect(() => {
    const timers = peerTimersRef.current;
    return () => {
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
      timers.forEach((timer) => clearTimeout(timer));
      transportRef.current?.send({ t: 'leave' });
      transportRef.current?.close();
    };
  }, []);

  // Synthesize AI-held roles as pseudo-members so they show up in the member
  // list and the @-mention candidates (peerId = "ai:<roleId>").
  const membersWithAi = useMemo(() => {
    if (!scene) return members;
    const m = new Map(members);
    for (const [roleId, holder] of Object.entries(roleAssignments)) {
      if (!holder.startsWith('ai:')) continue;
      const role = scene.roles.find((r) => r.id === roleId);
      if (role)
        m.set(holder, { ...emptyMember(holder), displayName: role.name, roleId, isAi: true });
    }
    return m;
  }, [members, scene, roleAssignments]);

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
    // —— Scene roleplay ——
    scene,
    roleAssignments,
    hostPeerId,
    isHost: hostPeerId === selfId,
    myRoleId: Object.entries(roleAssignments).find(([, p]) => p === selfId)?.[0] ?? null,
    setScene,
    claimRole,
    releaseRole,
    assignAi,
    releaseAi,
    sendChatAs,
    sendCommandAs,
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
