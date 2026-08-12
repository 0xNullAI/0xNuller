import { useRef } from 'react';
import { BatteryMedium, BluetoothOff, Pause, Play, RotateCcw } from 'lucide-react';
import type { CoyoteSummary, OpossumSummary } from '../../../chat/src/lib/bluetooth';
import { RepeatButton } from '../../../chat/src/components/RepeatControls';
import {
  CoyoteControl,
  WaveformPanel,
  type WaveformPanelProps,
} from './CoyoteControl';

export type OutputTarget =
  | { id: string; kind: 'coyote'; label: string; coyote: CoyoteSummary }
  | {
      id: 'opossum';
      kind: 'opossum';
      label: string;
      opossum: OpossumSummary;
      limitA: number;
      limitB: number;
    };

interface Props extends Omit<
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
  targets: OutputTarget[];
  selected: OutputTarget | null;
  onSelect: (id: string) => void;
  queueLengthA: number;
  queueLengthB: number;
  firingA: boolean;
  firingB: boolean;
  onAdjust: (channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (channel: 'A' | 'B') => void;
  onFireStart: (channel: 'A' | 'B', boost: number) => void;
  onFireStop: (channel: 'A' | 'B') => void;
  onStop: () => void;
  onDisconnect: () => void;
}

const RING =
  'flex h-[110px] w-[110px] flex-col items-center justify-center gap-0.5 rounded-full border-[3px] border-[var(--surface-border)] bg-[var(--bg-elevated)]';
const STEP =
  'flex h-11 w-11 items-center justify-center rounded-full border-2 border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xl text-[var(--text)] active:scale-[0.92] disabled:opacity-30';

/**
 * The physical-device deck sits above one shared two-channel console. Swiping
 * the deck changes which host every control below addresses; sensor-only
 * devices never enter this deck because they have no output to control.
 */
