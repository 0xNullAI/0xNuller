import { MarketImportDialog } from '@0xnullai/ui';
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft,
  Bluetooth,
  BatteryMedium,
  Play,
  Pause,
  RotateCcw,
  Upload,
  Store,
  Trash2,
  Zap,
  Repeat,
  Repeat1,
  Shuffle,
  Timer,
} from 'lucide-react';
import type { CmdAction, DeviceCommand, MemberState, WaveformTransfer } from '../lib/protocol';
import type { MarketItem } from '@0xnullai/market-client';

import { parseImportFile, type WaveformDefinition } from '../lib/waveforms';
import { Popover } from './Popover';
import { RepeatButton } from './RepeatControls';
import { SensorCard } from './SensorCard';
import { OpossumControl } from './OpossumControl';

interface MemberControlProps {
  peerId: string;
  member: MemberState | undefined;
  onSendCommand: (
    target: string,
    action: CmdAction,
    params?: Omit<DeviceCommand, 'action'>,
  ) => void;
  onSendWaveform: (targetPeerId: string, transfer: WaveformTransfer) => void;
  onBack: () => void;
  waveforms: WaveformDefinition[];
  onImportWaveform: (file: File) => Promise<string | null>;
  onImportMarketWaveform: (item: MarketItem) => void;
  onRemoveWaveform: (id: string) => void;
  isSelf: boolean;
  limitA: number;
  limitB: number;
}

const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

function FireCircle({
  label,
  strength,
  maxStrength,
  disabled,
  firing,
  onStrengthChange,
  onFireStart,
  onFireStop,
}: {
  label: string;
  strength: number;
  maxStrength: number;
  disabled: boolean;
  firing: boolean;
  onStrengthChange: (v: number) => void;
  onFireStart: () => void;
  onFireStop: () => void;
}) {
  const pct = maxStrength > 0 ? strength / maxStrength : 0;
  const offset = RING_C * (1 - pct);

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: 110, height: 110 }}>
        {/* Background ring */}
        <svg className="absolute inset-0" viewBox="0 0 110 110">
          <circle
            cx="55"
            cy="55"
            r={RING_R}
            fill="none"
            stroke="var(--surface-border)"
            strokeWidth="6"
          />
          <circle
            cx="55"
            cy="55"
            r={RING_R}
            fill="none"
            stroke={firing ? 'var(--danger)' : 'var(--accent)'}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={offset}
            transform="rotate(-90 55 55)"
            className="transition-all duration-[var(--dur)]"
          />
        </svg>
        {/* Center fire button */}
        <button
          disabled={disabled}
          onPointerDown={(e) => {
            e.preventDefault();
            if (!disabled) onFireStart();
          }}
          onPointerUp={onFireStop}
          onPointerLeave={() => {
            if (firing) onFireStop();
          }}
          onContextMenu={(e) => e.preventDefault()}
          className={`absolute inset-[10px] flex flex-col items-center justify-center rounded-full transition-all select-none ${
            disabled
              ? 'opacity-30 cursor-not-allowed'
              : firing
                ? 'bg-[var(--danger)] text-white scale-95'
                : 'bg-[var(--bg-elevated)] text-[var(--text)] hover:bg-[var(--bg-soft)] active:scale-95 cursor-pointer'
          }`}
          style={{ touchAction: 'manipulation', WebkitUserSelect: 'none' }}
        >
          <Zap size={20} className={firing ? 'text-white' : 'text-[var(--danger)]'} />
          <span className="text-[10px] mt-0.5">{label} 开火</span>
        </button>
      </div>
      {/* Strength +/- */}
      <div className="mt-2 flex items-center gap-2">
        <RepeatButton
          onAction={() => onStrengthChange(Math.max(0, strength - 1))}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xs text-[var(--text)] hover:border-[var(--accent)] active:scale-90"
        >
          −
        </RepeatButton>
        <span className="w-8 text-center text-xs tabular-nums font-medium text-[var(--text)]">
          {strength}
        </span>
        <RepeatButton
          onAction={() => onStrengthChange(Math.min(maxStrength, strength + 1))}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xs text-[var(--text)] hover:border-[var(--accent)] active:scale-90"
        >
          +
        </RepeatButton>
      </div>
    </div>
  );
}

