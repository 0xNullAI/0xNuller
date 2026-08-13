import { useRef, useState } from 'react';
import {
  BluetoothOff,
  ChevronDown,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  Shuffle,
  Store,
  Timer,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { RepeatButton } from '../../../chat/src/components/RepeatControls';
import type { CoyoteSummary } from '../../../chat/src/lib/bluetooth';
import type { PlayMode, WaveformDefinition } from '@dg-kit/core';
import { PLAY_INTERVAL_OPTIONS } from '@control/hooks/use-playback';
import { isCoyoteOutputActive } from '@dg-kit/core';
import { CoyotePlaceholderChannels } from './CoyotePlaceholderChannels';

const RING_CLASS =
  'flex h-24 w-24 flex-col items-center justify-center gap-0.5 rounded-full border-[3px] border-[var(--surface-border)] bg-[var(--bg-elevated)] transition-colors hover:border-[var(--accent)]';

const STRENGTH_BTN_CLASS =
  'flex h-10 w-10 select-none items-center justify-center rounded-full border-2 border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xl font-medium text-[var(--text)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-30';

const MODE_BUTTONS: { mode: PlayMode; label: string; title: string }[] = [
  { mode: 'single', label: '单曲', title: '单曲循环' },
  { mode: 'list', label: '列表', title: '列表循环' },
  { mode: 'random', label: '随机', title: '随机播放' },
];

function ModeIcon({ mode }: { mode: PlayMode }) {
  if (mode === 'single') return <Repeat1 size={13} />;
  if (mode === 'list') return <Repeat size={13} />;
  return <Shuffle size={13} />;
}

interface CoyoteControlProps {
  coyote: CoyoteSummary;
  /** Human-readable shell label; raw BLE names are kept out of everyday controls. */
  displayName: string;
  /**
   * Kept for the legacy CoyoteSection composition. The current output deck
   * renders one complete device page in OutputDeviceSection and supplies the
   * compact channel body (`multi={false}`) beneath its own device header.
   */
  multi: boolean;
  /** Whether this host is the currently focused page. */
  selected: boolean;
  onSelect: (deviceId: string) => void;
  queueLengthA: number;
  queueLengthB: number;
  firingA: boolean;
  firingB: boolean;
  onAdjustStrength: (deviceId: string, channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (deviceId: string, channel: 'A' | 'B') => void;
  /** Zero this host only. The all-devices 归零 stays below, outside this block. */
  onStopDevice: (deviceId: string) => void;
  onDisconnect: (deviceId: string) => void;
}

/**
 * One Coyote host's panel: strength and playback for that host alone.
 *
 * The layout is MemberControl's — rings, channel buttons — because it is a
 * shape people already know from Chat. What is new is that there is one of
 * these per attached host: every reading, every cap and every button here is
 * addressed by `coyote.id`, so two hosts can never end up driving each other.
 * The waveform library is rendered by the enclosing complete device page
 * (see `WaveformPanel`); this component stays focused on the two live rings.
 */
export function CoyoteControl({
  coyote,
  displayName,
  multi,
  selected,
  onSelect,
  queueLengthA,
  queueLengthB,
  firingA,
  firingB,
  onAdjustStrength,
  onTogglePlay,
  onStopDevice,
  onDisconnect,
}: CoyoteControlProps) {
  const renderChannel = (channel: 'A' | 'B') => {
    const strength = channel === 'A' ? coyote.strengthA : coyote.strengthB;
    const limit = channel === 'A' ? coyote.limitA : coyote.limitB;
    const playing = channel === 'A' ? coyote.waveActiveA : coyote.waveActiveB;
    const firing = channel === 'A' ? firingA : firingB;
    const queueLength = channel === 'A' ? queueLengthA : queueLengthB;
    return (
      <div className="flex flex-col items-center">
        <button
          onClick={() => onTogglePlay(coyote.id, channel)}
          disabled={!coyote.connected || (!playing && queueLength === 0)}
          className={`mb-2 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-90 active:scale-95 disabled:opacity-30 ${
            playing
              ? 'bg-[var(--danger)] text-white'
              : 'bg-[var(--accent)] text-[var(--button-text)]'
          }`}
          title={
            playing
              ? `暂停 ${channel}`
              : queueLength > 0
                ? `启动 ${channel}`
                : `请先选择 ${channel} 通道波形`
          }
        >
          {playing ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </button>
        <div className={RING_CLASS}>
          <span className="text-2xl font-bold tabular-nums text-[var(--text)]">{strength}</span>
          <span className="text-[10px] text-[var(--text-faint)]">
            {channel}:{limit}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <RepeatButton
            onAction={() => onAdjustStrength(coyote.id, channel, -1)}
            className={STRENGTH_BTN_CLASS}
            disabled={firing}
          >
            −
          </RepeatButton>
          <RepeatButton
            onAction={() => onAdjustStrength(coyote.id, channel, +1)}
            className={STRENGTH_BTN_CLASS}
            disabled={firing}
          >
            +
          </RepeatButton>
        </div>
      </div>
    );
  };

  const body = (
    <div className="flex items-center justify-center gap-6">
      {renderChannel('A')}
      {renderChannel('B')}
    </div>
  );

  if (!multi) return body;

  return (
    <div
      className={`rounded-[var(--radius-md)] border bg-[var(--bg-elevated)] px-3 py-3 transition-colors duration-[var(--dur)] ${
        selected ? 'border-[var(--accent)]' : 'border-[var(--surface-border)]'
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSelect(coyote.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={selected ? '下方波形面板正作用于这台' : '让下方波形面板作用于这台'}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isCoyoteOutputActive(coyote) ? 'bg-[var(--accent)]' : 'bg-[var(--success)]'
            }`}
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-[var(--text)]">{displayName}</span>
          {coyote.battery != null && (
            <span className="shrink-0 text-[11px] text-[var(--text-faint)]">{coyote.battery}%</span>
          )}
          {selected && (
            <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
              波形面板
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onStopDevice(coyote.id)}
          className="flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 text-[11px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
          title={`只把 ${displayName} 归零`}
        >
          <RotateCcw size={11} className="text-[var(--danger)]" />
          归零
        </button>
        <button
          type="button"
          onClick={() => onDisconnect(coyote.id)}
          className="flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 text-[11px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
          title={`断开 ${displayName}`}
        >
          <BluetoothOff size={11} />
          断开
        </button>
      </div>
      {body}
    </div>
  );
}

export interface WaveformPanelProps {
  /** Name of the host the panel drives; shown only when several are attached. */
  targetName: string | null;
  waveTab: 'A' | 'B';
  onWaveTabChange: (channel: 'A' | 'B') => void;
  waveforms: WaveformDefinition[];
  /** Queue of the channel the tab is on. */
  queue: string[];
  /** Waveform playing on that channel of the targeted host, if any. */
  activeWaveId: string | null;
  playMode: PlayMode;
  intervalSec: number;
  onPlayModeChange: (mode: PlayMode) => void;
  onIntervalChange: (seconds: number) => void;
  onToggleWaveform: (waveform: WaveformDefinition) => void;
  onRemoveWaveform: (id: string) => void;
  onImportFile: (file: File) => Promise<string | null>;
  onOpenMarket: () => void;
  fireEnabledA: boolean;
  fireEnabledB: boolean;
  fireLimitA: number;
  fireLimitB: number;
  firingA: boolean;
  firingB: boolean;
  onFireStart: (channel: 'A' | 'B', boost: number) => void;
  onFireStop: (channel: 'A' | 'B') => void;
  /** Renders the complete familiar console before a physical device is attached. */
  disabled?: boolean;
}

/**
 * One device's waveform library and playback panel. OutputDeviceSection mounts
 * one instance per horizontal device page, so queues and modality never leak
 * between a Coyote and an Opossum (or between two Coyotes).
 *
 * Global zero-output lives in the shell device bar so it does not duplicate or
 * disappear between modules. Per-device zero remains in multi-device headers.
 */
export function WaveformPanel({
  targetName,
  waveTab,
  onWaveTabChange,
  waveforms,
  queue,
  activeWaveId,
  playMode,
  intervalSec,
  onPlayModeChange,
  onIntervalChange,
  onToggleWaveform,
  onRemoveWaveform,
  onImportFile,
  onOpenMarket,
  fireEnabledA,
  fireEnabledB,
  fireLimitA,
  fireLimitB,
  firingA,
  firingB,
  onFireStart,
  onFireStop,
  disabled = false,
}: WaveformPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fireBoostA, setFireBoostA] = useState(5);
  const [fireBoostB, setFireBoostB] = useState(5);
  const [fireOpen, setFireOpen] = useState(false);

  const renderFireChannel = (channel: 'A' | 'B') => {
    const enabled = channel === 'A' ? fireEnabledA : fireEnabledB;
    const firing = channel === 'A' ? firingA : firingB;
    const limit = channel === 'A' ? fireLimitA : fireLimitB;
    const configuredBoost = channel === 'A' ? fireBoostA : fireBoostB;
    const boost = limit > 0 ? Math.min(configuredBoost, limit) : configuredBoost;
    const setBoost = channel === 'A' ? setFireBoostA : setFireBoostB;
    const fireDisabled = disabled || !enabled || boost <= 0;
    const stop = () => onFireStop(channel);

    return (
      <div
        key={channel}
        className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] p-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="w-4 text-xs font-semibold text-[var(--text)]">{channel}</span>
          <RepeatButton
            onAction={() => setBoost(Math.max(0, boost - 1))}
            disabled={firing}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-sm disabled:opacity-30"
          >
            −
          </RepeatButton>
          <span className="w-9 text-center font-mono text-xs tabular-nums text-[var(--text)]">
            +{boost}
          </span>
          <RepeatButton
            onAction={() => setBoost(Math.min(limit, boost + 1))}
            disabled={firing || limit <= 0}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-sm disabled:opacity-30"
          >
            +
          </RepeatButton>
        </div>
        <button
          type="button"
          disabled={fireDisabled}
          aria-pressed={firing}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onFireStart(channel, boost);
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={() => {
            if (firing) stop();
          }}
          onKeyDown={(event) => {
            if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              onFireStart(channel, boost);
            }
          }}
          onKeyUp={(event) => {
            if (event.key === 'Enter' || event.key === ' ') stop();
          }}
          onBlur={stop}
          onContextMenu={(event) => event.preventDefault()}
          className={`flex h-9 shrink-0 select-none items-center gap-1.5 rounded-[var(--radius-ctl)] px-3 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-35 ${
            firing
              ? 'scale-[0.97] bg-[var(--danger-button)] text-white'
              : 'border border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[var(--danger-surface)]'
          }`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
          title={enabled ? `按住临时增加 ${channel} 通道强度` : `请先启动 ${channel} 通道波形`}
        >
          <Zap size={14} fill={firing ? 'currentColor' : 'none'} />
          {firing ? '开火中' : '按住开火'}
        </button>
      </div>
    );
  };

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const error = await onImportFile(file);
    if (error) window.alert(error);
    e.target.value = '';
  }

  const renderCard = (waveform: WaveformDefinition) => {
    const queued = queue.includes(waveform.id);
    const active = activeWaveId === waveform.id;
    return (
      <div
        key={waveform.id}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) onToggleWaveform(waveform);
        }}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onToggleWaveform(waveform);
          }
        }}
        className={`group relative flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-[1.5px] px-1 pt-3 pb-2.5 transition-all ${disabled ? 'cursor-not-allowed' : 'cursor-pointer active:scale-95'} ${
          active
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
            : queued
              ? 'border-[var(--accent)] bg-[var(--bg-elevated)] text-[var(--accent)] opacity-60'
              : 'border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
        }`}
      >
        <svg viewBox="0 0 40 20" className="h-[18px] w-9">
          <path
            d="M2 10 Q8 2 14 10 Q20 18 26 10 Q32 2 38 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <span className="max-w-full truncate text-[11px] leading-tight">{waveform.name}</span>
        {queued && (
          <span className="absolute top-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--button-text)]">
            {queue.indexOf(waveform.id) + 1}
          </span>
        )}
        {!queued && !disabled && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemoveWaveform(waveform.id);
            }}
            className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--danger)] text-white opacity-0 transition-opacity group-hover:opacity-100"
            title={waveform.custom ? '删除自定义波形' : '隐藏内置波形'}
          >
            <Trash2 size={8} />
          </button>
        )}
      </div>
    );
  };

  const builtins = waveforms.filter((w) => !w.custom);
  const customs = waveforms.filter((w) => w.custom);

  return (
    <div className={disabled ? 'opacity-55' : undefined} aria-disabled={disabled || undefined}>
      <div className="mt-5 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
        <button
          type="button"
          disabled={disabled}
          aria-expanded={fireOpen}
          aria-controls="control-fire-panel"
          onClick={() => {
            if (fireOpen) {
              if (firingA) onFireStop('A');
              if (firingB) onFireStop('B');
            }
            setFireOpen((open) => !open);
          }}
          className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Zap size={13} className="shrink-0 text-[var(--danger)]" />
          <span className="flex-1 text-xs font-semibold text-[var(--text)]">一键开火</span>
          {targetName && (
            <span className="max-w-28 truncate text-[10px] text-[var(--accent)]">{targetName}</span>
          )}
          <ChevronDown
            size={15}
            className={`shrink-0 text-[var(--text-faint)] transition-transform ${fireOpen ? 'rotate-180' : ''}`}
          />
        </button>
        {fireOpen && (
          <div
            id="control-fire-panel"
            className="mt-3 grid gap-2 border-t border-[var(--surface-border)] pt-3 sm:grid-cols-2"
          >
            {renderFireChannel('A')}
            {renderFireChannel('B')}
          </div>
        )}
      </div>

      {/* ==================== A/B channel wave tab ==================== */}
      <div className="mt-5 flex overflow-hidden rounded-[var(--radius-sm)] border border-[var(--surface-border)]">
        {(['A', 'B'] as const).map((channel) => (
          <button
            key={channel}
            disabled={disabled}
            onClick={() => onWaveTabChange(channel)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              waveTab === channel
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
            }`}
          >
            {channel} 通道波形
          </button>
        ))}
      </div>

      {targetName && (
        <p className="mt-2 text-[11px] text-[var(--text-faint)]">
          当前设备：<span className="text-[var(--accent)]">{targetName}</span>
        </p>
      )}

      {/* ==================== Play mode ==================== */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {MODE_BUTTONS.map(({ mode, label, title }) => (
            <button
              key={mode}
              disabled={disabled}
              onClick={() => onPlayModeChange(mode)}
              className={`flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[11px] transition-colors ${
                playMode === mode
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-[var(--text-faint)] hover:text-[var(--text-soft)]'
              }`}
              title={title}
            >
              <ModeIcon mode={mode} /> {label}
            </button>
          ))}
        </div>
        {playMode !== 'single' && (
          <div className="flex items-center gap-1.5">
            <Timer size={12} className="text-[var(--text-faint)]" />
            <select
              disabled={disabled}
              value={intervalSec}
              onChange={(e) => onIntervalChange(Number(e.target.value))}
              className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--text)] outline-none"
              aria-label="切换间隔"
            >
              {PLAY_INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ==================== Waveform grid ==================== */}
      <div className="mt-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs text-[var(--text-faint)]">
            波形{queue.length > 0 ? ` (已选 ${queue.length})` : ''}
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={disabled}
              onClick={onOpenMarket}
              className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
            >
              <Store size={12} /> 从市场导入
            </button>
            <button
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
            >
              <Upload size={12} /> 导入波形
            </button>
            <input
              disabled={disabled}
              ref={fileInputRef}
              type="file"
              accept=".pulse,.zip"
              className="hidden"
              onChange={handleFileImport}
            />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">{builtins.map(renderCard)}</div>
        {customs.length > 0 && (
          <>
            <p className="mt-3 mb-2 text-[11px] text-[var(--text-faint)]">
              自定义波形（{customs.length}）
            </p>
            <div className="grid grid-cols-4 gap-2">{customs.map(renderCard)}</div>
          </>
        )}
      </div>
    </div>
  );
}

interface CoyoteSectionProps extends Omit<
  WaveformPanelProps,
  | 'targetName'
  | 'fireEnabledA'
  | 'fireEnabledB'
  | 'fireLimitA'
  | 'fireLimitB'
  | 'firingA'
  | 'firingB'
  | 'onFireStart'
  | 'onFireStop'
> {
  coyotes: CoyoteSummary[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
  queueLengthA: number;
  queueLengthB: number;
  onAdjustStrength: (deviceId: string, channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (deviceId: string, channel: 'A' | 'B') => void;
  firingDeviceIdA: string | null;
  firingDeviceIdB: string | null;
  onFireStart: (deviceId: string, channel: 'A' | 'B', boost: number) => void;
  onFireStop: (channel: 'A' | 'B') => void;
  onStopDevice: (deviceId: string) => void;
  onDisconnect: (deviceId: string) => void;
}

/**
 * Legacy composition for callers that still want a Coyote list followed by a
 * single panel. The unified Control deck uses OutputDeviceSection instead.
 *
 * With nothing attached this renders a single disabled-looking placeholder
 * block, exactly as the one-device version used to — the module is unusable
 * until something is connected either way, and an empty section with no rings
 * reads as "broken" rather than "not connected yet".
 */
export function CoyoteSection({
  coyotes,
  selectedId,
  onSelect,
  queueLengthA,
  queueLengthB,
  onAdjustStrength,
  onTogglePlay,
  firingDeviceIdA,
  firingDeviceIdB,
  onFireStart,
  onFireStop,
  onStopDevice,
  onDisconnect,
  ...panel
}: CoyoteSectionProps) {
  const multi = coyotes.length > 1;
  const selected = coyotes.find((c) => c.id === selectedId) ?? coyotes[0] ?? null;
  const displayNames = new Map(
    coyotes.map((coyote, index) => [coyote.id, multi ? `郊狼 ${index + 1}` : '郊狼']),
  );

  return (
    <section>
      <h2 className="mb-3 text-xs font-medium tracking-wide text-[var(--text-faint)]">
        郊狼主机{multi ? `（${coyotes.length} 台）` : ''}
      </h2>

      {coyotes.length === 0 ? (
        <CoyotePlaceholderChannels />
      ) : (
        <div className="flex flex-col gap-3">
          {coyotes.map((coyote) => (
            <CoyoteControl
              key={coyote.id}
              coyote={coyote}
              displayName={displayNames.get(coyote.id) ?? '郊狼'}
              multi={multi}
              selected={multi && coyote.id === selected?.id}
              onSelect={onSelect}
              queueLengthA={queueLengthA}
              queueLengthB={queueLengthB}
              firingA={firingDeviceIdA === coyote.id}
              firingB={firingDeviceIdB === coyote.id}
              onAdjustStrength={onAdjustStrength}
              onTogglePlay={onTogglePlay}
              onStopDevice={onStopDevice}
              onDisconnect={onDisconnect}
            />
          ))}
        </div>
      )}

      <WaveformPanel
        {...panel}
        targetName={multi && selected ? (displayNames.get(selected.id) ?? '郊狼') : null}
        queue={panel.queue}
        fireEnabledA={Boolean(selected?.connected && selected.waveActiveA)}
        fireEnabledB={Boolean(selected?.connected && selected.waveActiveB)}
        fireLimitA={selected?.limitA ?? 0}
        fireLimitB={selected?.limitB ?? 0}
        firingA={firingDeviceIdA === selected?.id}
        firingB={firingDeviceIdB === selected?.id}
        onFireStart={(channel, boost) => {
          if (selected) onFireStart(selected.id, channel, boost);
        }}
        onFireStop={onFireStop}
      />
    </section>
  );
}
