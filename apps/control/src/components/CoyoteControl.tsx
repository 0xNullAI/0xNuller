import { useRef } from 'react';
import {
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
} from 'lucide-react';
import { RepeatButton } from '../../../chat/src/components/RepeatControls';
import type { WaveformDefinition } from '../../../chat/src/lib/waveforms';
import type { PlayMode } from '../../../chat/src/lib/protocol';
import { PLAY_INTERVAL_OPTIONS } from '@control/hooks/use-playback';

interface CoyoteControlProps {
  connected: boolean;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  playingA: boolean;
  playingB: boolean;
  queueLengthA: number;
  queueLengthB: number;
  onAdjustStrength: (channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (channel: 'A' | 'B') => void;
  onStopAll: () => void;

  waveTab: 'A' | 'B';
  onWaveTabChange: (channel: 'A' | 'B') => void;

  waveforms: WaveformDefinition[];
  /** Queue of the channel the tab is on. */
  queue: string[];
  /** Waveform playing on that channel, if any. */
  activeWaveId: string | null;
  playMode: PlayMode;
  intervalSec: number;
  onPlayModeChange: (mode: PlayMode) => void;
  onIntervalChange: (seconds: number) => void;
  onToggleWaveform: (waveform: WaveformDefinition) => void;
  onRemoveWaveform: (id: string) => void;
  onImportFile: (file: File) => Promise<string | null>;
  onOpenMarket: () => void;
}

const RING_CLASS =
  'flex h-[110px] w-[110px] flex-col items-center justify-center gap-0.5 rounded-full border-[3px] border-[var(--surface-border)] bg-[var(--bg-elevated)] transition-colors hover:border-[var(--accent)]';

const STRENGTH_BTN_CLASS =
  'flex h-11 w-11 select-none items-center justify-center rounded-full border-2 border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xl font-medium text-[var(--text)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] active:scale-[0.92]';

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

/**
 * The Coyote panel: strength, playback, waveforms.
 *
 * The layout is MemberControl's — rings, 归零, channel tab, play mode, grid —
 * because it is a shape people already know from Chat. None of the wiring is:
 * there is no room to send to, no fire heartbeat to keep alive and no aggregate
 * to unwind, so every control here calls straight into the caller's own device.
 */
export function CoyoteControl({
  connected,
  strengthA,
  strengthB,
  limitA,
  limitB,
  playingA,
  playingB,
  queueLengthA,
  queueLengthB,
  onAdjustStrength,
  onTogglePlay,
  onStopAll,
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
}: CoyoteControlProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const error = await onImportFile(file);
    if (error) window.alert(error);
    e.target.value = '';
  }

  const renderChannel = (channel: 'A' | 'B') => {
    const strength = channel === 'A' ? strengthA : strengthB;
    const limit = channel === 'A' ? limitA : limitB;
    const playing = channel === 'A' ? playingA : playingB;
    const queueLength = channel === 'A' ? queueLengthA : queueLengthB;
    return (
      <div className="flex flex-col items-center">
        <button
          onClick={() => onTogglePlay(channel)}
          disabled={!connected || (!playing && queueLength === 0)}
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
            onAction={() => onAdjustStrength(channel, -1)}
            className={STRENGTH_BTN_CLASS}
          >
            −
          </RepeatButton>
          <RepeatButton
            onAction={() => onAdjustStrength(channel, +1)}
            className={STRENGTH_BTN_CLASS}
          >
            +
          </RepeatButton>
        </div>
      </div>
    );
  };

  const renderCard = (waveform: WaveformDefinition) => {
    const queued = queue.includes(waveform.id);
    const active = activeWaveId === waveform.id;
    return (
      <div
        key={waveform.id}
        role="button"
        tabIndex={0}
        onClick={() => onToggleWaveform(waveform)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleWaveform(waveform);
          }
        }}
        className={`group relative flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-[1.5px] px-1 pt-3 pb-2.5 transition-all active:scale-95 ${
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
          <span className="absolute top-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-white">
            {queue.indexOf(waveform.id) + 1}
          </span>
        )}
        {!queued && (
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
    <section>
      <h2 className="mb-3 text-xs font-medium tracking-wide text-[var(--text-faint)]">郊狼主机</h2>

      {/* ==================== Dual channel strength ==================== */}
      <div className="flex items-center justify-center gap-6">
        {renderChannel('A')}
        {renderChannel('B')}
      </div>

      {/* ==================== Reset bar ====================
          Stop is always one action away, and it does not care whether a Coyote
          is attached: stopAll zeroes the Opossum too. */}
      <div className="mt-5 flex items-center justify-center">
        <button
          onClick={onStopAll}
          className="flex h-11 max-w-xs flex-1 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-soft)] active:scale-[0.98]"
        >
          <RotateCcw size={15} className="text-[var(--danger)]" />
          归零
        </button>
      </div>

      {/* ==================== A/B channel wave tab ==================== */}
      <div className="mt-5 flex overflow-hidden rounded-[var(--radius-sm)] border border-[var(--surface-border)]">
        {(['A', 'B'] as const).map((channel) => (
          <button
            key={channel}
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

      {/* ==================== Play mode ==================== */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {MODE_BUTTONS.map(({ mode, label, title }) => (
            <button
              key={mode}
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
              onClick={onOpenMarket}
              className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
            >
              <Store size={12} /> 从市场导入
            </button>
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
    </section>
  );
}
