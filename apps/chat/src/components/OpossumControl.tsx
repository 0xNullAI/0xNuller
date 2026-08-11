import { Gauge, Zap, RotateCcw, BatteryMedium } from 'lucide-react';
import { LedColorPicker } from './LedColorPicker';
import { IntensityRing, RepeatButton } from './RepeatControls';

interface OpossumControlProps {
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
  onPickLedColor: (color: number) => void;
}

const BURST_STRENGTH_RATIO = 0.8;
const BURST_DURATION_MS = 500;

/**
 * Control panel for the Opossum (dual-channel vibration controller). Adapted from
 * MemberControl's dual-channel strength rings: range 0-200 (reusing the Coyote's limitA/limitB
 * safety limits rather than a second limit UI of its own — see the notes in DeviceSafetyButton).
 * It has no notion of waveforms or frequency, so there is no waveform tab, just direct
 * strength +/- and a one-tap burst button.
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
  onPickLedColor,
}: OpossumControlProps) {
  if (!connected) return null;

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <Gauge size={15} className="text-[var(--accent)]" />
          Opossum 振动控制器
        </div>
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

      <LedColorPicker
        className="mt-3 border-t border-[var(--surface-border)] pt-2"
        onPick={onPickLedColor}
      />
    </div>
  );
}
