import { useState, useEffect, useCallback, useRef } from 'react';
import { usePeerRoom } from './hooks/use-peer-room';
import { useDevice } from './hooks/use-device';
import { useWaveforms } from './hooks/use-waveforms';
import { executeCommand, type CommandContext } from './lib/commands';
import { RoomEntry } from './components/RoomEntry';
import { SafetyNotice, useSafetyAccepted } from './components/SafetyNotice';
import { ChatPanel } from './components/ChatPanel';
import { ControlPanel } from './components/ControlPanel';
import { SceneDialog } from './components/SceneDialog';
import { SceneMarketDialog } from './components/SceneMarketDialog';
import { AiSettingsDialog } from './components/AiSettingsDialog';
import { DeviceSafetyButton } from './components/DeviceSafetyButton';
import { useRoomAgents, type AgentDeviceTarget } from './hooks/use-room-agents';
import { LogOut, Sun, Moon, Drama, Bot } from 'lucide-react';
import { uploadMedia } from './lib/media';
import type { DeviceClientFactory, RequestDeviceFn } from './lib/bluetooth';
import type { DeviceCommand, MemberState, CmdAction, PlayMode, WaveformTransfer } from './lib/protocol';
import type { WaveFrame } from './lib/waveforms';

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

interface ChannelRotationDevice {
  connected: boolean;
  setWave: (channel: 'A' | 'B', frames: WaveFrame[], id: string, loop: boolean) => void;
}

interface ChannelRotationWaveforms {
  getWaveform: (id: string) => { id: string; name: string; frames: WaveFrame[] } | undefined;
}

function useChannelRotation(
  channel: 'A' | 'B',
  waveId: string | null,
  queue: string[],
  mode: PlayMode,
  intervalSec: number,
  setIndex: React.Dispatch<React.SetStateAction<number>>,
  deviceRef: React.RefObject<ChannelRotationDevice>,
  waveformsRef: React.RefObject<ChannelRotationWaveforms>,
) {
  useEffect(() => {
    if (waveId == null || queue.length <= 1 || mode === 'single') return;
    const t = window.setInterval(() => {
      setIndex(prev => {
        const next = mode === 'random'
          ? Math.floor(Math.random() * queue.length)
          : (prev + 1) % queue.length;
        const wf = waveformsRef.current.getWaveform(queue[next]!);
        const dev = deviceRef.current;
        if (wf && dev.connected) dev.setWave(channel, wf.frames, wf.id, true);
        return next;
      });
    }, intervalSec * 1000);
    return () => clearInterval(t);
  }, [channel, waveId, queue, mode, intervalSec, setIndex, deviceRef, waveformsRef]);
}

type FirePolicy = 'sum' | 'max' | 'avg';

