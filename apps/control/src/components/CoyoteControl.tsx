import { useRef } from 'react';
import {
  BluetoothOff,
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
import type { CoyoteSummary } from '../../../chat/src/lib/bluetooth';
import type { WaveformDefinition } from '../../../chat/src/lib/waveforms';
import type { PlayMode } from '../../../chat/src/lib/protocol';
import { PLAY_INTERVAL_OPTIONS } from '@control/hooks/use-playback';

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

interface CoyoteControlProps {
  coyote: CoyoteSummary;
  /**
   * True while more than one host is attached. It turns on the per-device
   * header (name, battery, 断开, 归零) and the "the waveform panel below drives
   * this one" affordance — all of which are noise when there is only one
   * device and nothing to tell apart.
   */
  multi: boolean;
  /** Whether the shared waveform panel currently targets this host. */
  selected: boolean;
  onSelect: (deviceId: string) => void;
  queueLengthA: number;
  queueLengthB: number;
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
 * The waveform library is deliberately NOT in here (see `WaveformPanel`): it is
 * a library, and duplicating the whole grid per device would bury the controls
 * people actually reach for.
 */
export function CoyoteControl({
  coyote,
  multi,
  selected,
  onSelect,
  queueLengthA,
  queueLengthB,
  onAdjustStrength,
  onTogglePlay,
  onStopDevice,
  onDisconnect,
}: CoyoteControlProps) {
  const renderChannel = (channel: 'A' | 'B') => {
    const strength = channel === 'A' ? coyote.strengthA : coyote.strengthB;
    const limit = channel === 'A' ? coyote.limitA : coyote.limitB;
    const playing = channel === 'A' ? coyote.waveActiveA : coyote.waveActiveB;
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
          >
            −
          </RepeatButton>
          <RepeatButton
            onAction={() => onAdjustStrength(coyote.id, channel, +1)}
            className={STRENGTH_BTN_CLASS}
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
              coyote.strengthA > 0 || coyote.strengthB > 0
                ? 'bg-[var(--accent)]'
                : 'bg-[var(--success)]'
            }`}
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-[var(--text)]">{coyote.name}</span>
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
          title={`只把 ${coyote.name} 归零`}
        >
          <RotateCcw size={11} className="text-[var(--danger)]" />
          归零
        </button>
        <button
          type="button"
          onClick={() => onDisconnect(coyote.id)}
          className="flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 text-[11px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
          title={`断开 ${coyote.name}`}
        >
          <BluetoothOff size={11} />
          断开
        </button>
      </div>
      {body}
    </div>
  );
}

interface WaveformPanelProps {
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
  /** Zero every attached device. Never narrowed to one host — see below. */
  onStopAll: () => void;
}

/**
 * The waveform library, plus the all-devices 归零.
 *
 * One panel for the whole module rather than one per host: the library and the
 * playlist are a property of "what I want to feel", not of a particular piece
 * of hardware, and repeating a 20-tile grid per device would push the strength
 * controls off the screen.
 *
 * The big 归零 stays here and stays *global* — it zeroes every attached host
 * and the Opossum. The per-device 归零 in each `CoyoteControl` header is an
 * addition, never a replacement: stop has to remain one action away from
 * covering everything, and N buttons that each cover a third of the problem is
 * not that.
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
  onStopAll,
}: WaveformPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          <span className="absolute top-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--button-text)]">
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
    <>
      {/* ==================== Reset bar ====================
          Stop is always one action away, it covers every attached host, and it
          does not care whether a Coyote is attached at all: stopAll zeroes the
          Opossum too. */}
      <div className="mt-5 flex items-center justify-center">
        <button
          onClick={onStopAll}
          className="flex h-11 max-w-xs flex-1 items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-soft)] active:scale-[0.98]"
        >
          <RotateCcw size={15} className="text-[var(--danger)]" />
          全部归零
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

      {targetName && (
        <p className="mt-2 text-[11px] text-[var(--text-faint)]">
          作用于 <span className="text-[var(--accent)]">{targetName}</span>，点上方设备标题可切换
        </p>
      )}

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
    </>
  );
}

interface CoyoteSectionProps extends Omit<WaveformPanelProps, 'targetName'> {
  coyotes: CoyoteSummary[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
  queueLengthA: number;
  queueLengthB: number;
  onAdjustStrength: (deviceId: string, channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (deviceId: string, channel: 'A' | 'B') => void;
  onStopDevice: (deviceId: string) => void;
  onDisconnect: (deviceId: string) => void;
}

/**
 * Section two: every attached Coyote, then the shared waveform library.
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
  onStopDevice,
  onDisconnect,
  ...panel
}: CoyoteSectionProps) {
  const multi = coyotes.length > 1;
  const selected = coyotes.find((c) => c.id === selectedId) ?? coyotes[0] ?? null;

  return (
    <section>
      <h2 className="mb-3 text-xs font-medium tracking-wide text-[var(--text-faint)]">
        郊狼主机{multi ? `（${coyotes.length} 台）` : ''}
      </h2>

      {coyotes.length === 0 ? (
        <PlaceholderChannels />
      ) : (
        <div className="flex flex-col gap-3">
          {coyotes.map((coyote) => (
            <CoyoteControl
              key={coyote.id}
              coyote={coyote}
              multi={multi}
              selected={multi && coyote.id === selected?.id}
              onSelect={onSelect}
              queueLengthA={queueLengthA}
              queueLengthB={queueLengthB}
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
        targetName={multi ? (selected?.name ?? null) : null}
        queue={panel.queue}
      />
    </section>
  );
}

/** The nothing-attached stand-in: the same two rings, inert. */
function PlaceholderChannels() {
  return (
    <div className="flex items-center justify-center gap-6 opacity-40">
      {(['A', 'B'] as const).map((channel) => (
        <div key={channel} className="flex flex-col items-center">
          <div className="mb-2 h-9 w-9 rounded-full bg-[var(--bg-soft)]" />
          <div className={RING_CLASS}>
            <span className="text-2xl font-bold tabular-nums text-[var(--text)]">0</span>
            <span className="text-[10px] text-[var(--text-faint)]">{channel}</span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className={STRENGTH_BTN_CLASS}>−</span>
            <span className={STRENGTH_BTN_CLASS}>+</span>
          </div>
        </div>
      ))}
    </div>
  );
}
