import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, Vibrate, Zap } from 'lucide-react';
import { Meter } from '@0xnullai/ui';
import type { DeviceSessionState } from '@voice/lib/device-session';
import type { CoyoteSafetySettings, OpossumSafetySettings } from '@voice/lib/settings';

const DEVICE_STRENGTH_CAP = 200;

/**
 * Ported from DG-Agent's ChatPanel device status bar (`DeviceStatusChip` /
 * `ChannelStrengthBar` / `BatteryIcon`) — same live-strength-meter pattern,
 * narrowed to the two device kinds DG-Voice actually supports. Renders
 * nothing when neither device is connected, matching DG-Agent's behavior
 * (the persistent "连接设备" button in the header is the call to action for
 * that state, not an empty status bar).
 */
interface DeviceStatusBarProps {
  state: DeviceSessionState;
  coyoteSafety: CoyoteSafetySettings;
  opossumSafety: OpossumSafetySettings;
  onDisconnectCoyote: () => void;
  onDisconnectOpossum: () => void;
}

export function DeviceStatusBar({
  state,
  coyoteSafety,
  opossumSafety,
  onDisconnectCoyote,
  onDisconnectOpossum,
}: DeviceStatusBarProps) {
  if (!state.coyote.connected && !state.opossum.connected) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 sm:px-4">
      {state.coyote.connected && (
        <DeviceStatusChip
          icon={<Zap className="h-3.5 w-3.5 text-[var(--success)]" />}
          battery={state.coyote.battery}
          onClick={onDisconnectCoyote}
          title="断开郊狼"
        >
          <div className="flex gap-3 sm:gap-4">
            <ChannelStrengthBar channel="A" value={state.coyote.strengthA} max={Math.min(state.coyote.limitA, coyoteSafety.maxStrengthA)} />
            <ChannelStrengthBar channel="B" value={state.coyote.strengthB} max={Math.min(state.coyote.limitB, coyoteSafety.maxStrengthB)} />
          </div>
        </DeviceStatusChip>
      )}

      {state.opossum.connected && (
        <DeviceStatusChip
          icon={<Vibrate className="h-3.5 w-3.5 text-[var(--success)]" />}
          battery={state.opossum.battery}
          onClick={onDisconnectOpossum}
          title="断开负鼠"
        >
          <div className="flex gap-3 sm:gap-4">
            <ChannelStrengthBar channel="A" value={state.opossum.intensityA} max={opossumSafety.maxIntensityA} />
            <ChannelStrengthBar channel="B" value={state.opossum.intensityB} max={opossumSafety.maxIntensityB} />
          </div>
        </DeviceStatusChip>
      )}
    </div>
  );
}

function BatteryIcon({ level }: { level: number | null | undefined }) {
  if (level == null) return <Battery className="h-3.5 w-3.5 text-[var(--text-faint)]" />;
  if (level <= 10) return <BatteryWarning className="h-3.5 w-3.5 text-[var(--danger)]" />;
  if (level <= 30) return <BatteryLow className="h-3.5 w-3.5 text-[var(--warning)]" />;
  if (level <= 70) return <BatteryMedium className="h-3.5 w-3.5 text-[var(--text-soft)]" />;
  return <BatteryFull className="h-3.5 w-3.5 text-[var(--success)]" />;
}

interface DeviceStatusChipProps {
  icon: React.ReactNode;
  battery: number | null | undefined;
  onClick: () => void;
  title: string;
  children?: React.ReactNode;
}

function DeviceStatusChip({ icon, battery, onClick, title, children }: DeviceStatusChipProps) {
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

interface ChannelStrengthBarProps {
  channel: 'A' | 'B';
  value: number;
  max: number;
}

function ChannelStrengthBar({ channel, value, max }: ChannelStrengthBarProps) {
  const normalizedValue = clampPercentage((value / DEVICE_STRENGTH_CAP) * 100);
  const normalizedMax = clampPercentage((max / DEVICE_STRENGTH_CAP) * 100);

  return (
    <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 sm:gap-1.5">
      <span className="text-[10px] font-semibold leading-none tracking-wide text-[var(--accent)]">{channel}</span>
      <Meter value={normalizedValue} marker={normalizedMax} className="w-16 sm:w-20" />
      <span className="text-[10px] font-medium tabular-nums leading-none text-[var(--text-soft)]">{value}</span>
    </div>
  );
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
