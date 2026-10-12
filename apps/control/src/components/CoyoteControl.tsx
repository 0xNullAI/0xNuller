import { useRef, useState } from 'react';
import {
  ChevronDown,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  Store,
  Timer,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { RepeatButton } from '@0xnullai/ui';
import type { CoyoteSummary } from '@0xnullai/device-runtime';
import type { PlayMode, WaveformDefinition } from '@dg-kit/core';
import { PLAY_INTERVAL_OPTIONS } from '@control/hooks/use-playback';

const STEP_CLASS =
  'ui-press flex h-12 w-12 select-none items-center justify-center rounded-full bg-[var(--bg-strong)] text-2xl font-medium text-[var(--text)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-30';

/**
 * One channel: a large live number, its enforced cap and two press-and-hold steppers.
 * The caller clamps every step against the cap; the number here is the device's own report.
 */
export function ChannelStepper({
  channel,
  value,
  limit,
  firing,
  playing,
  playDisabled,
  playTitle,
  onAdjust,
  onTogglePlay,
}: {
  channel: 'A' | 'B';
  value: number;
  limit: number;
  firing: boolean;
  playing: boolean;
  playDisabled: boolean;
  playTitle: string;
  onAdjust: (delta: number) => void;
  onTogglePlay: () => void;
}) {
  return (
    <div className="flex flex-col items-center rounded-[var(--radius-sm)] bg-[var(--bg-strong)]/60 px-2 pb-3 pt-2">
      <div className="flex w-full items-center justify-between">
        <span className="pl-1 text-[13px] font-medium text-[var(--text-faint)]">{channel}</span>
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={playDisabled}
          className={`ui-press flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-30 ${
            playing
              ? 'bg-[var(--danger-button)] text-white'
              : 'bg-[var(--accent)] text-[var(--button-text)]'
          }`}
          title={playTitle}
        >
          {playing ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </button>
      </div>
      <output
        aria-label={`${channel} 通道强度`}
        className={`text-5xl font-semibold leading-none tabular-nums ${
          value > 0 ? 'text-[var(--accent-text)]' : 'text-[var(--text)]'
        }`}
      >
        {value}
      </output>
      <span className="mt-1 text-xs tabular-nums text-[var(--text-faint)]">上限 {limit}</span>
      <div className="mt-3 flex items-center gap-4">
        <RepeatButton onAction={() => onAdjust(-1)} className={STEP_CLASS} disabled={firing}>
          −
        </RepeatButton>
        <RepeatButton onAction={() => onAdjust(+1)} className={STEP_CLASS} disabled={firing}>
          +
        </RepeatButton>
      </div>
    </div>
  );
}

// One horizontal, swipeable line of waveform chips; it bleeds to the card edge on a phone.
const CHIP_ROW =
  '-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-5 sm:px-5 [&::-webkit-scrollbar]:hidden';

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
  queueLengthA: number;
  queueLengthB: number;
  firingA: boolean;
  firingB: boolean;
  onAdjustStrength: (channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (channel: 'A' | 'B') => void;
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
  queueLengthA,
  queueLengthB,
  firingA,
  firingB,
  onAdjustStrength,
  onTogglePlay,
}: CoyoteControlProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(['A', 'B'] as const).map((channel) => {
        const playing = channel === 'A' ? coyote.waveActiveA : coyote.waveActiveB;
        const queueLength = channel === 'A' ? queueLengthA : queueLengthB;
        return (
          <ChannelStepper
            key={channel}
            channel={channel}
            value={channel === 'A' ? coyote.strengthA : coyote.strengthB}
            limit={channel === 'A' ? coyote.limitA : coyote.limitB}
            firing={channel === 'A' ? firingA : firingB}
            playing={playing}
            playDisabled={!coyote.connected || (!playing && queueLength === 0)}
            playTitle={
              playing
                ? `暂停 ${channel}`
                : queueLength > 0
                  ? `启动 ${channel}`
                  : `请先选择 ${channel} 通道波形`
            }
            onAdjust={(delta) => onAdjustStrength(channel, delta)}
            onTogglePlay={() => onTogglePlay(channel)}
          />
        );
      })}
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
        className={`ui-press group relative flex h-10 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${
          active
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--button-text)]'
            : queued
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]'
              : 'border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
        }`}
      >
        <span className="max-w-32 truncate">{waveform.name}</span>
        {queued && (
          <span className="text-xs font-semibold tabular-nums opacity-80">
            {queue.indexOf(waveform.id) + 1}
          </span>
        )}
        {!queued && !disabled && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemoveWaveform(waveform.id);
            }}
            className="-mr-1.5 hidden h-5 w-5 items-center justify-center rounded-full text-[var(--text-faint)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] group-hover:flex"
            title={waveform.custom ? '删除自定义波形' : '隐藏内置波形'}
          >
            <Trash2 size={11} />
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

        <div className={CHIP_ROW}>{builtins.map(renderCard)}</div>
        {customs.length > 0 && (
          <>
            <p className="mt-3 mb-2 text-[11px] text-[var(--text-faint)]">
              自定义波形（{customs.length}）
            </p>
            <div className={CHIP_ROW}>{customs.map(renderCard)}</div>
          </>
        )}
      </div>
    </div>
  );
}