function aggregate(boosts: Map<string, { boost: number; ts: number }>, policy: FirePolicy): number {
  if (boosts.size === 0) return 0;
  const arr = Array.from(boosts.values()).map(x => x.boost);
  if (policy === 'sum') return arr.reduce((a, b) => a + b, 0);
  if (policy === 'max') return Math.max(...arr);
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

interface FireApplyDeps {
  channel: 'A' | 'B';
  boosts: Map<string, { boost: number; ts: number }>;
  baseline: number;
  device: { connected: boolean; limitA: number; limitB: number; setStrength: (c: 'A' | 'B', v: number) => void };
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
  const [displayName, setDisplayName] = useState(() =>
    localStorage.getItem('dg-chat-name') ?? ''
  );
  const [activeTab, setActiveTab] = useState<'chat' | 'control'>('chat');
  const [sceneOpen, setSceneOpen] = useState(false);
  const [sceneMarketOpen, setSceneMarketOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [allowAi, setAllowAi] = useState(() => localStorage.getItem('dg-chat-allow-ai') === '1');
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') ?? 'dark'
  );

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

  const safety = useSafetyAccepted();
  const peerRoom = usePeerRoom(displayName);
  const device = useDevice({ clientFactory: deviceClientFactory, requestDevice: requestDeviceTauri });
  const waveforms = useWaveforms();

  // 保持引用最新，避免闭包过时
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const waveformsRef = useRef(waveforms);
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

  // 注册远程指令处理器
  const handleCommand = useCallback((cmd: DeviceCommand, peerId: string) => {
    // 队列意图：更新本机权威状态。由 broadcastStateSlow 在 effect 里同步给所有人。
    // 队列变更后若当前在播波形仍在新队列里，把 index 对齐到它，避免 index 与播放短暂不一致。
    if (cmd.action === 'set_queue' && cmd.c && cmd.q) {
      const q = cmd.q;
      const playing = cmd.c === 'A' ? deviceRef.current.waveIdA : deviceRef.current.waveIdB;
      const aligned = playing ? q.indexOf(playing) : -1;
      const nextIdx = aligned >= 0 ? aligned : 0;
      if (cmd.c === 'A') { setQueueA(q); setCurrentIndexA(nextIdx); }
      else               { setQueueB(q); setCurrentIndexB(nextIdx); }
      return;
    }
    if (cmd.action === 'set_play_mode' && cmd.c && cmd.mode) {
      if (cmd.c === 'A') setPlayModeA(cmd.mode);
      else               setPlayModeB(cmd.mode);
      return;
    }
    if (cmd.action === 'set_interval' && cmd.c && cmd.iv != null) {
      if (cmd.c === 'A') setIntervalASec(cmd.iv);
      else               setIntervalBSec(cmd.iv);
      return;
    }
    if (cmd.action === 'fire_active' && cmd.c && cmd.v != null) {
      const map = cmd.c === 'A' ? fireBoostsA.current : fireBoostsB.current;
      if (map.size === 0) {
        // 从空到非空的边沿：抓 baseline 快照
        const dev = deviceRef.current;
        if (cmd.c === 'A') baselineARef.current = dev.strengthA;
        else               baselineBRef.current = dev.strengthB;
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
    // 强度增量：v=signed delta，owner 累加并 clamp。多控制者并发安全（每条消息都加上）。
    // 若当前在烧，同步把 baseline 也加上，否则松开时这部分增量会被冲掉。
    if (cmd.action === 'adjust_strength' && cmd.c && cmd.v != null) {
      const dev = deviceRef.current;
      const limit = cmd.c === 'A' ? dev.limitA : dev.limitB;
      const boosts = cmd.c === 'A' ? fireBoostsA.current : fireBoostsB.current;
      if (boosts.size > 0) {
        const baseRef = cmd.c === 'A' ? baselineARef : baselineBRef;
        baseRef.current = Math.max(0, Math.min(limit, baseRef.current + cmd.v));
        callApplyFire(cmd.c); // 重算 baseline+agg → setStrength
      } else {
        const current = cmd.c === 'A' ? dev.strengthA : dev.strengthB;
        dev.setStrength(cmd.c, Math.max(0, Math.min(limit, current + cmd.v)));
      }
      return;
    }
    // Opossum 强度增量：同 adjust_strength 语义，但作用于 Opossum intensity，
    // 复用同一套 limitA/limitB 安全上限（v1 简化：不做多控制者 fire 聚合）。
    if (cmd.action === 'vibrate_adjust' && cmd.c && cmd.v != null) {
      const dev = deviceRef.current;
      const limit = cmd.c === 'A' ? dev.limitA : dev.limitB;
      const current = cmd.c === 'A' ? (dev.opossum?.intensityA ?? 0) : (dev.opossum?.intensityB ?? 0);
      dev.setOpossumIntensity(cmd.c, Math.max(0, Math.min(limit, current + cmd.v)));
      return;
    }

    const ctx: CommandContext = {
      device: deviceRef.current.connected ? (deviceRef.current as unknown as CommandContext['device']) : null,
      getWaveform: waveformsRef.current.getWaveform,
      session: {
        opossumConnected: !!deviceRef.current.opossum?.connected,
        sensorConnected: !!deviceRef.current.sensor?.connected,
        setOpossumIntensity: deviceRef.current.setOpossumIntensity,
        opossumBurst: deviceRef.current.opossumBurst,
        opossumStop: deviceRef.current.opossumStop,
        setLedColor: deviceRef.current.setLedColor,
      },
    };
    executeCommand(cmd, ctx);
  }, [callApplyFire]);

  useEffect(() => {
    peerRoom.setCommandHandler(handleCommand);
  }, [peerRoom.setCommandHandler, handleCommand]);

  // 场景角色头衔派生（peerId → 角色名）。
  const roleNameFor = useCallback((peerId: string): string | undefined => {
    const sc = peerRoom.scene;
    if (!sc) return undefined;
    const entry = Object.entries(peerRoom.roleAssignments).find(([, p]) => p === peerId);
    return entry ? sc.roles.find(r => r.id === entry[0])?.name : undefined;
  }, [peerRoom.scene, peerRoom.roleAssignments]);
  const selfRoleName = roleNameFor(peerRoom.selfId);

  // 上传媒体到 R2 后作为一条聊天消息发出。
  const sendMedia = useCallback(async (
    blob: Blob,
    kind: 'image' | 'audio',
    meta?: { durationMs?: number; w?: number; h?: number },
  ) => {
    const room = peerRoom.roomId;
    if (!room) return;
    try {
      const media = await uploadMedia(room, blob, kind, meta);
      peerRoom.sendMessage('', media);
    } catch (err) {
      console.error('[DG-Chat] media upload failed', err);
    }
  }, [peerRoom.roomId, peerRoom.sendMessage]);

  const handleWaveform = useCallback((transfer: WaveformTransfer, _peerId: string) => {
    waveforms.addRemoteWaveform({
      id: transfer.wid,
      name: transfer.wn,
      description: '',
      frames: transfer.fr,
      custom: true,
    });
  }, [waveforms.addRemoteWaveform]);

  useEffect(() => {
    peerRoom.setWaveformHandler(handleWaveform);
  }, [peerRoom.setWaveformHandler, handleWaveform]);

  const sendCommand = useCallback(
    (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => {
      const cmd: DeviceCommand = { action, ...params };
      if (target === 'self') handleCommand(cmd, 'self');
      else peerRoom.sendCommand(target, action, params);
    },
    [peerRoom.sendCommand, handleCommand],
  );

  // 高频状态：强度 / 当前波形变化时立刻广播（hook 内部 200ms 节流）
  useEffect(() => {
    if (!peerRoom.connected) return;
    peerRoom.broadcastStateFast({
      strengthA: device.strengthA,
      strengthB: device.strengthB,
      waveA: device.waveIdA,
      waveB: device.waveIdB,
      firingA,
      firingB,
      opossumIntensityA: device.opossum?.intensityA,
      opossumIntensityB: device.opossum?.intensityB,
      sensorLastEvent: device.sensor?.lastEvent ?? null,
      sensorLastValue: device.sensor?.lastValue ?? null,
      sensorLastEventAt: device.sensor?.lastEventAt ?? null,
    });
  }, [peerRoom.connected, peerRoom.broadcastStateFast,
      device.strengthA, device.strengthB, device.waveIdA, device.waveIdB,
      firingA, firingB,
      device.opossum?.intensityA, device.opossum?.intensityB,
      device.sensor?.lastEvent, device.sensor?.lastValue, device.sensor?.lastEventAt]);

  // 低频状态：5 秒心跳 + 名字/电量/连接/目录变化时即时同步
  useEffect(() => {
    if (!peerRoom.connected) return;
    const send = () => {
      peerRoom.broadcastStateSlow({
        displayName,
        deviceConnected: device.connected,
        battery: device.battery,
        waveformCatalog: waveformsRef.current.allWaveforms.map(w => ({
          id: w.id, name: w.name, custom: !!w.custom,
        })),
        queueA, queueB,
        playModeA, playModeB,
        intervalA: intervalASec, intervalB: intervalBSec,
        currentIndexA, currentIndexB,
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
  }, [peerRoom.connected, peerRoom.broadcastStateSlow,
      displayName, device.connected, device.battery,
      waveforms.allWaveforms.length,
      queueA, queueB, playModeA, playModeB,
      intervalASec, intervalBSec, currentIndexA, currentIndexB, allowAi,
      device.opossum?.connected, device.opossum?.battery,
      device.sensor?.kind, device.sensor?.connected, device.sensor?.battery]);

  // 持久化「允许 AI 控制」开关。
  useEffect(() => {
    localStorage.setItem('dg-chat-allow-ai', allowAi ? '1' : '0');
  }, [allowAi]);

  // AI 角色大脑（仅房主浏览器实际运行；@AI 角色触发）。
  const agentDeviceTargets: AgentDeviceTarget[] = [...peerRoom.members.values()]
    .filter(m => !m.isAi && m.deviceConnected && m.allowAi)
    .map(m => ({ peerId: m.peerId, name: m.displayName || m.peerId.slice(0, 6) }));
  useRoomAgents({
    isHost: peerRoom.isHost,
    scene: peerRoom.scene,
    roleAssignments: peerRoom.roleAssignments,
    members: peerRoom.members,
    messages: peerRoom.messages,
    deviceTargets: agentDeviceTargets,
    sendChatAs: peerRoom.sendChatAs,
    sendCommandAs: peerRoom.sendCommandAs,
  });

  // A/B 通道：被控方权威定时切换（自己持有真值）
  useChannelRotation('A', device.waveIdA, queueA, playModeA, intervalASec, setCurrentIndexA, deviceRef, waveformsRef);
  useChannelRotation('B', device.waveIdB, queueB, playModeB, intervalBSec, setCurrentIndexB, deviceRef, waveformsRef);

  // 心跳过期 reaper：fire_active 每 300ms 一次，超过 800ms 没刷新即视作松开。
  // 正常松开走 fire_release QoS 1 立即回落；任何异常路径（页面关闭/丢包/崩溃）由这里兜底，最坏 ~1s 内归零。
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      let dirtyA = false, dirtyB = false;
      fireBoostsA.current.forEach((v, k) => {
        if (now - v.ts > 800) { fireBoostsA.current.delete(k); dirtyA = true; }
      });
      fireBoostsB.current.forEach((v, k) => {
        if (now - v.ts > 800) { fireBoostsB.current.delete(k); dirtyB = true; }
      });
      if (dirtyA) callApplyFire('A');
      if (dirtyB) callApplyFire('B');
    }, 200);
    return () => clearInterval(t);
  }, [callApplyFire]);

  if (!safety.accepted) {
    return <SafetyNotice onAccept={({ dontShowAgain }) => safety.accept(dontShowAgain)} />;
  }

  if (!peerRoom.connected) {
    return (
      <RoomEntry
        displayName={displayName}
        onNameChange={setDisplayName}
        onJoin={(code, options) => peerRoom.join(code, options)}
        status={peerRoom.status}
        error={peerRoom.error}
      />
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)]">
      {/* 顶部栏 */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold text-[var(--text)]">DG-Chat</h1>
          {peerRoom.roomId && (
            <span className="hidden rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--text-faint)] sm:inline">
              {peerRoom.roomId}
            </span>
          )}
          {peerRoom.peers.length > 0 ? (
            <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]">
              {peerRoom.peers.length + 1} 人在线
            </span>
          ) : (
            <span className="rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-xs text-[var(--text-faint)]">
              等待其他成员加入...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* 常驻讨论房无房主、无 AI（纯开放聊天），隐藏场景/AI 入口 */}
          {peerRoom.roomId !== '0xNullAI' && (
            <>
              {/* 房间场景 */}
              <button
                onClick={() => setSceneOpen(true)}
                className={`flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors hover:bg-[var(--bg-soft)] ${peerRoom.scene ? 'text-[var(--accent)]' : 'text-[var(--text-soft)]'}`}
                title="房间场景"
              >
                <Drama className="h-4 w-4" />
              </button>
              {/* AI 设置（房主配置模型）+ 允许 AI 控制本机设备开关 */}
              <button
                onClick={() => setAiSettingsOpen(true)}
                className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
                title="AI 设置"
              >
                <Bot className="h-4 w-4" />
              </button>
              {device.connected && (
                <button
                  onClick={() => setAllowAi(v => !v)}
                  className={`flex h-9 items-center gap-1 rounded-[10px] px-2 text-[11px] transition-colors hover:bg-[var(--bg-soft)] ${allowAi ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}
                  title={allowAi ? 'AI 可控制你的设备，点击关闭' : '允许房间内 AI 控制你的设备'}
                >
                  <Bot className="h-3.5 w-3.5" />
                  {allowAi ? '允许AI' : '禁AI'}
                </button>
              )}
            </>
          )}
          {/* 主题切换 */}
          <button
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              setTheme(next);
              document.documentElement.setAttribute('data-theme', next);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
            title={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          {/* 蓝牙 + 个人安全设置（合并面板） */}
          <DeviceSafetyButton
            connected={device.connected}
            deviceName={device.deviceInfo?.name ?? null}
            battery={device.battery}
            onDisconnect={device.disconnectCoyote}
            limitA={device.limitA}
            limitB={device.limitB}
            onSetLimit={device.setLimit}
            backgroundBehavior={device.backgroundBehavior}
            onSetBackgroundBehavior={device.setBackgroundBehavior}
            firePolicy={device.firePolicy}
            onSetFirePolicy={device.setFirePolicy}
            onRestoreDefaults={waveforms.restoreDefaults}
            sensor={device.sensor}
            opossum={device.opossum}
            onConnectDevice={device.connectDevice}
            onDisconnectSensor={device.disconnectSensor}
            onDisconnectOpossum={device.disconnectOpossum}
          />
          {/* 紧急停止：Coyote 或 Opossum 任一已连接就必须可见——两者都是可能
              正在输出的设备，只看 Coyote 会让"只连了 Opossum"的用户找不到
              一键停止按钮。 */}
          {(device.connected || device.opossum?.connected) && (
            <button
              onClick={device.stopAll}
              className="flex h-9 items-center gap-1 rounded-[10px] bg-[var(--danger-soft)] px-2.5 text-xs font-medium text-[var(--danger)] transition-opacity hover:opacity-80"
              title="紧急停止"
            >
              <span aria-hidden>⏹</span><span className="hidden sm:inline">停止</span>
            </button>
          )}
          {/* 离开房间 */}
          <button
            onClick={() => { device.disconnect(); peerRoom.leave(); }}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--danger)]"
            title="离开房间"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 手机 Tab 栏 */}
      <div className="flex shrink-0 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] lg:hidden">
        <button
          onClick={() => setActiveTab('chat')}
          className={`mobile-tab ${activeTab === 'chat' ? 'active' : ''}`}
        >
          💬 聊天
        </button>
        <button
          onClick={() => setActiveTab('control')}
          className={`mobile-tab ${activeTab === 'control' ? 'active' : ''}`}
        >
          ⚡ 控制
        </button>
      </div>

      {/* 双面板 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-2">
        <div className={`${activeTab !== 'chat' ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col`}>
          <ChatPanel
            messages={peerRoom.messages}
            onSend={(text, mentions) => peerRoom.sendMessage(text, undefined, mentions)}
            onSendMedia={sendMedia}
            members={[
              ...peerRoom.peers.map(p => ({ peerId: p, name: peerRoom.members.get(p)?.displayName || p.slice(0, 6) })),
              // AI 托管角色作为可 @ 的伪成员（peerId = "ai:<roleId>"）。
              ...[...peerRoom.members.values()]
                .filter(m => m.isAi)
                .map(m => ({ peerId: m.peerId, name: m.displayName })),
            ]}
            selfId={peerRoom.selfId}
          />
        </div>
        <div className={`${activeTab !== 'control' ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col border-l border-[var(--surface-border)]`}>
          <ControlPanel
            members={peerRoom.members}
            peers={peerRoom.peers}
            onSendCommand={sendCommand}
            onSendWaveform={peerRoom.sendWaveform}
            roomId={peerRoom.roomId}
            waveforms={waveforms.allWaveforms}
            onImportWaveform={waveforms.importFile}
            onImportMarketWaveform={waveforms.addMarketWaveform}
            onRemoveWaveform={waveforms.removeWaveform}
            selfState={{
              peerId: 'self',
              displayName,
              deviceConnected: device.connected,
              strengthA: device.strengthA,
              strengthB: device.strengthB,
              waveA: device.waveIdA,
              waveB: device.waveIdB,
              battery: device.battery,
              queueA, queueB,
              playModeA, playModeB,
              intervalA: intervalASec, intervalB: intervalBSec,
              currentIndexA, currentIndexB,
              firingA,
              firingB,
              opossumConnected: device.opossum?.connected ?? false,
              opossumIntensityA: device.opossum?.intensityA ?? 0,
              opossumIntensityB: device.opossum?.intensityB ?? 0,
              opossumBattery: device.opossum?.battery ?? null,
              sensorKind: device.sensor?.kind,
              sensorConnected: device.sensor?.connected ?? false,
              sensorBattery: device.sensor?.battery ?? null,
              sensorLastEvent: device.sensor?.lastEvent ?? null,
              sensorLastValue: device.sensor?.lastValue ?? null,
              sensorLastEventAt: device.sensor?.lastEventAt ?? null,
            } satisfies MemberState}
            selfLimitA={device.limitA}
            selfLimitB={device.limitB}
            selfRoleName={selfRoleName}
            roleNameFor={roleNameFor}
          />
        </div>
      </div>
      <footer className="shrink-0 border-t border-[var(--surface-border)] bg-[var(--bg-elevated)] py-1.5 text-center text-[10px] text-[var(--text-faint)]">
        本项目仅供学习交流使用，请遵守当地法律法规。<a href="https://github.com/0xNullAI/DG-Chat" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent)]">GitHub</a>
      </footer>

      <SceneDialog
        open={sceneOpen}
        onClose={() => setSceneOpen(false)}
        scene={peerRoom.scene}
        roleAssignments={peerRoom.roleAssignments}
        members={peerRoom.members}
        selfId={peerRoom.selfId}
        selfName={displayName}
        isHost={peerRoom.isHost}
        onSetScene={peerRoom.setScene}
        onClaimRole={peerRoom.claimRole}
        onReleaseRole={peerRoom.releaseRole}
        onAssignAi={peerRoom.assignAi}
        onReleaseAi={peerRoom.releaseAi}
        onImportFromMarket={() => setSceneMarketOpen(true)}
      />
      <SceneMarketDialog
        open={sceneMarketOpen}
        onClose={() => setSceneMarketOpen(false)}
        onImport={(s) => { peerRoom.setScene(s); setSceneMarketOpen(false); setSceneOpen(true); }}
      />
      <AiSettingsDialog open={aiSettingsOpen} onClose={() => setAiSettingsOpen(false)} />
    </div>
  );
}
