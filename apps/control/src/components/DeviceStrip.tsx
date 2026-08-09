import { useState } from 'react';
import { Bluetooth, Gauge, Radar, X } from 'lucide-react';
import { isDevicePickerCancelled } from '@dg-kit/core';
import { DeviceSafetyButton } from '../../../chat/src/components/DeviceSafetyButton';
import type {
  CoyoteSummary,
  OpossumSummary,
  SensorSummary,
} from '../../../chat/src/lib/bluetooth';
import type { DeviceKind } from '../../../chat/src/lib/protocol';

interface DeviceStripProps {
  /** Every attached Coyote host, primary first. */
  coyotes: CoyoteSummary[];
  sensor: SensorSummary | null;
  opossum: OpossumSummary | null;
  limitA: number;
  limitB: number;
  onSetLimit: (channel: 'A' | 'B', value: number) => void;
  onConnectDevice: () => Promise<{ kind: DeviceKind; name: string }>;
  /** Omitted id = every Coyote; the chips pass one so each can go on its own. */
  onDisconnectCoyote: (deviceId?: string) => void;
  onDisconnectSensor: () => void;
  onDisconnectOpossum: () => void;
  onRestoreDefaults: () => void;
}

const SENSOR_LABEL: Record<string, string> = {
  'paw-prints': '爪印传感器',
  'civet-edging': '灵猫边缘传感器',
};

function Chip({
  icon,
  label,
  detail,
  onRemove,
  removeTitle,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string | null;
  /** When given, the chip grows a per-device disconnect. */
  onRemove?: () => void;
  removeTitle?: string;
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-[var(--bg-soft)] px-2.5 py-1 text-xs text-[var(--text-soft)]">
      {icon}
      <span className="truncate">{label}</span>
      {detail && <span className="text-[10px] text-[var(--text-faint)]">{detail}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={removeTitle}
          aria-label={removeTitle}
          className="-mr-1 flex h-4 w-4 items-center justify-center rounded-full text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--danger)]"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/**
 * The empty state, which in this module is the whole product.
 *
 * It used to be a line of text pointing at the safety button — "点左边的按钮".
 * That button is a bare BluetoothOff glyph with no label, and getting to a
 * device from it takes two clicks through a popover. In Chat that is fine,
 * because the bar around it is full of other things to do; in Control there is
 * nothing else on the screen that works until something is attached, so the
 * first action gets to be a button that says what it does.
 */
function ConnectPrompt({
  onConnectDevice,
}: {
  onConnectDevice: () => Promise<{ kind: DeviceKind; name: string }>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    setConnecting(true);
    try {
      await onConnectDevice();
    } catch (err) {
      // Closing the picker is a normal action, not a failure worth reporting.
      if (!isDevicePickerCancelled(err)) {
        setError(err instanceof Error ? err.message : '连接失败');
      }
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting}
        className="flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 text-xs font-medium text-[var(--button-text)] transition-opacity duration-[var(--dur)] hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Bluetooth className="h-3.5 w-3.5" />
        {connecting ? '连接中…' : '连接设备'}
      </button>
      <span className="text-xs text-[var(--text-faint)]">
        {error ?? '郊狼主机、传感器、负鼠都从这里连。'}
      </span>
    </div>
  );
}

/**
 * Section one: what is attached, and the caps it runs under.
 *
 * The connect entry point, the per-device disconnect rows and the A/B cap
 * sliders are all DeviceSafetyButton's — the same panel Chat uses, minus the
 * multi-controller aggregation block, which it now leaves out when no
 * fire-policy callback is supplied. The chips beside it exist because in a
 * module whose whole point is "everything within thumb reach", "is my Opossum
 * still connected" should not require opening a popover to find out.
 */
export function DeviceStrip({
  coyotes,
  sensor,
  opossum,
  limitA,
  limitB,
  onSetLimit,
  onConnectDevice,
  onDisconnectCoyote,
  onDisconnectSensor,
  onDisconnectOpossum,
  onRestoreDefaults,
}: DeviceStripProps) {
  const attachedCoyotes = coyotes.filter((c) => c.connected);
  const primary = attachedCoyotes[0] ?? null;
  const nothingAttached = !primary && !sensor?.connected && !opossum?.connected;

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
      {/* The shared safety panel is still single-host: it shows the primary and
          its "断开" drops every Coyote. Per-host disconnect lives on the chips
          beside it, which is also where a user can see there is more than one. */}
      <DeviceSafetyButton
        connected={Boolean(primary)}
        deviceName={primary?.name ?? null}
        battery={primary?.battery ?? null}
        onDisconnect={() => onDisconnectCoyote()}
        limitA={limitA}
        limitB={limitB}
        onSetLimit={onSetLimit}
        onRestoreDefaults={onRestoreDefaults}
        sensor={sensor}
        opossum={opossum}
        onConnectDevice={onConnectDevice}
        onDisconnectSensor={onDisconnectSensor}
        onDisconnectOpossum={onDisconnectOpossum}
      />

      {nothingAttached ? (
        <ConnectPrompt onConnectDevice={onConnectDevice} />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {attachedCoyotes.map((coyote) => (
            <Chip
              key={coyote.id}
              icon={<Bluetooth size={12} className="text-[var(--success)]" />}
              label={coyote.name}
              detail={coyote.battery != null ? `${coyote.battery}%` : null}
              // Only offer per-chip disconnect once there is more than one:
              // with a single host the panel's own "断开" already does it, and
              // two buttons that do the same thing invite the wrong one.
              {...(attachedCoyotes.length > 1
                ? {
                    onRemove: () => onDisconnectCoyote(coyote.id),
                    removeTitle: `断开 ${coyote.name}`,
                  }
                : {})}
            />
          ))}
          {opossum?.connected && (
            <Chip
              icon={<Gauge size={12} className="text-[var(--accent)]" />}
              label="负鼠"
              detail={opossum.battery != null ? `${opossum.battery}%` : null}
            />
          )}
          {sensor?.connected && (
            <Chip
              icon={<Radar size={12} className="text-[var(--accent)]" />}
              label={SENSOR_LABEL[sensor.kind] ?? sensor.kind}
              detail={sensor.battery != null ? `${sensor.battery}%` : null}
            />
          )}
        </div>
      )}
    </section>
  );
}
