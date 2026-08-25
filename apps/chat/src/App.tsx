import { useOpenShellSettings, useInShell, useSafetySession } from '@0xnullai/ui';
import {
  hasDeviceLease,
  subscribeSafetySessions,
  PolicyEngine,
  createDefaultPolicyRules,
} from '@dg-kit/safety';
import { useNativeBridge } from '@0xnullai/native';
import { dmTicket, me, subscribeDmRequest, type DmRequest } from '@0xnullai/auth';
import { useState, useEffect, useCallback, useRef } from 'react';
import { usePeerRoom } from './hooks/use-peer-room';
import { useDevice } from './hooks/use-device';
import { useWaveforms } from './hooks/use-waveforms';
import { useChannelRotation } from './hooks/use-channel-rotation';
import { executeCommand, type CommandContext } from './lib/commands';
import { markDmRead } from './lib/dm';
import { useRoomAgents, type AgentDeviceTarget } from './hooks/use-room-agents';
import { uploadMedia } from './lib/media';
import type { DeviceClientFactory, RequestDeviceFn } from './lib/bluetooth';
import type { DeviceCommand, CmdAction, PlayMode, WaveformTransfer } from './lib/protocol';
import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import { isCoyoteOutputActive } from '@dg-kit/core';
import { ChatAppView } from './components/ChatAppView';

export interface AppProps {
  /**
   * Override the underlying BLE transport. Defaults to Web Bluetooth.
   * The Tauri Android shell passes a factory that creates a
   * `TauriBlecDeviceClient` so the same React UI runs natively.
   */
  deviceClientFactory?: DeviceClientFactory;
  /**
   * Override `DeviceSession.connectDevice()`'s device-picking step. Defaults
   * to a single Web Bluetooth chooser scoped to all 4 DG-Lab device kinds
   * (`requestDgLabDevice()`). The Tauri Android shell supplies
   * `requestDgLabDeviceTauri()` instead — same one-button, auto-detected-kind
   * experience, over plugin-blec.
   */
  requestDeviceTauri?: RequestDeviceFn;
}

type FirePolicy = 'sum' | 'max' | 'avg';

