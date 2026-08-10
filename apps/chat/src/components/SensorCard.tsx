import { Radar, BatteryMedium } from 'lucide-react';
import type { SensorKind } from '../lib/protocol';
import { LedColorPicker } from './LedColorPicker';

interface SensorCardProps {
  kind: SensorKind | null | undefined;
  connected: boolean;
  battery: number | null | undefined;
  /** Human-readable summary of the most recent reading. */
  lastEvent: string | null | undefined;
  /** Raw numeric value of the last reading (civet-edging pressure in kPa). */
  lastValue: number | null | undefined;
  lastEventAt: number | null | undefined;
  onPickLedColor: (color: number) => void;
}

const KIND_LABEL: Record<string, string> = {
  'paw-prints': '爪印传感器',
  'civet-edging': '灵猫边缘传感器',
};

function formatAgo(at: number | null | undefined): string {
  if (!at) return '';
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  return `${min} 分钟前`;
}

/**
 * Read-only sensor telemetry card: the paw-prints sensor shows the most recent button/trigger
 * event, the civet-edging sensor shows a pressure reading. `kind` picks which presentation
 * to use.
 *
 * The props are plain readings plus one callback rather than a room MemberState: the same
 * card renders a member's sensor in Chat and the user's own sensor in Control, and only the
 * caller knows whether a color change travels over the room or straight to the device.
 *
 * Important: this only displays, it triggers no linkage — whether a sensor event should drive
 * someone else's device is a feature that needs its own consent/authorization UI, and this
 * version deliberately does not do it (see the matching boundary in
 * DeviceSession.attachSensor).
 */
export function SensorCard({
  kind,
  connected,
  battery,
  lastEvent,
  lastValue,
  lastEventAt,
  onPickLedColor,
}: SensorCardProps) {
  if (!kind) return null;

  const label = KIND_LABEL[kind] ?? kind;
  const isCivet = kind === 'civet-edging';

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <Radar size={15} className="text-[var(--accent)]" />
          {label}
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'bg-[var(--success)]' : 'bg-[var(--text-faint)]'}`}
          />
        </div>
        {battery != null && (
          <span className="flex items-center gap-0.5 text-xs text-[var(--text-soft)]">
            <BatteryMedium size={13} /> {battery}%
          </span>
        )}
      </div>

      {!connected ? (
        <p className="text-xs text-[var(--text-faint)]">已断开</p>
      ) : isCivet ? (
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
            {lastValue != null ? lastValue.toFixed(1) : '--'}
          </span>
          <span className="text-xs text-[var(--text-faint)]">kPa</span>
          {lastEventAt != null && (
            <span className="ml-auto text-[10px] text-[var(--text-faint)]">
              {formatAgo(lastEventAt)}
            </span>
          )}
        </div>
      ) : (
        <div>
          <p className="text-sm text-[var(--text)]">{lastEvent ?? '暂无事件'}</p>
          {lastEventAt != null && (
            <p className="text-[10px] text-[var(--text-faint)]">{formatAgo(lastEventAt)}</p>
          )}
        </div>
      )}

      {connected && (
        <LedColorPicker
          className="mt-3 border-t border-[var(--surface-border)] pt-2"
          onPick={onPickLedColor}
        />
      )}
    </div>
  );
}
