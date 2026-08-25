import { useRef } from 'react';
import { ArrowLeft, ArrowRight, BatteryMedium, Pause, Play } from 'lucide-react';
import type { CoyoteSummary, OpossumSummary } from '@0xnullai/device-runtime';
import { RepeatButton } from '@0xnullai/ui';
import { CoyoteControl, WaveformPanel, type WaveformPanelProps } from './CoyoteControl';

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

/**
 * Everything needed to render one device's complete console. The queues are
 * kept separately from `queue` because the Coyote rings need both channel
 * lengths while the waveform panel shows only the selected channel.
 */
export type OutputPanelState = Omit<WaveformPanelProps, 'targetName' | 'queue'> & {
  queue: string[];
  queueA: string[];
  queueB: string[];
};

interface Props {
  targets: OutputTarget[];
  selected: OutputTarget | null;
  onSelect: (id: string) => void;
  panelForTarget: (target: OutputTarget) => OutputPanelState;
  emptyPanel: OutputPanelState;
  onAdjust: (targetId: string, channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (targetId: string, channel: 'A' | 'B') => void;
  onStop: (targetId: string) => void;
  onDisconnect: (targetId: string) => void;
}

const RING =
  'flex h-24 w-24 flex-col items-center justify-center gap-0.5 rounded-full border-[3px] border-[var(--surface-border)] bg-[var(--bg-elevated)]';
const STEP =
  'flex h-10 w-10 items-center justify-center rounded-full border-2 border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xl text-[var(--text)] active:scale-[0.92] disabled:opacity-30';

/**
 * Each horizontal slide is one compact physical-device controller. The
 * selected device's independently keyed fire, queue and waveform controls sit
 * directly below the deck, outside the tinted hardware card.
 */
export function OutputDeviceSection({
  targets,
  selected,
  onSelect,
  panelForTarget,
  emptyPanel,
  onAdjust,
  onTogglePlay,
  onStop,
  onDisconnect,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const findSlide = (targetId: string) =>
    [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-output-id]') ?? [])].find(
      (element) => element.dataset.outputId === targetId,
    );

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
    const slide = findSlide(next.id);
    slide?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };
  const selectedPanel = selected ? panelForTarget(selected) : null;