function aggregate(boosts: Map<string, { boost: number; ts: number }>, policy: FirePolicy): number {
  if (boosts.size === 0) return 0;
  const arr = Array.from(boosts.values()).map((x) => x.boost);
  if (policy === 'sum') return arr.reduce((a, b) => a + b, 0);
  if (policy === 'max') return Math.max(...arr);
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

interface FireApplyDeps {
  channel: 'A' | 'B';
  boosts: Map<string, { boost: number; ts: number }>;
  baseline: number;
  device: {
    connected: boolean;
    limitA: number;
    limitB: number;
    setStrength: (c: 'A' | 'B', v: number) => void;
  };
  policy: FirePolicy;
  setFiring: (v: boolean) => void;
}

function applyFire(d: FireApplyDeps) {
  if (!d.device.connected) return;
  const limit = d.channel === 'A' ? d.device.limitA : d.device.limitB;
  if (d.boosts.size === 0) {
    d.device.setStrength(d.channel, d.baseline);
    d.setFiring(false);
    return;
  }
  const agg = aggregate(d.boosts, d.policy);
  d.device.setStrength(d.channel, Math.min(limit, d.baseline + agg));
  d.setFiring(true);
}

export default function App({ deviceClientFactory, requestDeviceTauri }: AppProps = {}) {
  // Native capabilities come from props first (standalone mount), otherwise from
  // NativeBridge (inside the unified shell). Both paths coexist because Android has
  // no hot update: getting the injection interface wrong would mute all three modules
  // at once, and the broken build sticks around on users' phones for a long time, so
  // the old injection point stays until the new path is proven stable.
  const native = useNativeBridge();
  // The nickname comes from the unified account; when signed out it falls back to the
  // locally saved name, then to anonymous. A flaky account service must not lock
  // people out of a room, so there is always a usable value here.
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('dg-chat-name') ?? '');
  const [createRoomOpen, setCreateRoomOpen] = useState(
    () => new URL(window.location.href).searchParams.get('create') === '1',
  );
  const showChat = useCallback(() => {
    if (window.location.pathname === '/chat') return;
    window.history.pushState(null, '', '/chat');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('create') !== '1') return;
    url.searchParams.delete('create');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  /** Whether there is an account at all. The unified shell also requires a verified email. */
  const [signedIn, setSignedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [accountRequired, setAccountRequired] = useState(false);
  /** The conversation currently open, if any. Its name is only for the header. */
  const [dmPeer, setDmPeer] = useState<{ id: string; name: string; room: string } | null>(null);
  const [dmError, setDmError] = useState<string | null>(null);
  /**
   * Device control has been handed off (switched to another module). As far as the
   * room is concerned, this is the same as the device being uncontrollable.
   */
  const [deviceReleased, setDeviceReleased] = useState(false);
  /**
   * The account handle, kept alongside the display name so an avatar in the
   * room can open the right profile. Null while signed out, which is the
   * common case — a room peer is anonymous unless they chose otherwise.
   */
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    me()
      .then((u) => {
        setSignedIn(u != null);
        if (u) {
          setDisplayName(u.displayName);
          setUsername(u.username);
        }
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true));
  }, []);
  const [activeTab, setActiveTab] = useState<'chat' | 'control'>('chat');
  const [agentOpen, setAgentOpen] = useState(false);
  const inShell = useInShell();
  const openShellSettings = useOpenShellSettings();
  const requireAccount = useCallback(() => {
    if (signedIn) return true;
    setAccountRequired(true);
    openShellSettings('account');
    return false;
  }, [openShellSettings, signedIn]);
  const [allowAi, setAllowAi] = useState(() => localStorage.getItem('dg-chat-allow-ai') === '1');
  // The theme is owned by the shell (the shared store in @0xnullai/ui); this module no
  // longer has a toggle of its own.

  const [queueA, setQueueA] = useState<string[]>([]);
  const [queueB, setQueueB] = useState<string[]>([]);
  const [playModeA, setPlayModeA] = useState<PlayMode>('single');
  const [playModeB, setPlayModeB] = useState<PlayMode>('single');
  const [intervalASec, setIntervalASec] = useState(30);
  const [intervalBSec, setIntervalBSec] = useState(30);
  const [currentIndexA, setCurrentIndexA] = useState(0);
  const [currentIndexB, setCurrentIndexB] = useState(0);

  const fireBoostsA = useRef<Map<string, { boost: number; ts: number }>>(new Map());
  const fireBoostsB = useRef<Map<string, { boost: number; ts: number }>>(new Map());
  const baselineARef = useRef(0);
  const baselineBRef = useRef(0);
  const [firingA, setFiringA] = useState(false);
  const [firingB, setFiringB] = useState(false);

  const peerRoom = usePeerRoom(displayName);

  // A room link joins directly; otherwise the account room list remains visible without
  // silently entering a special global room.
  const initialRoomOpened = useRef(false);
  useEffect(() => {
    if (!authChecked) return;
    if (initialRoomOpened.current) return;
    if (peerRoom.connected || peerRoom.status === 'connecting') return;
    // A conversation that cannot connect keeps retrying on its own (the transport re-mints a
    // ticket every attempt). Without this guard, its first failed attempt would land here and
    // drop the user into the public room instead.
    if (peerRoom.isDm) return;
    const fromUrl = new URLSearchParams(window.location.search).get('room');
    initialRoomOpened.current = true;
    if (fromUrl && signedIn) peerRoom.join(fromUrl);
    else if (fromUrl) queueMicrotask(() => requireAccount());
    // Only attempt once while still not connected; putting peerRoom in the deps would
    // reconnect on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, signedIn, peerRoom.connected, peerRoom.status, peerRoom.isDm, requireAccount]);

  /**
   * Open a conversation with an account.
   *
   * The ticket does two things at once: it is the admission the Worker checks, and it is how
   * the client learns where the conversation lives — the id is derived server-side from the
   * two account ids and is never computed here.
   *
   * Null covers "you two are not mutual follows", "one of you blocked the other" and "the
   * account service is unreachable", deliberately without distinguishing them, so the message
   * has to be about what the user can do rather than about which of those it was.
   */
  const openDm = useCallback(
    async (request: DmRequest) => {
      setDmError(null);
      const ticket = await dmTicket(request.accountId);
      if (!ticket) {
        setDmError('无法开始私聊，需要双方互相关注');
        return;
      }
      setDmPeer({
        id: request.accountId,
        name: request.displayName || request.username || '私聊',
        room: ticket.room,
      });
      peerRoom.join(ticket.room, {
        dm: {
          peerUserId: request.accountId,
          firstTicket: ticket.ticket,
          firstExpiresAt: ticket.expiresAt,
        },
      });
    },
    [peerRoom],
  );

  // The entry point is somebody's profile, which is nowhere near this module — see
  // openDirectMessage in @0xnullai/auth. Subscribing also picks up a request made before this
  // module finished loading, which is the normal case: the first press of 私聊 is what causes
  // Chat to be mounted at all.
  useEffect(() => subscribeDmRequest((request) => void openDm(request)), [openDm]);

  // Reading a conversation is what moves its unread mark. It has to be the newest message's
  // own timestamp rather than "now": a reconnect replays the whole retained history, and
  // marking up to the present would swallow anything that arrived during the gap.
  useEffect(() => {
    if (!dmPeer || peerRoom.roomId !== dmPeer.room) return;
    const last = peerRoom.messages[peerRoom.messages.length - 1];
    if (last) markDmRead(dmPeer.room, last.timestamp);
  }, [dmPeer, peerRoom]);
  const device = useDevice({
    clientFactory:
      deviceClientFactory ?? (native.chat?.deviceClientFactory as typeof deviceClientFactory),
    requestDevice: requestDeviceTauri ?? (native.chat?.requestDevice as typeof requestDeviceTauri),
  });
  const waveforms = useWaveforms();

  // Keep the reference fresh so closures do not go stale
  const deviceRef = useRef(device);
  // Refreshing the "latest value" ref during render is deliberate: moving it into an
  // effect would make it update one commit late, and device commands could then read a
  // stale reference. To be handled by a dedicated useEffectEvent refactor; not changing
  // behavior inside a structural merge.
  // eslint-disable-next-line react-hooks/refs
  deviceRef.current = device;

  // Register with the global safety bus — the only data source for the shell's global
  // stop button. This matters most in Chat: other people in the room can issue commands,
  // and once this module is switched away its own stop button cannot be reached.
  // Restore the controllable state once control is regained.
  useEffect(() => {
    const sync = () => setDeviceReleased(!hasDeviceLease('chat'));
    sync();
    return subscribeSafetySessions(sync);
  }, []);

  useSafetySession({
    id: 'chat',
    label: 'Chat',
    // Any device, not just the Coyote. This gated on the Coyote alone, so an
    // Opossum-only session reported no active session — and the shell's stop
    // button renders from that, meaning there was no stop button while a
    // device was running on the user's body.
    isActive: () =>
      deviceRef.current.connected ||
      Boolean(deviceRef.current.opossum?.connected) ||
      Boolean(deviceRef.current.sensor?.connected),
    stop: () => deviceRef.current.stopAll(),
    connect: () => deviceRef.current.connectDevice(),
    disconnect: (deviceId) => {
      if (deviceId === 'opossum') return deviceRef.current.disconnectOpossum();
      if (deviceId === 'sensor') return deviceRef.current.disconnectSensor();
      return deviceRef.current.disconnectCoyote(deviceId);
    },
    onRevoke: () => {
      // All three of these are required.
      // 1) Stop the output.
      deviceRef.current.stopAll();
      // 2) Clear the fire aggregation. It snapshots the baseline on the empty →
      //    non-empty edge, so if the lease is revoked while someone is holding fire,
      //    the matching fire_release never arrives, the map is never cleared, and
      //    strength stays at baseline+boost instead of falling back — the generic stop
      //    does not cover this cleanup path.
      fireBoostsA.current.clear();
      fireBoostsB.current.clear();
      baselineARef.current = 0;
      baselineBRef.current = 0;
      // 3) Tell the room. Reuse the existing deviceConnected field instead of adding a
      //    new message type — a new type is silently ignored by old clients, whereas the
      //    other side already renders this field as 「未连接设备」.
      //    Without the broadcast the host sees the command go out with no reaction, and
      //    the instinctive response is to crank it up and resend.
      setDeviceReleased(true);
    },
    devices: () => {
      const d = deviceRef.current;
      return [
        // One entry per attached Coyote, each under its own device id. They
        // used to all report id 'coyote', so two hosts collided on the device
        // bar's `sessionId:deviceId` key and React dropped the second — the
        // user lost the on-screen proof that it was attached to them.
        ...d.coyotes
          .filter((c) => c.connected)
          .map((c) => ({
            id: c.id,
            kind: 'coyote',
            name: c.name,
            connected: true,
            ...(typeof c.battery === 'number' ? { battery: c.battery } : {}),
            active: isCoyoteOutputActive(c),
            channels: [
              { label: 'A', value: c.strengthA, max: c.limitA },
              { label: 'B', value: c.strengthB, max: c.limitB },
            ],
          })),
        ...(d.opossum?.connected
          ? [
              {
                id: 'opossum',
                kind: 'opossum',
                name: '负鼠',
                connected: true,
                ...(typeof d.opossum.battery === 'number' ? { battery: d.opossum.battery } : {}),
                active: (d.opossum.intensityA ?? 0) > 0 || (d.opossum.intensityB ?? 0) > 0,
                channels: [
                  { label: 'A', value: d.opossum.intensityA, max: d.opossum.limitA },
                  { label: 'B', value: d.opossum.intensityB, max: d.opossum.limitB },
                ],
              },
            ]
          : []),
        ...(d.sensor?.connected
          ? [
              {
                id: 'sensor',
                kind: d.sensor.kind ?? 'paw-prints',
                name: d.sensor.kind === 'civet-edging' ? '灵猫' : '爪印',
                connected: true,
                ...(typeof d.sensor.battery === 'number' ? { battery: d.sensor.battery } : {}),
                ...(typeof d.sensor.lastValue === 'number'
                  ? {
                      readings: [
                        {
                          value: d.sensor.lastValue,
                          ...(d.sensor.kind === 'civet-edging' ? { unit: 'kPa' } : {}),
                        },
                      ],
                    }
                  : {}),
              },
            ]
          : []),
      ];
    },
  });
  const waveformsRef = useRef(waveforms);
  // Refreshing the "latest value" ref during render is deliberate: moving it into an
  // effect would make it update one commit late, and device commands could then read a
  // stale reference. To be handled by a dedicated useEffectEvent refactor; not changing
  // behavior inside a structural merge.
  // eslint-disable-next-line react-hooks/refs
  waveformsRef.current = waveforms;

  const callApplyFire = useCallback((channel: 'A' | 'B') => {
    applyFire({
      channel,
      boosts: channel === 'A' ? fireBoostsA.current : fireBoostsB.current,
      baseline: channel === 'A' ? baselineARef.current : baselineBRef.current,
      device: deviceRef.current as unknown as FireApplyDeps['device'],
      policy: deviceRef.current.firePolicyRef.current,
      setFiring: channel === 'A' ? setFiringA : setFiringB,
    });
  }, []);

  useEffect(() => {
    if (displayName) localStorage.setItem('dg-chat-name', displayName);
  }, [displayName]);

  // usePeerRoom returns a fresh aggregate object whenever room state changes, while these
  // callbacks are deliberately stable and route through refs inside the hook. Depending on
  // the aggregate would therefore re-register handlers and restart heartbeats for unrelated
  // room updates (messages, presence, host changes). Keep the lifecycle tied to the stable
  // capabilities and the specific scalar state each operation actually consumes.
  const {
    notifyLocal,
    setCommandHandler,
    roomId,
    mediaUploadToken,
    sendMessage,
    setWaveformHandler,
    sendCommand: sendRoomCommand,
    connected: roomConnected,
    broadcastStateFast,
    broadcastStateSlow,
  } = peerRoom;
  const { addRemoteWaveform } = waveforms;

  // Register the remote command handler
  /**
   * The shared safety policy, applied to AI-issued commands.
   *
   * Chat was the only module with an AI-to-device path that never touched
   * @dg-kit/safety's PolicyEngine — Agent and Voice both do. Its AI could
   * move a channel by ±50 in a single call (Agent's cap is ±10), with no
   * cold-start clamp, so a device sitting at 0 under a cap of 50 could be
   * taken to 50 by one tool call. That is a second copy of clamping logic
   * evolving on its own, which CLAUDE.md forbids outright.
   *
   * Scoped to AI commands on purpose. Human peers drag sliders, and
   * step-adjust's ±10 would make that crawl; they also consent differently —
   * per session, by being in the room and holding the lease, not per
   * command. Which is also why permission-gate is dropped: Chat's consent
   * for the AI is `allowAi`, granted once by the device's owner, and there
   * is no per-command confirm UI on this path to answer it.
   */
  const policyRef = useRef<PolicyEngine | null>(null);
  useEffect(() => {
    const rebuild = () => {
      policyRef.current = new PolicyEngine(
        createDefaultPolicyRules(loadDeviceSafety()).filter((r) => r.name !== 'permission-gate'),
      );
    };
    rebuild();
    return subscribeDeviceSafety(rebuild);
  }, []);

  const handleCommand = useCallback(
    (cmd: DeviceCommand, peerId: string) => {
      // Hard-reject when we do not hold the device lease. **It has to be blocked here**
      // rather than by only disabling UI buttons: commands from other people in the room
      // and from the AI travel over the WebRTC data channel and never touch the UI.
      //
      // Stop commands are the exception — handing off control must not take away other
      // people's ability to stop your device.
      if (!hasDeviceLease('chat') && cmd.action !== 'fire_release' && cmd.action !== 'stop') {
        return;
      }
      // Queue intent: update the local authoritative state. broadcastStateSlow syncs it
      // out to everyone from an effect.
      // After a queue change, if the currently playing waveform is still in the new
      // queue, align the index to it so index and playback do not briefly disagree.
      if (cmd.action === 'set_queue' && cmd.c && cmd.q) {
        const q = cmd.q;
        const playing = cmd.c === 'A' ? deviceRef.current.waveIdA : deviceRef.current.waveIdB;
        const aligned = playing ? q.indexOf(playing) : -1;
        const nextIdx = aligned >= 0 ? aligned : 0;
        if (cmd.c === 'A') {
          setQueueA(q);
          setCurrentIndexA(nextIdx);
        } else {
          setQueueB(q);
          setCurrentIndexB(nextIdx);
        }
        return;
      }
      if (cmd.action === 'set_play_mode' && cmd.c && cmd.mode) {
        if (cmd.c === 'A') setPlayModeA(cmd.mode);
        else setPlayModeB(cmd.mode);
        return;
      }
      if (cmd.action === 'set_interval' && cmd.c && cmd.iv != null) {
        if (cmd.c === 'A') setIntervalASec(cmd.iv);
        else setIntervalBSec(cmd.iv);
        return;
      }
      if (cmd.action === 'fire_active' && cmd.c && cmd.v != null) {
        const map = cmd.c === 'A' ? fireBoostsA.current : fireBoostsB.current;
        if (map.size === 0) {
          // Empty → non-empty edge: snapshot the baseline
          const dev = deviceRef.current;
          if (cmd.c === 'A') baselineARef.current = dev.strengthA;
          else baselineBRef.current = dev.strengthB;
        }
        map.set(peerId, { boost: cmd.v, ts: Date.now() });
        callApplyFire(cmd.c);
        return;
      }
      if (cmd.action === 'fire_release' && cmd.c) {
        const map = cmd.c === 'A' ? fireBoostsA.current : fireBoostsB.current;
        map.delete(peerId);
        callApplyFire(cmd.c);
        return;
      }
      // Strength delta: v = signed delta, the owner accumulates it and clamps. Safe under
      // concurrent controllers (every message is added on top).
      // If a fire is in progress, add it to the baseline as well, otherwise this
      // increment gets wiped out on release.
      if (cmd.action === 'adjust_strength' && cmd.c && cmd.v != null) {
        const dev = deviceRef.current;
        const channel = cmd.c;
        let delta = cmd.v;
        // Evaluated on the device holder's side, the only side that can be
        // trusted with the cap (CLAUDE.md constraint 2).
        if (peerId.startsWith('ai:')) {
          const decision = policyRef.current?.evaluate({
            context: { sessionId: 'chat-room', sourceType: 'api', traceId: peerId },
            command: { type: 'adjustStrength', channel, delta },
            deviceState: {
              connected: dev.connected,
              strengthA: dev.strengthA,
              strengthB: dev.strengthB,
              limitA: dev.limitA,
              limitB: dev.limitB,
              waveActiveA: dev.waveActiveA,
              waveActiveB: dev.waveActiveB,
            },
          });
          if (decision && decision.type !== 'allow') {
            if (decision.type === 'clamp' && decision.command.type === 'adjustStrength') {
              delta = decision.command.delta;
            } else {
              // deny, or a require-confirm nobody can answer on this path.
              return;
            }
          }
        }
        const limit = channel === 'A' ? dev.limitA : dev.limitB;
        const boosts = channel === 'A' ? fireBoostsA.current : fireBoostsB.current;
        if (boosts.size > 0) {
          const baseRef = channel === 'A' ? baselineARef : baselineBRef;
          baseRef.current = Math.max(0, Math.min(limit, baseRef.current + delta));
          callApplyFire(channel); // recompute baseline+agg → setStrength
        } else {
          const current = channel === 'A' ? dev.strengthA : dev.strengthB;
          dev.setStrength(channel, Math.max(0, Math.min(limit, current + delta)));
        }
        return;
      }
      // Opossum strength delta: same semantics as adjust_strength, but applied to the
      // Opossum intensity, reusing the same limitA/limitB safety caps (v1 simplification:
      // no multi-controller fire aggregation).
      if (cmd.action === 'vibrate_adjust' && cmd.c && cmd.v != null) {
        const dev = deviceRef.current;
        const limit = cmd.c === 'A' ? dev.limitA : dev.limitB;
        const current =
          cmd.c === 'A' ? (dev.opossum?.intensityA ?? 0) : (dev.opossum?.intensityB ?? 0);
        dev.setOpossumIntensity(cmd.c, Math.max(0, Math.min(limit, current + cmd.v)));
        return;
      }

      const ctx: CommandContext = {
        device: deviceRef.current.connected
          ? (deviceRef.current as unknown as CommandContext['device'])
          : null,
        getWaveform: waveformsRef.current.getWaveform,
        session: {
          opossumConnected: !!deviceRef.current.opossum?.connected,
          sensorConnected: !!deviceRef.current.sensor?.connected,
          setOpossumIntensity: deviceRef.current.setOpossumIntensity,
          opossumBurst: deviceRef.current.opossumBurst,
          opossumStop: deviceRef.current.opossumStop,
          setOpossumPattern: deviceRef.current.setOpossumPattern,
          setLedColor: deviceRef.current.setLedColor,
        },
        notify: notifyLocal,
      };
      executeCommand(cmd, ctx);
    },
    [callApplyFire, notifyLocal],
  );

  useEffect(() => {
    setCommandHandler(handleCommand);
  }, [setCommandHandler, handleCommand]);

  // Upload the media to R2, then send it out as a chat message.
  const sendMedia = useCallback(
    async (
      blob: Blob,
      kind: 'image' | 'audio',
      meta?: { durationMs?: number; w?: number; h?: number },
    ) => {
      const room = roomId;
      const mediaToken = mediaUploadToken;
      if (!room || !mediaToken) return;
      try {
        const media = await uploadMedia(room, mediaToken, blob, kind, meta);
        sendMessage('', media);
      } catch (err) {
        console.error('[Chat] media upload failed', err);
      }
    },
    [roomId, mediaUploadToken, sendMessage],
  );

  const handleWaveform = useCallback(
    (transfer: WaveformTransfer, _peerId: string) => {
      addRemoteWaveform({
        id: transfer.wid,
        name: transfer.wn,
        description: '',
        frames: transfer.fr,
        modality: transfer.modality ?? 'electrostimulation',
        custom: true,
      });
    },
    [addRemoteWaveform],
  );

  useEffect(() => {
    setWaveformHandler(handleWaveform);
  }, [setWaveformHandler, handleWaveform]);

  const sendCommand = useCallback(
    (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => {
      const cmd: DeviceCommand = { action, ...params };
      if (target === 'self') handleCommand(cmd, 'self');
      else sendRoomCommand(target, action, params);
    },
    [sendRoomCommand, handleCommand],
  );

  // High-frequency state: broadcast immediately when strength / current waveform changes
  // (the hook throttles to 200ms internally)
  useEffect(() => {
    if (!roomConnected) return;
    broadcastStateFast({
      strengthA: device.strengthA,
      strengthB: device.strengthB,
      waveA: device.waveIdA,
      waveB: device.waveIdB,
      firingA,
      firingB,
      opossumIntensityA: device.opossum?.intensityA,
      opossumIntensityB: device.opossum?.intensityB,
      opossumLastButtons: device.opossum?.lastButtons ?? null,
      sensorLastEvent: device.sensor?.lastEvent ?? null,
      sensorLastValue: device.sensor?.lastValue ?? null,
      sensorLastEventAt: device.sensor?.lastEventAt ?? null,
    });
  }, [
    roomConnected,
    broadcastStateFast,
    device.strengthA,
    device.strengthB,
    device.waveIdA,
    device.waveIdB,
    firingA,
    firingB,
    device.opossum?.intensityA,
    device.opossum?.intensityB,
    device.opossum?.lastButtons,
    device.sensor?.lastEvent,
    device.sensor?.lastValue,
    device.sensor?.lastEventAt,
  ]);

  // Low-frequency state: a 5s heartbeat plus an immediate sync when the name / battery /
  // connection / catalog changes
  useEffect(() => {
    if (!roomConnected) return;
    const send = () => {
      broadcastStateSlow({
        displayName,
        username,
        deviceConnected: device.connected && !deviceReleased,
        battery: device.battery,
        waveformCatalog: waveformsRef.current.allWaveforms.map((w) => ({
          id: w.id,
          name: w.name,
          custom: !!w.custom,
          modality: w.modality ?? 'electrostimulation',
        })),
        queueA,
        queueB,
        playModeA,
        playModeB,
        intervalA: intervalASec,
        intervalB: intervalBSec,
        currentIndexA,
        currentIndexB,
        allowAi,
        opossumConnected: device.opossum?.connected ?? false,
        opossumBattery: device.opossum?.battery ?? null,
        // Must resolve to explicit null (not undefined) when disconnected —
        // JSON.stringify drops undefined keys entirely, and the receiver
        // treats a missing key as "no update" (falls back to its cached
        // value) rather than "cleared". See use-peer-room.ts's receive side.
        sensorKind: device.sensor?.kind ?? null,
        sensorConnected: device.sensor?.connected ?? false,
        sensorBattery: device.sensor?.battery ?? null,
      });
    };
    send();
    const t = setInterval(send, 5000);
    return () => clearInterval(t);
  }, [
    roomConnected,
    broadcastStateSlow,
    displayName,
    username,
    device.connected,
    deviceReleased,
    device.battery,
    waveforms.allWaveforms.length,
    queueA,
    queueB,
    playModeA,
    playModeB,
    intervalASec,
    intervalBSec,
    currentIndexA,
    currentIndexB,
    allowAi,
    device.opossum?.connected,
    device.opossum?.battery,
    device.sensor?.kind,
    device.sensor?.connected,
    device.sensor?.battery,
  ]);

  // Persist the "allow AI control" toggle.
  useEffect(() => {
    localStorage.setItem('dg-chat-allow-ai', allowAi ? '1' : '0');
  }, [allowAi]);

  // The room agent's brain (only actually runs in the host's browser; triggered by @-ing it).
  const agentDeviceTargets: AgentDeviceTarget[] = [...peerRoom.members.values()]
    .filter((m) => !m.isAi && m.deviceConnected && m.allowAi)
    .map((m) => ({ peerId: m.peerId, name: m.displayName || m.peerId.slice(0, 6) }));
  useRoomAgents({
    isHost: peerRoom.isHost,
    agent: peerRoom.agent,
    members: peerRoom.members,
    messages: peerRoom.messages,
    deviceTargets: agentDeviceTargets,
    sendChatAs: peerRoom.sendChatAs,
    sendCommandAs: peerRoom.sendCommandAs,
  });

  // A/B channels: the controlled side authoritatively rotates on a timer (it holds the
  // source of truth)
  useChannelRotation(
    'A',
    device.waveIdA,
    queueA,
    playModeA,
    intervalASec,
    setCurrentIndexA,
    deviceRef,
    waveformsRef,
  );
  useChannelRotation(
    'B',
    device.waveIdB,
    queueB,
    playModeB,
    intervalBSec,
    setCurrentIndexB,
    deviceRef,
    waveformsRef,
  );

  // Heartbeat expiry reaper: fire_active arrives every 300ms, so going more than 800ms
  // without a refresh counts as a release.
  // A normal release goes through fire_release at QoS 1 and falls back immediately; any
  // abnormal path (page closed / packet loss / crash) is backstopped here, reaching zero
  // within ~1s at worst.
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      let dirtyA = false,
        dirtyB = false;
      fireBoostsA.current.forEach((v, k) => {
        if (now - v.ts > 800) {
          fireBoostsA.current.delete(k);
          dirtyA = true;
        }
      });
      fireBoostsB.current.forEach((v, k) => {
        if (now - v.ts > 800) {
          fireBoostsB.current.delete(k);
          dirtyB = true;
        }
      });
      if (dirtyA) callApplyFire('A');
      if (dirtyB) callApplyFire('B');
    }, 200);
    return () => clearInterval(t);
  }, [callApplyFire]);

  return (
    <ChatAppView
      signedIn={signedIn}
      accountRequired={accountRequired}
      createRoomOpen={createRoomOpen}
      setCreateRoomOpen={setCreateRoomOpen}
      displayName={displayName}
      username={username}
      dmPeer={dmPeer}
      setDmPeer={setDmPeer}
      dmError={dmError}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      agentOpen={agentOpen}
      setAgentOpen={setAgentOpen}
      inShell={inShell}
      allowAi={allowAi}
      setAllowAi={setAllowAi}
      peerRoom={peerRoom}
      device={device}
      waveforms={waveforms}
      queueA={queueA}
      queueB={queueB}
      playModeA={playModeA}
      playModeB={playModeB}
      intervalASec={intervalASec}
      intervalBSec={intervalBSec}
      currentIndexA={currentIndexA}
      currentIndexB={currentIndexB}
      firingA={firingA}
      firingB={firingB}
      showChat={showChat}
      requireAccount={requireAccount}
      openDm={openDm}
      openAiSettings={() => openShellSettings('ai')}
      sendMedia={sendMedia}
      sendCommand={sendCommand}
    />
  );
}
