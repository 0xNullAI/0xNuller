import type { ReactNode } from 'react';
import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from 'lucide-react';
import { Meter } from './meter';

/**
 * Shared primitives for device connection status.
 *
 * Pre-merge these cores existed twice — in DG-Agent's ChatPanel and
 * DG-Voice's DeviceStatusBar — *copied verbatim*: DEVICE_STRENGTH_CAP,
 * BatteryIcon (same 10/30/70 tiers), DeviceStatusChip, ChannelStrengthBar,
 * clampPercentage; all five identical.
 *
 * This collects only "how to display", not "which devices exist" — Agent
 * supports four kinds (paw-prints/civet have no strength bar), Voice only
 * Coyote and Opossum. Device-kind differences stay in each orchestration
 * layer; what is shared is battery tiers, strength-bar ticks, and chip
 * interaction — the parts that truly match.
 */

/** Protocol-level strength cap. Bars normalize against it; the user cap draws as a tick. */
export const DEVICE_STRENGTH_CAP = 200;

export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Battery icon. The 10/30/70 tiers and colors are established product behavior; do not casually change. */
export function BatteryIcon({ level }: { level: number | null | undefined }) {
  if (level == null) return <Battery className="h-3.5 w-3.5 text-[var(--text-faint)]" />;
  if (level <= 10) return <BatteryWarning className="h-3.5 w-3.5 text-[var(--danger)]" />;
  if (level <= 30) return <BatteryLow className="h-3.5 w-3.5 text-[var(--warning)]" />;
  if (level <= 70) return <BatteryMedium className="h-3.5 w-3.5 text-[var(--text-soft)]" />;
  return <BatteryFull className="h-3.5 w-3.5 text-[var(--success)]" />;
}

export interface DeviceStatusChipProps {
  icon: ReactNode;
  battery: number | null | undefined;
  onClick: () => void;
  title: string;
  children?: ReactNode;
}

/** One device's status block: icon + battery (click to disconnect) + custom right side (usually strength bars). */
export function DeviceStatusChip({
  icon,
  battery,
  onClick,
  title,
  children,
}: DeviceStatusChipProps) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 rounded-[8px] px-1.5 py-1 text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] sm:gap-1.5 sm:px-2"
        onClick={onClick}
        title={title}
      >
        {icon}
        <BatteryIcon level={battery} />
        <span className="hidden text-[11px] tabular-nums sm:inline">
          {typeof battery === 'number' ? `${battery}%` : '--'}
        </span>
      </button>
      {children}
    </div>
  );
}

export interface ChannelStrengthBarProps {
  channel: 'A' | 'B';
  /** Current strength (protocol scale 0–200). */
  value: number;
  /** Effective cap, drawn as a tick. Usually min(device limit, user safety setting). */
  max: number;
  className?: string;
}

/**
 * Single-channel strength bar. The tick marks the *effective cap* — the
 * user sees "how much headroom is left" at a glance. This is the safety
 * chain's visible surface; do not simplify it away.
 */
export function ChannelStrengthBar({ channel, value, max, className }: ChannelStrengthBarProps) {
  const normalizedValue = clampPercentage((value / DEVICE_STRENGTH_CAP) * 100);
  const normalizedMax = clampPercentage((max / DEVICE_STRENGTH_CAP) * 100);

  return (
    <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 sm:gap-1.5">
      <span className="text-[10px] font-semibold leading-none tracking-wide text-[var(--accent)]">
        {channel}
      </span>
      <Meter
        value={normalizedValue}
        marker={normalizedMax}
        className={className ?? 'w-16 sm:w-20'}
      />
      <span className="text-[10px] font-medium tabular-nums leading-none text-[var(--text-soft)]">
        {value}
      </span>
    </div>
  );
}

/** Status-bar shell. Modules slot their device chips in; container styling stays uniform. */
export function DeviceStatusRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 sm:px-4">
      {children}
    </div>
  );
}