export function MemberControl({
  peerId,
  member,
  onSendCommand,
  onSendWaveform,
  onBack,
  waveforms,
  onImportWaveform,
  onImportMarketWaveform,
  onRemoveWaveform,
  isSelf,
  limitA,
  limitB,
}: MemberControlProps) {
  const [waveTab, setWaveTab] = useState<'A' | 'B'>('A');
  const [firePopOpen, setFirePopOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const [popAnchorTop, setPopAnchorTop] = useState(0);

  useEffect(() => {
    const measure = () => {
      const r = headerRef.current?.getBoundingClientRect();
      if (r) setPopAnchorTop(r.bottom + 4);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Fire heartbeat: while held down, send fire_active every 300ms; on release/unmount clear the
  // interval and send one fire_release to speed up the fall-off.
  // On any anomaly (page closed, popover suddenly unmounted, packet loss): the heartbeat stops →
  // the owner-side reaper zeroes it out automatically within 800ms.
  const heartbeatARef = useRef<number | null>(null);
  const heartbeatBRef = useRef<number | null>(null);
  const startFireHeartbeat = useCallback(
    (channel: 'A' | 'B', boost: number) => {
      const ref = channel === 'A' ? heartbeatARef : heartbeatBRef;
      if (ref.current != null) return;
      onSendCommand(peerId, 'fire_active', { c: channel, v: boost });
      ref.current = window.setInterval(() => {
        onSendCommand(peerId, 'fire_active', { c: channel, v: boost });
      }, 300);
    },
    [peerId, onSendCommand],
  );
  const stopFireHeartbeat = useCallback(
    (channel: 'A' | 'B') => {
      const ref = channel === 'A' ? heartbeatARef : heartbeatBRef;
      if (ref.current == null) return;
      clearInterval(ref.current);
      ref.current = null;
      onSendCommand(peerId, 'fire_release', { c: channel });
    },
    [peerId, onSendCommand],
  );
  // On unmount, stop every heartbeat and send a release (popover closed, user switches member,
  // whole panel unmounted — all of them come through here)
  useEffect(
    () => () => {
      if (heartbeatARef.current != null) {
        clearInterval(heartbeatARef.current);
        onSendCommand(peerId, 'fire_release', { c: 'A' });
      }
      if (heartbeatBRef.current != null) {
        clearInterval(heartbeatBRef.current);
        onSendCommand(peerId, 'fire_release', { c: 'B' });
      }
    },
    [peerId, onSendCommand],
  );
  const playlistA = member?.queueA ?? [];
  const playlistB = member?.queueB ?? [];
  const playModeA = member?.playModeA ?? 'single';
  const playModeB = member?.playModeB ?? 'single';
  const intervalA = member?.intervalA ?? 30;
  const intervalB = member?.intervalB ?? 30;
  const currentIndexA = member?.currentIndexA ?? 0;
  const currentIndexB = member?.currentIndexB ?? 0;
  const [fireStrA, setFireStrA] = useState(0);
  const [fireStrB, setFireStrB] = useState(0);
  const firingA = !!member?.firingA;
  const firingB = !!member?.firingB;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const name = member?.displayName || peerId.slice(0, 8);
  const strengthA = member?.strengthA ?? 0;
  const strengthB = member?.strengthB ?? 0;
  const deviceConnected = member?.deviceConnected ?? false;
  const playingA = !!member?.waveA;
  const playingB = !!member?.waveB;

  const currentPlaylist = waveTab === 'A' ? playlistA : playlistB;
  const currentPlayMode = waveTab === 'A' ? playModeA : playModeB;
  const currentInterval = waveTab === 'A' ? intervalA : intervalB;
  const activeWaveId = waveTab === 'A' ? member?.waveA : member?.waveB;

  // Optimistic local strength: keeps the 2-second broadcastState delay from making every
  // strength+1 build on a stale value
  const [localStrengthA, setLocalStrengthA] = useState(strengthA);
  const [localStrengthB, setLocalStrengthB] = useState(strengthB);
  const lastLocalAtA = useRef(0);
  const lastLocalAtB = useRef(0);

  // When remote state changes, adopt the remote value if there has been no local action recently
  // (>1.5s) — covers firing, reset to zero, and adjustments made by other people
  useEffect(() => {
    if (Date.now() - lastLocalAtA.current > 1500) setLocalStrengthA(strengthA);
  }, [strengthA]);
  useEffect(() => {
    if (Date.now() - lastLocalAtB.current > 1500) setLocalStrengthB(strengthB);
  }, [strengthB]);

  const adjustStrength = useCallback(
    (channel: 'A' | 'B', delta: number) => {
      const max = channel === 'A' ? limitA : limitB;
      const setter = channel === 'A' ? setLocalStrengthA : setLocalStrengthB;
      const stamp = channel === 'A' ? lastLocalAtA : lastLocalAtB;
      setter((prev) => {
        const next = Math.max(0, Math.min(max, prev + delta));
        const sent = next - prev; // the delta actually sent (already clamped by the local limit)
        if (sent === 0) return prev;
        stamp.current = Date.now();
        onSendCommand(peerId, 'adjust_strength', { c: channel, v: sent });
        return next;
      });
    },
    [peerId, onSendCommand, limitA, limitB],
  );

  function toggleWaveform(w: WaveformDefinition) {
    const playlist = waveTab === 'A' ? playlistA : playlistB;
    const isPlaying = waveTab === 'A' ? playingA : playingB;

    const nextQueue = playlist.includes(w.id)
      ? playlist.filter((id) => id !== w.id)
      : [...playlist, w.id];

    onSendCommand(peerId, 'set_queue', { c: waveTab, q: nextQueue });

    // If something is playing and a waveform was just added, switch to it immediately
    // (preserves the original UX)
    if (!playlist.includes(w.id) && isPlaying) {
      onSendCommand(peerId, 'change_wave', { c: waveTab, w: w.id });
    }
  }

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const error = await onImportWaveform(file);
    if (error) window.alert(error);
    e.target.value = '';
  }

  async function handleRemoteImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const waveformList = await parseImportFile(file);
      if (waveformList.length === 0) {
        window.alert('无法解析文件格式');
        e.target.value = '';
        return;
      }
      for (const wf of waveformList) {
        onSendWaveform(peerId, { wid: wf.id, wn: wf.name, fr: wf.frames });
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '导入失败');
    }
    e.target.value = '';
  }

  const renderCard = (w: WaveformDefinition) => {
    const inPlaylist = currentPlaylist.includes(w.id);
    const isActive = activeWaveId === w.id;
    return (
      <div
        key={w.id}
        role="button"
        tabIndex={0}
        onClick={() => toggleWaveform(w)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleWaveform(w);
          }
        }}
        className={`wave-card group ${
          isActive ? 'selected' : inPlaylist ? 'wave-card-queued' : ''
        }`}
      >
        <svg viewBox="0 0 40 20" className="wave-icon">
          <path
            d="M2 10 Q8 2 14 10 Q20 18 26 10 Q32 2 38 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <span className="wave-card-name">{w.name}</span>
        {inPlaylist && (
          {/* --button-text, not white: the light theme's accent is a pale cyan
              and white on it measures 1.9:1, so the playlist position was
              invisible there. */}
          <span className="absolute top-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--button-text)]">
            {currentPlaylist.indexOf(w.id) + 1}
          </span>
        )}
        {isSelf && !inPlaylist && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemoveWaveform(w.id);
            }}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--danger)] text-white opacity-0 transition-opacity group-hover:opacity-100"
            title={w.custom ? '删除自定义波形' : '隐藏内置波形'}
          >
            <Trash2 size={8} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div
        ref={headerRef}
        className="flex items-center gap-2 border-b border-[var(--surface-border)] px-4 py-3"
      >
        <button
          onClick={onBack}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text)]">{name}</p>
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${deviceConnected ? 'bg-[var(--success)]' : 'bg-[var(--text-faint)]'}`}
          />
        </div>
        {deviceConnected && (
          <div className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-soft)]">
            <Bluetooth size={14} className="text-[var(--success)]" />
            {member?.battery != null && (
              <span className="flex items-center gap-0.5">
                <BatteryMedium size={14} />
                {member.battery}%
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 px-4 py-4">
        {/* ==================== Dual Channel Strength ==================== */}
        <div className="flex items-center justify-center gap-6">
          {/* Channel A */}
          <div className="flex flex-col items-center">
            <button
              onClick={() => {
                if (playingA) {
                  onSendCommand(peerId, 'stop_wave', { c: 'A' });
                } else if (playlistA.length > 0) {
                  const startId = playlistA[currentIndexA % playlistA.length]!;
                  onSendCommand(peerId, 'start', { c: 'A', w: startId });
                }
              }}
              disabled={!playingA && playlistA.length === 0}
              className={`mb-2 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-90 active:scale-95 disabled:opacity-30 ${
                playingA
                  ? 'bg-[var(--danger)] text-white'
                  : 'bg-[var(--accent)] text-[var(--button-text)]'
              }`}
              title={playingA ? '暂停 A' : playlistA.length > 0 ? '启动 A' : '请先选择 A 通道波形'}
            >
              {playingA ? (
                <Pause size={16} fill="currentColor" />
              ) : (
                <Play size={16} fill="currentColor" />
              )}
            </button>
            <div className="channel-ring">
              <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
                {localStrengthA}
              </span>
              <span className="text-[10px] text-[var(--text-faint)]">A:{limitA}</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <RepeatButton onAction={() => adjustStrength('A', -1)} className="strength-btn">
                −
              </RepeatButton>
              <RepeatButton onAction={() => adjustStrength('A', +1)} className="strength-btn">
                +
              </RepeatButton>
            </div>
          </div>

          {/* Channel B */}
          <div className="flex flex-col items-center">
            <button
              onClick={() => {
                if (playingB) {
                  onSendCommand(peerId, 'stop_wave', { c: 'B' });
                } else if (playlistB.length > 0) {
                  const startId = playlistB[currentIndexB % playlistB.length]!;
                  onSendCommand(peerId, 'start', { c: 'B', w: startId });
                }
              }}
              disabled={!playingB && playlistB.length === 0}
              className={`mb-2 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-90 active:scale-95 disabled:opacity-30 ${
                playingB
                  ? 'bg-[var(--danger)] text-white'
                  : 'bg-[var(--accent)] text-[var(--button-text)]'
              }`}
              title={playingB ? '暂停 B' : playlistB.length > 0 ? '启动 B' : '请先选择 B 通道波形'}
            >
              {playingB ? (
                <Pause size={16} fill="currentColor" />
              ) : (
                <Play size={16} fill="currentColor" />
              )}
            </button>
            <div className="channel-ring">
              <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
                {localStrengthB}
              </span>
              <span className="text-[10px] text-[var(--text-faint)]">B:{limitB}</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <RepeatButton onAction={() => adjustStrength('B', -1)} className="strength-btn">
                −
              </RepeatButton>
              <RepeatButton onAction={() => adjustStrength('B', +1)} className="strength-btn">
                +
              </RepeatButton>
            </div>
          </div>
        </div>

        {/* ==================== Reset / Stop Bar ==================== */}
        <div className="mt-5 flex items-center justify-center">
          <button
            onClick={() => onSendCommand(peerId, 'stop')}
            className="flex h-11 flex-1 max-w-xs items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-soft)] active:scale-[0.98]"
          >
            <RotateCcw size={15} className="text-[var(--danger)]" />
            归零
          </button>
        </div>

        {/* ==================== A/B Channel Wave Tab ==================== */}
        <div className="mt-5 flex rounded-[var(--radius-sm)] border border-[var(--surface-border)] overflow-hidden">
          <button
            onClick={() => setWaveTab('A')}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              waveTab === 'A'
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
            }`}
          >
            A 通道波形
          </button>
          <button
            onClick={() => setWaveTab('B')}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              waveTab === 'B'
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
            }`}
          >
            B 通道波形
          </button>
        </div>

        {/* ==================== Playlist Controls ==================== */}
        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={() => onSendCommand(peerId, 'set_play_mode', { c: waveTab, mode: 'single' })}
              className={`flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[11px] transition-colors ${
                currentPlayMode === 'single'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-[var(--text-faint)] hover:text-[var(--text-soft)]'
              }`}
              title="单曲循环"
            >
              <Repeat1 size={13} /> 单曲
            </button>
            <button
              onClick={() => onSendCommand(peerId, 'set_play_mode', { c: waveTab, mode: 'list' })}
              className={`flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[11px] transition-colors ${
                currentPlayMode === 'list'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-[var(--text-faint)] hover:text-[var(--text-soft)]'
              }`}
              title="列表循环"
            >
              <Repeat size={13} /> 列表
            </button>
            <button
              onClick={() => onSendCommand(peerId, 'set_play_mode', { c: waveTab, mode: 'random' })}
              className={`flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[11px] transition-colors ${
                currentPlayMode === 'random'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-[var(--text-faint)] hover:text-[var(--text-soft)]'
              }`}
              title="随机播放"
            >
              <Shuffle size={13} /> 随机
            </button>
          </div>
          <div className="flex items-center gap-1">
            {currentPlayMode !== 'single' && (
              <div className="mr-1 flex items-center gap-1.5">
                <Timer size={12} className="text-[var(--text-faint)]" />
                <select
                  value={currentInterval}
                  onChange={(e) =>
                    onSendCommand(peerId, 'set_interval', {
                      c: waveTab,
                      iv: Number(e.target.value),
                    })
                  }
                  className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--text)] outline-none"
                >
                  <option value={10}>10秒</option>
                  <option value={20}>20秒</option>
                  <option value={30}>30秒</option>
                  <option value={60}>1分钟</option>
                  <option value={120}>2分钟</option>
                  <option value={300}>5分钟</option>
                  <option value={600}>10分钟</option>
                </select>
              </div>
            )}
            <button
              onClick={() => setFirePopOpen((v) => !v)}
              className={`flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors ${
                firePopOpen
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-[var(--text-faint)] hover:bg-[var(--bg-soft)] hover:text-[var(--text-soft)]'
              }`}
              title="一键开火"
              aria-label="一键开火"
            >
              <Zap size={14} />
            </button>
          </div>
        </div>

        {/* ==================== Waveform Grid ==================== */}
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-[var(--text-faint)]">
              波形{currentPlaylist.length > 0 ? ` (已选 ${currentPlaylist.length})` : ''}
            </p>
            <div className="flex items-center gap-1">
              {isSelf && (
                <button
                  onClick={() => setMarketOpen(true)}
                  className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
                >
                  <Store size={12} /> 从市场导入
                </button>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
              >
                <Upload size={12} /> 导入波形
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pulse,.zip"
                className="hidden"
                onChange={isSelf ? handleFileImport : handleRemoteImport}
              />
            </div>
          </div>

          {/* Grouping: built-in waveforms are always present */}
          {(() => {
            const builtins = waveforms.filter((w) => !w.custom);
            const customs = waveforms.filter((w) => w.custom);
            return (
              <>
                <div className="grid grid-cols-4 gap-2">{builtins.map(renderCard)}</div>
                {customs.length > 0 && (
                  <>
                    <p className="mt-3 mb-2 text-[11px] text-[var(--text-faint)]">
                      自定义波形（{customs.length}）
                    </p>
                    <div className="grid grid-cols-4 gap-2">{customs.map(renderCard)}</div>
                  </>
                )}
              </>
            );
          })()}
        </div>

        {/* ============ Sensor telemetry (read-only, no linkage, see the TODO in lib/commands.ts) ============ */}
        {member && (
          <SensorCard
            kind={member.sensorKind}
            connected={!!member.sensorConnected}
            battery={member.sensorBattery}
            lastEvent={member.sensorLastEvent}
            lastValue={member.sensorLastValue}
            lastEventAt={member.sensorLastEventAt}
            onPickLedColor={(color) =>
              onSendCommand(peerId, 'set_led', { kind: member.sensorKind ?? undefined, color })
            }
          />
        )}

        {/* ==================== Opossum vibration controller ==================== */}
        {member && (
          <OpossumControl
            connected={!!member.opossumConnected}
            battery={member.opossumBattery}
            intensityA={member.opossumIntensityA ?? 0}
            intensityB={member.opossumIntensityB ?? 0}
            limitA={limitA}
            limitB={limitB}
            onAdjust={(channel, delta) =>
              onSendCommand(peerId, 'vibrate_adjust', { c: channel, v: delta })
            }
            onBurst={(channel, strength, durationMs) =>
              onSendCommand(peerId, 'vibrate_burst', { c: channel, v: strength, ms: durationMs })
            }
            onStop={() => onSendCommand(peerId, 'vibrate_stop')}
            onPickLedColor={(color) => onSendCommand(peerId, 'set_led', { kind: 'opossum', color })}
          />
        )}
      </div>

      <MarketImportDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        type="waveform"
        onImport={onImportMarketWaveform}
      />

      <Popover
        open={firePopOpen}
        onOpenChange={setFirePopOpen}
        title="一键开火"
        anchorTop={popAnchorTop}
      >
        <p className="mb-3 text-center text-xs text-[var(--text-faint)]">按住增加强度，松开恢复</p>
        <div className="flex items-center justify-center gap-8">
          <FireCircle
            label="A"
            strength={fireStrA}
            maxStrength={limitA}
            disabled={false}
            firing={firingA}
            onStrengthChange={setFireStrA}
            onFireStart={() => startFireHeartbeat('A', fireStrA)}
            onFireStop={() => stopFireHeartbeat('A')}
          />
          <FireCircle
            label="B"
            strength={fireStrB}
            maxStrength={limitB}
            disabled={false}
            firing={firingB}
            onStrengthChange={setFireStrB}
            onFireStart={() => startFireHeartbeat('B', fireStrB)}
            onFireStop={() => stopFireHeartbeat('B')}
          />
        </div>
      </Popover>
    </div>
  );
}
