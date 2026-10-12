import { markGroupRead } from './group-inbox';
import type { ChatReplyContext } from './lib/protocol';
import {
  deviceConversationAccess,
  setDeviceConversationAccess,
  subscribeDeviceConversationAccess,
  readPreference,
  writePreference,
} from '@0xnullai/settings';
import { useOpenShellSettings, useInShell, useSafetySession } from '@0xnullai/ui';
import { hasDeviceLease, subscribeSafetySessions } from '@dg-kit/safety';
import { useDgLabRegistry } from '@0xnullai/native';
import {
  currentAuthUserId,
  subscribeAuthChanges,
  dmConversations,
  dmTicket,
  me,
  subscribeDmRequest,
  type DmRequest,
} from '@0xnullai/auth';
import { useChannelRotation, useDevice } from '@0xnullai/device-runtime';
import { useWaveforms } from '@0xnullai/waveforms';
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { usePeerRoom } from './hooks/use-peer-room';
import { executeCommand, type CommandContext } from './lib/commands';
import { CancelledFireHolds } from './lib/fire-cancel';
import { selectChatInboxConversation, subscribeChatInboxSelection } from './inbox';
import { initialChatTarget } from './lib/initial-chat-target';
import { subscribeChatRouteChanges } from './lib/chat-route-changes';
import { chatConversationAllowsCommand } from './lib/conversation-device-policy';
import { markDmRead } from './inbox';
import { sendRoomMedia } from './lib/send-room-media';
import type { DeviceCommand, CmdAction, PlayMode, WaveformTransfer } from './lib/protocol';
import { ChatAppView } from './components/ChatAppView';

type FirePolicy = 'sum' | 'max' | 'avg';

/**
 * Several controllers holding fire combine by taking the largest boost. This was the default of
 * the removed per-user chooser; a fixed value avoids a stale stored 'sum' that nobody can see.
 */
const CHAT_FIRE_POLICY: FirePolicy = 'max';

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

