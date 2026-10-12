import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BatteryMedium, Bluetooth } from 'lucide-react';
import type { CoyoteSummary, OpossumSummary } from '@0xnullai/device-runtime';
import { OutputTargetPicker } from '@0xnullai/ui';
import {
  ChannelStepper,
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
  onConnect: () => unknown | Promise<unknown>;
  onAdjust: (targetId: string, channel: 'A' | 'B', delta: number) => void;
  onTogglePlay: (targetId: string, channel: 'A' | 'B') => void;
  /** Stop every output now. The same stop path as the shell bar; never gated by state. */
  /** Disconnect one output. The registry stops it before it drops the link. */
  onDisconnect: (targetId: string) => unknown | Promise<unknown>;
}

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
  onConnect,
  onAdjust,
  onTogglePlay,
  onDisconnect,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const selectedId = selected?.id;
  const targetOrder = JSON.stringify(targets.map((target) => target.id));

  // Selection can change without a carousel click (connect/disconnect, device
  // state reconciliation). Keep the visible hardware card aligned with the
  // console that receives output; scroll only this strip, never the page.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const slide = selectedId
      ? [...(container?.querySelectorAll<HTMLElement>('[data-output-id]') ?? [])].find(
          (element) => element.dataset.outputId === selectedId,
        )
      : null;
    if (!container || !slide) return;
    const frame = container.getBoundingClientRect();
    const card = slide.getBoundingClientRect();
    container.scrollLeft += card.left - frame.left - (frame.width - card.width) / 2;
  }, [selectedId, targetOrder]);

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
  };
  const selectedPanel = selected ? panelForTarget(selected) : null;

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      await onConnect();
    } catch (reason) {
      setConnectError(reason instanceof Error ? reason.message : '连接设备失败，请重试。');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <section className="min-w-0 w-full" aria-label="设备控制">
      {targets.length > 0 && selected && selectedPanel ? (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
          <div className="min-w-0">
            {targets.length > 1 && (
              <div className="mb-3">
                <OutputTargetPicker
                  targets={targets.map((target) => ({
                    id: target.id,
                    kind: target.kind,
                    label: target.label,
                    battery:
                      target.kind === 'coyote' ? target.coyote.battery : target.opossum.battery,
                    active:
                      target.kind === 'coyote'
                        ? target.coyote.strengthA > 0 || target.coyote.strengthB > 0
                        : target.opossum.intensityA > 0 || target.opossum.intensityB > 0,
                  }))}
                  selectedId={selected.id}
                  label="当前设备"
                  onSelect={onSelect}
                />
              </div>
            )}
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
                  return (
                    <article
                      key={target.id}
                      data-output-id={target.id}
                      aria-label={target.label}
                      className={`min-w-full snap-center rounded-[var(--radius-md)] border bg-[var(--bg-elevated)] p-4 transition-colors sm:p-6 ${
                        active ? 'border-[var(--accent)]' : 'border-[var(--surface-border)]'
                      }`}
                    >
                      <header className="flex min-h-10 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onSelect(target.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 touch-manipulation text-left"
                          aria-pressed={active}
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-[var(--success)]"
                            aria-hidden
                          />
                          <span className="truncate text-base font-semibold text-[var(--text)]">
                            {target.label}
                          </span>
                          {battery != null && (
                            <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-[var(--text-faint)]">
                              <BatteryMedium size={14} aria-hidden /> {battery}%
                            </span>
                          )}
                        </button>
                      </header>

                      <div className="mt-4">
                        {target.kind === 'coyote' ? (
                          <CoyoteControl
                            coyote={target.coyote}
                            queueLengthA={panel.queueA.length}
                            queueLengthB={panel.queueB.length}
                            firingA={active && panel.firingA}
                            firingB={active && panel.firingB}
                            onAdjustStrength={(channel, delta) => {
                              onSelect(target.id);
                              onAdjust(target.id, channel, delta);
                            }}
                            onTogglePlay={(channel) => {
                              onSelect(target.id);
                              onTogglePlay(target.id, channel);
                            }}
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
                      <div className="mt-4 flex justify-center">
                        <button
                          type="button"
                          disabled={disconnecting === target.id}
                          onClick={() => {
                            if (disconnecting) return;
                            setDisconnecting(target.id);
                            void Promise.resolve()
                              .then(() => onDisconnect(target.id))
                              .finally(() => setDisconnecting(null));
                          }}
                          className="ui-press rounded-full px-3 py-1.5 text-sm text-[var(--text-faint)] hover:bg-[var(--bg-soft)] hover:text-[var(--danger)] disabled:opacity-50"
                        >
                          {disconnecting === target.id ? '断开中…' : `断开${target.label}`}
                        </button>
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
          </div>
          <section
            aria-labelledby="waveform-controls-title"
            className="min-w-0 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 sm:p-5"
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--surface-border)] pb-3">
              <h3 id="waveform-controls-title" className="text-sm font-semibold text-[var(--text)]">
                波形
              </h3>
              {targets.length > 1 && (
                <span className="truncate text-xs text-[var(--text-soft)]">{selected.label}</span>
              )}
            </div>
            <WaveformPanel
              {...selectedPanel}
              targetName={null}
              onFireStart={(channel, boost) => {
                onSelect(selected.id);
                selectedPanel.onFireStart(channel, boost);
              }}
              onFireStop={selectedPanel.onFireStop}
            />
          </section>
        </div>
      ) : (
        <DisconnectedOutputState
          connecting={connecting}
          error={connectError}
          onConnect={() => void connect()}
        />
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
    <div className="grid grid-cols-2 gap-3">
      {(['A', 'B'] as const).map((channel) => {
        const value = channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB;
        const queueLength = channel === 'A' ? queueLengthA : queueLengthB;
        return (
          <ChannelStepper
            key={channel}
            channel={channel}
            value={value}
            limit={channel === 'A' ? target.limitA : target.limitB}
            firing={channel === 'A' ? firingA : firingB}
            playing={value > 0}
            playDisabled={value <= 0 && queueLength === 0}
            playTitle={value > 0 ? `暂停 ${channel}` : `启动 ${channel}`}
            onAdjust={(delta) => onAdjust(channel, delta)}
            onTogglePlay={() => onTogglePlay(channel)}
          />
        );
      })}
    </div>
  );
}

function DisconnectedOutputState({
  connecting,
  error,
  onConnect,
}: {
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  return (
    <article
      aria-labelledby="disconnected-output-title"
      className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 px-4 text-center"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)]">
        <Bluetooth size={20} aria-hidden />
      </div>
      <h2 id="disconnected-output-title" className="text-base font-medium text-[var(--text)]">
        尚未连接设备
      </h2>
      {error && (
        <p className="-mt-2 text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onConnect}
        disabled={connecting}
        className="ui-press inline-flex h-11 touch-manipulation items-center justify-center rounded-full bg-[var(--accent)] px-6 text-[15px] font-semibold text-[var(--button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
      >
        {connecting ? '连接中…' : '连接设备'}
      </button>
    </article>
  );
}
