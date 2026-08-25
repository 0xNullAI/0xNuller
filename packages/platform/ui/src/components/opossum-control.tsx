import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Gauge, Zap, RotateCcw, BatteryMedium } from 'lucide-react';

export interface OpossumControlProps {
  connected: boolean;
  battery: number | null | undefined;
  intensityA: number;
  intensityB: number;
  /** The safety limits shared with the Coyote (0-200), see the notes in DeviceSafetyButton. */
  limitA: number;
  limitB: number;
  onAdjust: (channel: 'A' | 'B', delta: number) => void;
  /** Spike to `strength` for `durationMs`, then fall back on its own. */
  onBurst: (channel: 'A' | 'B', strength: number, durationMs: number) => void;
  onStop: () => void;
  onPatternChange?: (
    channel: 'A' | 'B',
    pattern: 'constant' | 'pulse' | 'wave' | 'ramp' | 'heartbeat',
  ) => void;
  lastButtons?: string | null;
}

const BURST_STRENGTH_RATIO = 0.8;
const BURST_DURATION_MS = 500;
const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RepeatButton({ onAction, children }: { onAction: () => void; children: ReactNode }) {
  const delayRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const actionRef = useRef(onAction);
  // Keep hold-to-repeat commands on the latest channel state without waiting one effect cycle.
  actionRef.current = onAction;

  const stop = useCallback(() => {
    if (delayRef.current) window.clearTimeout(delayRef.current);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    delayRef.current = null;
    intervalRef.current = null;
  }, []);
  const start = useCallback(() => {
    stop();
    actionRef.current();
    delayRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => actionRef.current(), 100);
    }, 400);
  }, [stop]);
  useEffect(() => stop, [stop]);

  return (
    <button
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xs text-[var(--text)] hover:border-[var(--accent)] active:scale-90"
      style={{ touchAction: 'manipulation', WebkitUserSelect: 'none', userSelect: 'none' }}
    >
      {children}
    </button>
  );
}

function IntensityRing({ label, value, limit }: { label: string; value: number; limit: number }) {
  const percentage = limit > 0 ? Math.min(1, value / limit) : 0;
  return (
    <div className="relative flex items-center justify-center" style={{ width: 96, height: 96 }}>
      <svg className="absolute inset-0" viewBox="0 0 96 96">
        <circle
          cx="48"
          cy="48"
          r={RING_RADIUS}
          fill="none"
          stroke="var(--surface-border)"
          strokeWidth="6"
        />
        <circle
          cx="48"
          cy="48"
          r={RING_RADIUS}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - percentage)}
          transform="rotate(-90 48 48)"
          className="transition-all duration-[var(--dur)]"
        />
      </svg>
      <div className="flex flex-col items-center">
        <span className="text-xl font-bold tabular-nums text-[var(--text)]">{value}</span>
        <span className="text-[10px] text-[var(--text-faint)]">
          {label}:{limit}
        </span>
      </div>
    </div>
  );
}

/**
 * Control panel for the Opossum (dual-channel vibration controller). Adapted from
 * MemberControl's dual-channel strength rings: range 0-200 (reusing the Coyote's limitA/limitB
 * safety limits rather than a second limit UI of its own — see the notes in DeviceSafetyButton).
 * Opossum has no frequency axis, so the panel uses named rhythm envelopes
 * (constant/pulse/wave/ramp/heartbeat) alongside direct strength +/- and a
 * one-tap burst button.
 *
 * The callbacks are what makes it work for both Chat and Control: Chat points them at the room
 * command channel, Control points them straight at its own `useDevice`. Everything that decides
 * what actually reaches the body — the caps, the command queue — sits behind them either way.
 */
export function OpossumControl({
  connected,
  battery,
  intensityA,
  intensityB,
  limitA,
  limitB,
  onAdjust,
  onBurst,
  onStop,
  onPatternChange,
  lastButtons,
}: OpossumControlProps) {
  const [patterns, setPatterns] = useState<
    Record<'A' | 'B', 'constant' | 'pulse' | 'wave' | 'ramp' | 'heartbeat'>
  >({ A: 'constant', B: 'constant' });
  if (!connected) return null;

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <Gauge size={15} className="text-[var(--accent)]" />
          Opossum 振动控制器
        </div>
        {lastButtons && (
          <span className="text-[10px] text-[var(--accent)]">按键：{lastButtons}</span>
        )}
        {battery != null && (
          <span className="flex items-center gap-0.5 text-xs text-[var(--text-soft)]">
            <BatteryMedium size={13} /> {battery}%
          </span>
        )}
      </div>

      <div className="flex items-center justify-center gap-6">
        {(['A', 'B'] as const).map((channel) => {
          const value = channel === 'A' ? intensityA : intensityB;
          const limit = channel === 'A' ? limitA : limitB;
          return (
            <div key={channel} className="flex flex-col items-center">
              <IntensityRing label={channel} value={value} limit={limit} />
              <div className="mt-2 flex items-center gap-2">
                <RepeatButton onAction={() => onAdjust(channel, -1)}>−</RepeatButton>
                <RepeatButton onAction={() => onAdjust(channel, +1)}>+</RepeatButton>
              </div>
              <button
                onClick={() =>
                  onBurst(channel, Math.round(limit * BURST_STRENGTH_RATIO), BURST_DURATION_MS)
                }
                className="mt-2 flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] text-[var(--accent)] transition-opacity hover:opacity-80"
                title="短促脉冲后自动回落"
              >
                <Zap size={11} /> 脉冲
              </button>
              <select
                value={patterns[channel]}
                onChange={(e) => {
                  const pattern = e.target.value as typeof patterns.A;
                  setPatterns((current) => ({ ...current, [channel]: pattern }));
                  onPatternChange?.(channel, pattern);
                }}
                className="mt-2 rounded border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px]"
                aria-label={`${channel} 通道节奏`}
              >
                <option value="constant">恒定</option>
                <option value="pulse">脉冲</option>
                <option value="wave">波浪</option>
                <option value="ramp">渐强</option>
                <option value="heartbeat">心跳</option>
              </select>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex justify-center">
        <button
          onClick={onStop}
          className="flex h-9 flex-1 max-w-xs items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-soft)] active:scale-[0.98]"
        >
          <RotateCcw size={14} className="text-[var(--danger)]" />
          归零
        </button>
      </div>
    </div>
  );
}