export function OutputDeviceSection({
  targets,
  selected,
  onSelect,
  queueLengthA,
  queueLengthB,
  firingA,
  firingB,
  onAdjust,
  onTogglePlay,
  onFireStart,
  onFireStop,
  onStop,
  onDisconnect,
  ...waveformPanel
}: Props) {
  const scrollFrame = useRef<number | null>(null);

  const selectNearest = (container: HTMLDivElement) => {
    if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      const center = container.getBoundingClientRect().left + container.clientWidth / 2;
      let nearest: { id: string; distance: number } | null = null;
      for (const element of container.querySelectorAll<HTMLElement>('[data-output-id]')) {
        const box = element.getBoundingClientRect();
        const distance = Math.abs(box.left + box.width / 2 - center);
        if (!nearest || distance < nearest.distance) {
          nearest = { id: element.dataset.outputId ?? '', distance };
        }
      }
      if (nearest?.id && nearest.id !== selected?.id) onSelect(nearest.id);
    });
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-[var(--text-faint)]">主机</h2>
        {targets.length > 1 && (
          <span className="text-[10px] text-[var(--text-faint)]">左右滑动切换</span>
        )}
      </div>

      {targets.length > 0 ? (
        <div
          className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={(event) => selectNearest(event.currentTarget)}
          aria-label="选择输出设备"
        >
          {targets.map((target) => {
            const active = target.id === selected?.id;
            const battery = target.kind === 'coyote' ? target.coyote.battery : target.opossum.battery;
            const valueA =
              target.kind === 'coyote' ? target.coyote.strengthA : target.opossum.intensityA;
            const valueB =
              target.kind === 'coyote' ? target.coyote.strengthB : target.opossum.intensityB;
            return (
              <button
                key={target.id}
                type="button"
                data-output-id={target.id}
                onClick={() => onSelect(target.id)}
                className={`min-w-[78%] snap-center rounded-[var(--radius-md)] border p-3 text-left transition-colors sm:min-w-[55%] ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--surface-border)] bg-[var(--bg-elevated)]'
                }`}
                aria-pressed={active}
              >
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[var(--success)]" aria-hidden />
                  <span className="flex-1 text-sm font-semibold text-[var(--text)]">
                    {target.label}
                  </span>
                  {battery != null && (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
                      <BatteryMedium size={12} /> {battery}%
                    </span>
                  )}
                </span>
                <span className="mt-2 flex gap-3 font-mono text-xs tabular-nums text-[var(--text-soft)]">
                  <span>A {valueA}</span>
                  <span>B {valueB}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 text-center text-sm text-[var(--text-faint)]">
          连接郊狼或负鼠后，在这里切换主机
        </div>
      )}

      <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg)] p-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">
            {selected ? `${selected.label} 控制台` : '双通道控制台'}
          </span>
          {selected && (
            <>
              <button
                type="button"
                onClick={onStop}
                className="flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 text-[11px] text-[var(--text-soft)]"
              >
                <RotateCcw size={12} className="text-[var(--danger)]" /> 归零
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                className="flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 text-[11px] text-[var(--text-soft)]"
              >
                <BluetoothOff size={12} /> 断开
              </button>
            </>
          )}
        </div>

        {selected?.kind === 'coyote' ? (
          <CoyoteControl
            coyote={selected.coyote}
            displayName={selected.label}
            multi={false}
            selected
            onSelect={onSelect}
            queueLengthA={queueLengthA}
            queueLengthB={queueLengthB}
            firingA={firingA}
            firingB={firingB}
            onAdjustStrength={(_id, channel, delta) => onAdjust(channel, delta)}
            onTogglePlay={(_id, channel) => onTogglePlay(channel)}
            onStopDevice={onStop}
            onDisconnect={onDisconnect}
          />
        ) : selected?.kind === 'opossum' ? (
          <OpossumChannels
            target={selected}
            queueLengthA={queueLengthA}
            queueLengthB={queueLengthB}
            firingA={firingA}
            firingB={firingB}
            onAdjust={onAdjust}
            onTogglePlay={onTogglePlay}
          />
        ) : (
          <div className="py-10 text-center text-sm text-[var(--text-faint)]">
            先从顶部设备栏连接主机
          </div>
        )}
      </div>

      <WaveformPanel
        {...waveformPanel}
        targetName={selected?.label ?? null}
        fireEnabledA={Boolean(selected)}
        fireEnabledB={Boolean(selected)}
        fireLimitA={selected?.kind === 'coyote' ? selected.coyote.limitA : selected?.limitA ?? 0}
        fireLimitB={selected?.kind === 'coyote' ? selected.coyote.limitB : selected?.limitB ?? 0}
        firingA={firingA}
        firingB={firingB}
        onFireStart={onFireStart}
        onFireStop={onFireStop}
      />
    </section>
  );
}

function OpossumChannels({
  target,
  queueLengthA,
  queueLengthB,
  firingA,
  firingB,
  onAdjust,
  onTogglePlay,
}: {
  target: Extract<OutputTarget, { kind: 'opossum' }>;
  queueLengthA: number;
  queueLengthB: number;
  firingA: boolean;
  firingB: boolean;
  onAdjust: (channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (channel: 'A' | 'B') => void;
}) {
  return (
    <div className="flex items-center justify-center gap-6">
      {(['A', 'B'] as const).map((channel) => {
        const value = channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB;
        const limit = channel === 'A' ? target.limitA : target.limitB;
        const queueLength = channel === 'A' ? queueLengthA : queueLengthB;
        const firing = channel === 'A' ? firingA : firingB;
        return (
          <div key={channel} className="flex flex-col items-center">
            <button
              type="button"
              onClick={() => onTogglePlay(channel)}
              disabled={value === 0 && queueLength === 0}
              className={`mb-2 flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-30 ${
                value > 0
                  ? 'bg-[var(--danger)] text-white'
                  : 'bg-[var(--accent)] text-[var(--button-text)]'
              }`}
              title={value > 0 ? `暂停 ${channel}` : `启动 ${channel}`}
            >
              {value > 0 ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}
            </button>
            <div className={RING}>
              <span className="text-2xl font-bold tabular-nums text-[var(--text)]">{value}</span>
              <span className="text-[10px] text-[var(--text-faint)]">
                {channel}:{limit}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <RepeatButton
                onAction={() => onAdjust(channel, -1)}
                disabled={firing}
                className={STEP}
              >
                −
              </RepeatButton>
              <RepeatButton
                onAction={() => onAdjust(channel, 1)}
                disabled={firing}
                className={STEP}
              >
                +
              </RepeatButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}