  return (
    <section className="mx-auto w-full max-w-[680px]">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium tracking-wide text-[var(--text-faint)]">主机</h2>
          {targets.length > 1 && (
            <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">
              {Math.max(0, targets.findIndex((target) => target.id === selected?.id) + 1)} /{' '}
              {targets.length} · 左右滑动切换完整控制页
              {targets.filter((target) => target.kind === 'coyote').length > 1
                ? ' · 郊狼按类型共享波形文件，播放状态独立'
                : ''}
            </p>
          )}
        </div>
        {targets.length > 1 && (
          <div className="flex gap-1" aria-label="设备页面">
            {targets.map((target) => (
              <button
                key={target.id}
                type="button"
                aria-label={`切换到 ${target.label}`}
                aria-pressed={target.id === selected?.id}
                onClick={() => {
                  onSelect(target.id);
                  findSlide(target.id)?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                    inline: 'center',
                  });
                }}
                className={`h-1.5 rounded-full transition-all ${
                  target.id === selected?.id
                    ? 'w-5 bg-[var(--accent)]'
                    : 'w-1.5 bg-[var(--surface-border)]'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {targets.length > 0 && selected && selectedPanel ? (
        <>
          <div className="relative mx-auto w-full">
            <div
              ref={scrollRef}
              className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onScroll={(event) => selectNearest(event.currentTarget)}
              aria-label="选择输出设备"
            >
              {targets.map((target) => {
                const active = target.id === selected?.id;
                const panel = panelForTarget(target);
                const battery =
                  target.kind === 'coyote' ? target.coyote.battery : target.opossum.battery;
                const valueA =
                  target.kind === 'coyote' ? target.coyote.strengthA : target.opossum.intensityA;
                const valueB =
                  target.kind === 'coyote' ? target.coyote.strengthB : target.opossum.intensityB;
                return (
                  <article
                    key={target.id}
                    data-output-id={target.id}
                    className={`min-w-full snap-center rounded-[var(--radius-md)] border p-4 transition-colors ${
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--surface-border)] bg-[var(--bg-elevated)]'
                    }`}
                  >
                    <header className="flex min-h-9 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSelect(target.id)}
                        className="flex min-w-0 flex-1 touch-manipulation items-center gap-2 text-left"
                        aria-pressed={active}
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-[var(--success)]"
                          aria-hidden
                        />
                        <span className="truncate text-sm font-semibold text-[var(--text)]">
                          {target.label}
                        </span>
                        {battery != null && (
                          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-faint)]">
                            <BatteryMedium size={12} /> {battery}%
                          </span>
                        )}
                        <span className="font-mono text-xs tabular-nums text-[var(--text-soft)]">
                          A {valueA} · B {valueB}
                        </span>
                      </button>
                    </header>

                    <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
                      {target.kind === 'coyote' ? (
                        <CoyoteControl
                          coyote={target.coyote}
                          displayName={target.label}
                          multi={false}
                          selected={active}
                          onSelect={onSelect}
                          queueLengthA={panel.queueA.length}
                          queueLengthB={panel.queueB.length}
                          firingA={active && panel.firingA}
                          firingB={active && panel.firingB}
                          onAdjustStrength={(deviceId, channel, delta) => {
                            onSelect(target.id);
                            onAdjust(target.id, channel, delta);
                          }}
                          onTogglePlay={(deviceId, channel) => {
                            onSelect(target.id);
                            onTogglePlay(target.id, channel);
                          }}
                          onStopDevice={() => onStop(target.id)}
                          onDisconnect={() => onDisconnect(target.id)}
                        />
                      ) : (
                        <OpossumChannels
                          target={target}
                          queueLengthA={panel.queueA.length}
                          queueLengthB={panel.queueB.length}
                          firingA={active && panel.firingA}
                          firingB={active && panel.firingB}
                          onAdjust={(channel, delta) => {
                            onSelect(target.id);
                            onAdjust(target.id, channel, delta);
                          }}
                          onTogglePlay={(channel) => {
                            onSelect(target.id);
                            onTogglePlay(target.id, channel);
                          }}
                        />
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            {targets.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="上一个设备页"
                  onClick={() => moveTarget(-1)}
                  className="absolute left-1 top-1/2 z-[var(--z-local-popover)] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)]/95 text-[var(--text)] shadow-sm touch-manipulation hover:bg-[var(--accent-soft)]"
                >
                  <ArrowLeft size={17} />
                </button>
                <button
                  type="button"
                  aria-label="下一个设备页"
                  onClick={() => moveTarget(1)}
                  className="absolute right-1 top-1/2 z-[var(--z-local-popover)] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)]/95 text-[var(--text)] shadow-sm touch-manipulation hover:bg-[var(--accent-soft)]"
                >
                  <ArrowRight size={17} />
                </button>
              </>
            )}
          </div>
          <WaveformPanel
            {...selectedPanel}
            targetName={targets.length > 1 ? selected.label : null}
            onFireStart={(channel, boost) => {
              onSelect(selected.id);
              selectedPanel.onFireStart(channel, boost);
            }}
            onFireStop={selectedPanel.onFireStop}
          />
        </>
      ) : (
        <>
          <DefaultCoyoteConsole />
          <WaveformPanel {...emptyPanel} targetName={null} disabled />
        </>
      )}
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
    <div className="flex flex-wrap items-center justify-center gap-6">
      {(['A', 'B'] as const).map((channel) => {
        const value = channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB;
        const limit = channel === 'A' ? target.limitA : target.limitB;
        const firing = channel === 'A' ? firingA : firingB;
        const queueLength = channel === 'A' ? queueLengthA : queueLengthB;
        return (
          <div key={channel} className="flex flex-col items-center">
            <button
              type="button"
              onClick={() => onTogglePlay(channel)}
              disabled={value <= 0 && queueLength === 0}
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

/** A truthful default state: the familiar Coyote console, present but inert. */
function DefaultCoyoteConsole() {
  return (
    <article
      aria-label="未连接的郊狼控制台"
      className="rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 text-[var(--text-faint)]"
    >
      <header className="flex min-h-9 items-center gap-2 border-b border-[var(--surface-border)] pb-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--surface-border)]" aria-hidden />
        <span className="text-sm font-semibold">郊狼</span>
        <span className="ml-auto text-[11px]">未连接 · 请从顶部连接设备</span>
      </header>
      <div className="mt-3 flex items-center justify-center gap-5 opacity-55" aria-disabled>
        {(['A', 'B'] as const).map((channel) => (
          <div key={channel} className="flex flex-col items-center">
            <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface-border)]/60">
              <Play size={16} fill="currentColor" />
            </span>
            <div className={RING}>
              <span className="text-2xl font-bold tabular-nums">0</span>
              <span className="text-[10px]">{channel}:0</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <span className={STEP}>−</span>
              <span className={STEP}>+</span>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
