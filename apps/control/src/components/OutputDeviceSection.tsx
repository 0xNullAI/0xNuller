import { useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BatteryMedium,
  Pause,
  Play,
} from 'lucide-react';
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
 * Each horizontal slide is the host card and its two-channel console together.
 * Swiping therefore changes the complete control surface, not just a label.
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

  const moveTarget = (direction: -1 | 1) => {
    if (targets.length < 2) return;
    const currentIndex = Math.max(
      0,
      targets.findIndex((target) => target.id === selected?.id),
    );
    const next = targets[(currentIndex + direction + targets.length) % targets.length];
    if (!next) return;
    onSelect(next.id);
    const slide = [...document.querySelectorAll<HTMLElement>('[data-output-id]')].find(
      (element) => element.dataset.outputId === next.id,
    );
    slide?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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
        <div className="relative">
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
              <div
                key={target.id}
                data-output-id={target.id}
                className={`min-w-[88%] snap-center rounded-[var(--radius-md)] border p-3 transition-colors sm:min-w-[62%] ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--surface-border)] bg-[var(--bg-elevated)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(target.id)}
                  className="flex min-h-9 w-full touch-manipulation items-center gap-2 text-left"
                  aria-pressed={active}
                >
                  <span className="h-2 w-2 rounded-full bg-[var(--success)]" aria-hidden />
                  <span className="flex-1 text-sm font-semibold text-[var(--text)]">
                    {target.label}
                  </span>
                  {battery != null && (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
                      <BatteryMedium size={12} /> {battery}%
                    </span>
                  )}
                  <span className="font-mono text-xs tabular-nums text-[var(--text-soft)]">
                    A {valueA} · B {valueB}
                  </span>
                </button>
                <div className="mt-2 border-t border-[var(--surface-border)] pt-3">
                  {target.kind === 'coyote' ? (
                    <CoyoteControl
                      coyote={target.coyote}
                      displayName={target.label}
                      multi={false}
                      selected
                      onSelect={onSelect}
                      queueLengthA={queueLengthA}
                      queueLengthB={queueLengthB}
                      firingA={target.id === selected?.id ? firingA : false}
                      firingB={target.id === selected?.id ? firingB : false}
                      onAdjustStrength={(_id, channel, delta) => {
                        onSelect(target.id);
                        onAdjust(channel, delta);
                      }}
                      onTogglePlay={(_id, channel) => {
                        onSelect(target.id);
                        onTogglePlay(channel);
                      }}
                      onStopDevice={() => {
                        onSelect(target.id);
                        onStop();
                      }}
                      onDisconnect={() => {
                        onSelect(target.id);
                        onDisconnect();
                      }}
                    />
                  ) : (
                    <OpossumChannels
                      target={target}
                      queueLengthA={queueLengthA}
                      queueLengthB={queueLengthB}
                      firingA={target.id === selected?.id ? firingA : false}
                      firingB={target.id === selected?.id ? firingB : false}
                      onAdjust={(channel, delta) => {
                        onSelect(target.id);
                        onAdjust(channel, delta);
                      }}
                      onTogglePlay={(channel) => {
                        onSelect(target.id);
                        onTogglePlay(channel);
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
          </div>
          {targets.length > 1 && (
            <>
              <button
                type="button"
                aria-label="上一个主机"
                onClick={() => moveTarget(-1)}
                className="absolute left-0 top-1/2 z-[var(--z-local-popover)] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)]/95 text-[var(--text)] shadow-sm touch-manipulation hover:bg-[var(--accent-soft)]"
              >
                <ArrowLeft size={17} />
              </button>
              <button
                type="button"
                aria-label="下一个主机"
                onClick={() => moveTarget(1)}
                className="absolute right-0 top-1/2 z-[var(--z-local-popover)] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)]/95 text-[var(--text)] shadow-sm touch-manipulation hover:bg-[var(--accent-soft)]"
              >
                <ArrowRight size={17} />
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 text-center text-sm text-[var(--text-faint)]">
          连接郊狼或负鼠后，在这里切换主机
        </div>
      )}

      {targets.length === 0 && (
        <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg)] p-3">
          <div className="py-10 text-center text-sm text-[var(--text-faint)]">
            先从顶部设备栏连接主机
          </div>
        </div>
        )}

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
