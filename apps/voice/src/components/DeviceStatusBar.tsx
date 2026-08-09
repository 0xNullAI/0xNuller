import { Vibrate, Zap } from 'lucide-react';
import { ChannelStrengthBar, DeviceStatusChip, DeviceStatusRow } from '@0xnullai/ui';
import type { DeviceSessionState } from '@voice/lib/device-session';
import type { CoyoteSafetySettings, OpossumSafetySettings } from '@voice/lib/settings';

/**
 * Device status bar. The display internals (battery buckets / strength-bar
 * scale / chip interaction) come from @0xnullai/ui — before the merge they
 * lived here and in Agent's ChatPanel as two verbatim copies. This file only
 * arranges the two device types Voice supports (郊狼 + 负鼠).
 *
 * Renders nothing when neither is connected, matching Agent's behaviour: the
 * call to action in that state is the 「连接设备」 button that always sits in
 * the top bar, not an empty status row.
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
    <DeviceStatusRow>
      {state.coyote.connected && (
        <DeviceStatusChip
          icon={<Zap className="h-3.5 w-3.5 text-[var(--success)]" />}
          battery={state.coyote.battery}
          onClick={onDisconnectCoyote}
          title="断开郊狼"
        >
          <div className="flex gap-3 sm:gap-4">
            <ChannelStrengthBar
              channel="A"
              value={state.coyote.strengthA}
              max={Math.min(state.coyote.limitA, coyoteSafety.maxStrengthA)}
            />
            <ChannelStrengthBar
              channel="B"
              value={state.coyote.strengthB}
              max={Math.min(state.coyote.limitB, coyoteSafety.maxStrengthB)}
            />
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
            <ChannelStrengthBar
              channel="A"
              value={state.opossum.intensityA}
              max={opossumSafety.maxIntensityA}
            />
            <ChannelStrengthBar
              channel="B"
              value={state.opossum.intensityB}
              max={opossumSafety.maxIntensityB}
            />
          </div>
        </DeviceStatusChip>
      )}
    </DeviceStatusRow>
  );
}