export default function App() {
  // The nickname comes from the unified account; when signed out it falls back to the
  // locally saved name, then to anonymous. A flaky account service must not lock
  // people out of a room, so there is always a usable value here.
  const [displayName, setDisplayName] = useState(() => readPreference('dg-chat-name') ?? '');
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
  /**
   * Whether there is an account at all. The unified shell also requires a verified email.
   * Seeded from the shell's session: the first inbox selection mounts this module and is
   * delivered before `me()` below returns, and must not be mistaken for a signed-out user.
   */
  const [signedIn, setSignedIn] = useState(() => currentAuthUserId() !== null);
  const [authChecked, setAuthChecked] = useState(false);
  const [accountRequired, setAccountRequired] = useState(false);
  /** The conversation currently open, if any. Its name is only for the header. */
  const [dmPeer, setDmPeer] = useState<{ id: string; name: string; room: string } | null>(null);
  const dmAdmission = useRef<{ account: string; room: string } | null>(null);
  const dmOpenGeneration = useRef(0);
  useEffect(() => {
    let previous = currentAuthUserId();
    return subscribeAuthChanges(() => {
      const next = currentAuthUserId();
      if (next !== previous) {
        dmAdmission.current = null;
        dmOpenGeneration.current++;
        setSignedIn(Boolean(next));
      }
      previous = next;
    });
  }, []);
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
  const cancelledFire = useRef(new CancelledFireHolds());
  const [firingA, setFiringA] = useState(false);
  const [firingB, setFiringB] = useState(false);

  const peerRoom = usePeerRoom(displayName);
  const conversationDeviceEnabled = useSyncExternalStore(
    subscribeDeviceConversationAccess,
    () =>
      deviceConversationAccess(
        currentAuthUserId(),
        peerRoom.isDm ? 'dm' : 'group',
        peerRoom.roomId ?? '',
      ),
    () => false,
  );

  const activeRoomRef = useRef<{ roomId: string | null; mediaToken: string | null }>({
    roomId: null,
    mediaToken: null,
  });
  useEffect(() => {
    activeRoomRef.current = {
      roomId: peerRoom.roomId,
      mediaToken: peerRoom.mediaUploadToken,
    };
  }, [peerRoom.mediaUploadToken, peerRoom.roomId]);

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
      const account = currentAuthUserId();
      const generation = ++dmOpenGeneration.current;
      dmAdmission.current = null;
      setDmError(null);
      const ticket = await dmTicket(request.accountId);
      if (!account || currentAuthUserId() !== account || generation !== dmOpenGeneration.current)
        return;
      if (!ticket) {
        setDmError('无法开始私聊，需要双方互相关注');
        return;
      }
      dmAdmission.current = { account, room: ticket.room };
      setDmPeer({
        id: request.accountId,
        name: request.displayName || request.username || '私聊',
        room: ticket.room,
      });
      // A link or notification names only the account; fill in the person's name.
      if (!request.displayName && !request.username)
        void dmConversations().then((list) => {
          const peer = list?.conversations.find((entry) => entry.id === request.accountId);
          if (!peer || generation !== dmOpenGeneration.current || currentAuthUserId() !== account)
            return;
          setDmPeer((current) =>
            current?.id === peer.id
              ? { ...current, name: peer.displayName || peer.username || current.name }
              : current,
          );
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

  // Direct links must recover through the same server-minted admission as an in-app selection.
  // In particular, a DM URL is only a peer account id; it is never an authorization ticket.
  const initialConversationOpened = useRef(false);
  const initialAccountPrompted = useRef(false);
  useEffect(() => {
    if (!authChecked || initialConversationOpened.current) return;
    const target = initialChatTarget(window.location.search);
    if (!target) {
      initialConversationOpened.current = true;
      return;
    }
    if (!signedIn || !currentAuthUserId()) {
      if (!initialAccountPrompted.current) {
        initialAccountPrompted.current = true;
        queueMicrotask(() => requireAccount());
      }
      return;
    }
    // A live in-app selection wins if it arrived before this startup effect.
    if (peerRoom.connected || peerRoom.status === 'connecting' || peerRoom.isDm) {
      initialConversationOpened.current = true;
      return;
    }
    initialConversationOpened.current = true;
    if (target.kind === 'dm') queueMicrotask(() => void openDm({ accountId: target.accountId }));
    else peerRoom.join(target.code);
  }, [authChecked, signedIn, openDm, peerRoom, requireAccount]);

  // A notification can change only the query while Chat stays mounted. Reuse
  // the inbox selection path so a DM gets a fresh server ticket, and let the
  // room join path recheck membership before opening a group.
  useEffect(
    () =>
      subscribeChatRouteChanges({
        accountId: currentAuthUserId,
        openCreate: () => {
          setActiveTab('chat');
          setCreateRoomOpen(true);
        },
        isCurrent: (target) => {
          if (peerRoom.status !== 'connected' && peerRoom.status !== 'connecting') return false;
          return target.kind === 'dm'
            ? peerRoom.isDm && dmPeer?.id === target.accountId
            : !peerRoom.isDm && peerRoom.roomId === target.code;
        },
        select: (target) =>
          selectChatInboxConversation(
            target.kind === 'dm'
              ? { kind: 'dm', peer: { accountId: target.accountId } }
              : { kind: 'group', code: target.code },
          ),
      }),
    [dmPeer?.id, peerRoom.isDm, peerRoom.roomId, peerRoom.status],
  );

  // The entry point is somebody's profile, which is nowhere near this module — see
  // openDirectMessage in @0xnullai/auth. Subscribing also picks up a request made before this
  // module finished loading, which is the normal case: the first press of 私聊 is what causes
  // Chat to be mounted at all.
  // The address names the open conversation, so a reload returns to it and the link can
  // be shared. A DM link names only the peer account, never a ticket.
  useEffect(() => {
    if (window.location.pathname !== '/chat') return;
    const params = new URLSearchParams(window.location.search);
    const wanted =
      peerRoom.isDm && dmPeer?.id
        ? { key: 'dm', value: dmPeer.id }
        : !peerRoom.isDm && peerRoom.roomId
          ? { key: 'room', value: peerRoom.roomId }
          : null;
    if (!wanted || params.get(wanted.key) === wanted.value) return;
    const next = new URLSearchParams();
    next.set(wanted.key, wanted.value);
    window.history.replaceState(window.history.state, '', `/chat?${next.toString()}`);
  }, [dmPeer?.id, peerRoom.isDm, peerRoom.roomId]);

  useEffect(() => subscribeDmRequest((request) => void openDm(request)), [openDm]);
  useEffect(
    () =>
      subscribeChatInboxSelection((selection) => {
        if (!requireAccount()) return;
        setActiveTab('chat');
        if (selection.kind === 'dm') void openDm(selection.peer);
        else {
          setDmPeer(null);
          peerRoom.join(selection.code);
        }
      }),
    [openDm, peerRoom, requireAccount],
  );

  const acknowledgeVisibleDm = useCallback(
    async (messageId: string, stillVisible: () => boolean) => {
      const admission = dmAdmission.current;
      if (
        !admission ||
        !dmPeer ||
        admission.room !== dmPeer.room ||
        peerRoom.roomId !== dmPeer.room
      )
        throw new Error('聊天已切换');
      await markDmRead(
        admission.account,
        dmPeer.id,
        dmPeer.room,
        messageId,
        () =>
          dmAdmission.current === admission &&
          activeRoomRef.current.roomId === admission.room &&
          stillVisible() &&
          document.visibilityState === 'visible',
      );
      window.dispatchEvent(new Event('0xnullai:conversation-updated'));
    },
    [dmPeer, peerRoom.roomId],
  );
  const isRoomReadAdmissionCurrent = peerRoom.isReadAdmissionCurrent;
  const acknowledgeVisibleGroup = useCallback(
    async (messageId: string, stillVisible: () => boolean) => {
      const admission = peerRoom.readAdmission;
      if (!admission || peerRoom.isDm || peerRoom.roomId !== admission.room)
        throw new Error('聊天已切换');
      await markGroupRead(
        admission.account,
        admission.room,
        messageId,
        () =>
          isRoomReadAdmissionCurrent(admission) &&
          activeRoomRef.current.roomId === admission.room &&
          stillVisible() &&
          document.visibilityState === 'visible',
      );
      window.dispatchEvent(new Event('0xnullai:conversation-updated'));
    },
    [peerRoom.readAdmission, isRoomReadAdmissionCurrent, peerRoom.isDm, peerRoom.roomId],
  );
  // The app's one DG-Lab registry: the same devices and ids Control and
  // Playground see. Chat writes through a view fenced to the `chat` lease, so a
  // room command that arrives after the lease moved is rejected at the holder.
  const device = useDevice({ moduleId: 'chat', registry: useDgLabRegistry() });
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

  /**
   * A stop ends every fire hold for good: anyone still pressing 开火 must let go and press
   * again, or their next heartbeat would lift the output straight back up.
   */
  const cancelHeldFire = useCallback(() => {
    const now = Date.now();
    cancelledFire.current.cancel('A', fireBoostsA.current.keys(), now);
    cancelledFire.current.cancel('B', fireBoostsB.current.keys(), now);
    fireBoostsA.current.clear();
    fireBoostsB.current.clear();
    baselineARef.current = 0;
    baselineBRef.current = 0;
    setFiringA(false);
    setFiringB(false);
  }, []);
  const stopAllOutput = useCallback(() => {
    cancelHeldFire();
    deviceRef.current.stopAll();
  }, [cancelHeldFire]);

  /**
   * Everything Chat holds that the registry cannot see. Runs on both revoke
   * paths: the safety bus's onRevoke and the registry handle's onRevoked. Both
   * may fire for one lease change; every step is idempotent.
   */
  const dropHeldDeviceState = useCallback(() => {
    // 1) Clear the fire aggregation. It snapshots the baseline on the empty →
    //    non-empty edge, so if the lease is revoked while someone is holding fire,
    //    the matching fire_release never arrives, the map is never cleared, and
    //    strength stays at baseline+boost instead of falling back — the generic stop
    //    does not cover this cleanup path.
    fireBoostsA.current.clear();
    fireBoostsB.current.clear();
    baselineARef.current = 0;
    baselineBRef.current = 0;
    // 2) Tell the room. Reuse the existing deviceConnected field instead of adding a
    //    new message type — a new type is silently ignored by old clients, whereas the
    //    other side already renders this field as 「未连接设备」.
    //    Without the broadcast the host sees the command go out with no reaction, and
    //    the instinctive response is to crank it up and resend.
    setDeviceReleased(true);
  }, []);

  const { onRevoked: onDeviceRevoked } = device;
  useEffect(() => onDeviceRevoked(dropHeldDeviceState), [onDeviceRevoked, dropHeldDeviceState]);

  // Stop, revoke and the shell's connect entry. The devices are listed and
  // disconnected by the registry's own `dglab-devices` session; listing them
  // here as well would show each one twice in the device bar.
  useSafetySession({
    id: 'chat',
    label: 'Chat',
    // Any device, not just the Coyote: an Opossum-only session must still keep
    // the shell's stop button on screen.
    isActive: () =>
      deviceRef.current.connected ||
      Boolean(deviceRef.current.opossum?.connected) ||
      Boolean(deviceRef.current.sensor?.connected),
    stop: stopAllOutput,
    connect: () => deviceRef.current.connectDevice(),
    // The registry already stopped every output on the lease switch. Only drop
    // Chat's held state: a device stop here bypasses the fence and would zero
    // output the new holder starts right after the switch.
    onRevoke: dropHeldDeviceState,
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
      policy: CHAT_FIRE_POLICY,
      setFiring: channel === 'A' ? setFiringA : setFiringB,
    });
  }, []);

  useEffect(() => {
    if (displayName) writePreference('dg-chat-name', displayName);
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
  const handleCommand = useCallback(
    (cmd: DeviceCommand, peerId: string) => {
      if (
        !chatConversationAllowsCommand(
          currentAuthUserId(),
          peerRoom.roomId,
          peerRoom.isDm,
          cmd.action,
        )
      )
        return;
      // Group AIs run on the server and have no device tools; the server also refuses to
      // relay a command under an AI's name. Anything that still claims to be one is dropped.
      if (peerId.startsWith('ai:')) return;
      // Hard-reject when we do not hold the device lease. **It has to be blocked here**
      // rather than by only disabling UI buttons: commands from other people in the room
      // arrive over the room relay and never touch the UI.
      //
      // Stop commands are the exception — handing off control must not take away other
      // people's ability to stop your device.
      if (
        !hasDeviceLease('chat') &&
        !['fire_release', 'stop', 'stop_wave', 'vibrate_stop'].includes(cmd.action)
      ) {
        return;
      }
      if (cmd.action === 'stop') cancelHeldFire();
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
        if (cancelledFire.current.swallow(cmd.c, peerId, Date.now())) return;
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
        cancelledFire.current.release(cmd.c, peerId);
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
        const delta = cmd.v;
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
    [callApplyFire, cancelHeldFire, notifyLocal, peerRoom.roomId, peerRoom.isDm],
  );

  const priorConversationConsent = useRef({ enabled: false, roomId: peerRoom.roomId });
  useEffect(() => {
    const prior = priorConversationConsent.current;
    priorConversationConsent.current = {
      enabled: conversationDeviceEnabled,
      roomId: peerRoom.roomId,
    };
    if (prior.enabled && (!conversationDeviceEnabled || prior.roomId !== peerRoom.roomId)) {
      cancelHeldFire();
      if (hasDeviceLease('chat')) deviceRef.current.stopAll();
    }
  }, [cancelHeldFire, conversationDeviceEnabled, peerRoom.roomId]);

  useEffect(() => {
    setCommandHandler(handleCommand);
  }, [setCommandHandler, handleCommand]);

  // Upload the media to R2, then send it out as a chat message.
  const sendMedia = useCallback(
    async (
      blob: Blob,
      kind: 'image' | 'audio',
      meta?: { durationMs?: number; w?: number; h?: number },
      reply?: ChatReplyContext,
    ) => {
      await sendRoomMedia(
        {
          room: { roomId, mediaToken: mediaUploadToken },
          active: () => activeRoomRef.current,
          send: sendMessage,
        },
        blob,
        kind,
        meta,
        reply,
      );
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
        coyotes: deviceReleased
          ? []
          : device.coyotes
              .filter(({ connected }) => connected)
              .map(({ id, name }) => ({ deviceId: id, name })),
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
        deviceAccess: conversationDeviceEnabled,
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
    device.coyotes,
    waveforms.allWaveforms.length,
    queueA,
    queueB,
    playModeA,
    playModeB,
    intervalASec,
    intervalBSec,
    currentIndexA,
    currentIndexB,
    conversationDeviceEnabled,
    device.opossum?.connected,
    device.opossum?.battery,
    device.sensor?.kind,
    device.sensor?.connected,
    device.sensor?.battery,
  ]);

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
      cancelledFire.current.expire(now, 800);
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
      onDmMessageVisible={acknowledgeVisibleDm}
      onGroupMessageVisible={acknowledgeVisibleGroup}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      agentOpen={agentOpen}
      setAgentOpen={setAgentOpen}
      inShell={inShell}
      conversationDeviceEnabled={conversationDeviceEnabled}
      onSetConversationDeviceEnabled={(enabled) => {
        const stored = setDeviceConversationAccess(
          currentAuthUserId(),
          peerRoom.isDm ? 'dm' : 'group',
          peerRoom.roomId ?? '',
          enabled,
        );
        if (!stored) peerRoom.notifyLocal('设备授权未保存，请重试');
      }}
      peerRoom={peerRoom}
      device={{ ...device, stopAll: stopAllOutput }}
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
      sendMedia={sendMedia}
      sendCommand={sendCommand}
    />
  );
}
