import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import { allConnectedDevices, subscribeSafetySessions } from '@dg-kit/safety';
// The device names are @dg-kit/core's to own. This file used to keep its own
// copy, which called civet-edging 灵狐 while every other module said 灵猫 —
// the same device read differently in the top bar and in a Voice transcript.
import { DEVICE_KIND_DISPLAY_NAME } from '@dg-kit/core';
import type { DeviceSummary } from '@dg-kit/safety';
import { BatteryIcon, stopAllDevices } from '@0xnullai/ui';

/**
 * The device bar. It appears at the very top of the content area once a device is
 * connected, with the stop button at the far left.
 *
 * **Visibility keys off exactly one signal: whether any device is connected.** Not
 * the lease, not whether output is currently running. Tying it to output state
 * would mean any single state misjudgment (a missed subscription update, a lease
 * just revoked while the device is still running) makes the stop button disappear
 * at the moment it is needed most. Better to keep showing a button that may end up
 * stopping an idle device.
 *
 * Polling rather than pure event-driven updates, for the same reason:
 * `subscribeSafetySessions` only fires when a module mounts/unmounts, and changes
 * to battery, intensity or connection state do not go through it. The cost of
 * missing an update is that the user sees stale device state — and that is exactly
 * what they use to judge whether things are safe right now.
 */

const POLL_MS = 1000;

function useConnectedDevices() {
  const [groups, setGroups] = useState(() => allConnectedDevices());

  useEffect(() => {
    const refresh = () => setGroups(allConnectedDevices());
    const stop = subscribeSafetySessions(refresh);
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, []);

  return groups;
}


/** DeviceSummary.kind is a free-form string — a module may report a kind kit
 *  does not know about — so fall back to the raw value instead of blanking. */
function kindLabel(kind: string): string {
  return (DEVICE_KIND_DISPLAY_NAME as Record<string, string>)[kind] ?? kind;
}

function DeviceChip({ device }: { device: DeviceSummary }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 rounded-[var(--radius-ctl)] bg-[var(--bg-soft)] px-2.5 py-1.5">
      <span
        className={
          'h-1.5 w-1.5 shrink-0 rounded-full ' +
          (device.active ? 'bg-[var(--accent)]' : 'bg-[var(--success)]')
        }
        aria-hidden
      />
      <span className="shrink-0 text-xs font-medium">{kindLabel(device.kind)}</span>
      <span className="truncate text-xs text-[var(--text-faint)]">{device.name}</span>
      {device.channels?.map((ch) => (
        <span
          key={ch.label}
          className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-soft)]"
        >
          {ch.label}
          {ch.value}
        </span>
      ))}
      {typeof device.battery === 'number' && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-faint)]">
          <BatteryIcon level={device.battery} />
          {device.battery}%
        </span>
      )}
    </div>
  );
}

export function DeviceBar() {
  const groups = useConnectedDevices();
  const [stopping, setStopping] = useState(false);

  if (groups.length === 0) return null;

  const total = groups.reduce((n, g) => n + g.devices.length, 0);

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
      {/* Stop goes at the far left (first in reading order). It is the primary reason
          this bar exists, not an accessory feature. */}
      <button
        type="button"
        onClick={async () => {
          setStopping(true);
          try {
            await stopAllDevices();
          } finally {
            setStopping(false);
          }
        }}
        className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-[var(--danger-button)] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--danger-button-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]"
        title={`立刻停止全部输出（${total} 台设备）`}
      >
        <Square className="h-3.5 w-3.5 fill-current" />
        {stopping ? '停止中…' : '停止'}
      </button>

      <div className="flex min-w-0 items-center gap-2">
        {groups.map((g) =>
          g.devices.map((d) => <DeviceChip key={`${g.sessionId}:${d.id}`} device={d} />),
        )}
      </div>
    </div>
  );
}
