import { Bluetooth, Gauge, Radar } from 'lucide-react';
import { DeviceSafetyButton } from '../../../chat/src/components/DeviceSafetyButton';
import type { OpossumSummary, SensorSummary } from '../../../chat/src/lib/bluetooth';
import type { DeviceKind } from '../../../chat/src/lib/protocol';

interface DeviceStripProps {
  connected: boolean;
  deviceName: string | null;
  battery: number | null;
  sensor: SensorSummary | null;
  opossum: OpossumSummary | null;
  limitA: number;
  limitB: number;
  onSetLimit: (channel: 'A' | 'B', value: number) => void;
  onConnectDevice: () => Promise<{ kind: DeviceKind; name: string }>;
  onDisconnectCoyote: () => void;
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
}: {
  icon: React.ReactNode;
  label: string;
  detail: string | null;
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-[var(--bg-soft)] px-2.5 py-1 text-xs text-[var(--text-soft)]">
      {icon}
      <span className="truncate">{label}</span>
      {detail && <span className="text-[10px] text-[var(--text-faint)]">{detail}</span>}
    </span>
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
  connected,
  deviceName,
  battery,
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
  const nothingAttached = !connected && !sensor?.connected && !opossum?.connected;

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
      <DeviceSafetyButton
        connected={connected}
        deviceName={deviceName}
        battery={battery}
        onDisconnect={onDisconnectCoyote}
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
        <span className="text-xs text-[var(--text-faint)]">
          还没有设备。点左边的按钮连接郊狼、传感器或负鼠。
        </span>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {connected && (
            <Chip
              icon={<Bluetooth size={12} className="text-[var(--success)]" />}
              label={deviceName ?? '郊狼'}
              detail={battery != null ? `${battery}%` : null}
            />
          )}
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
