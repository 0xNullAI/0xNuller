import { useCallback, useSyncExternalStore } from 'react';
import { allConnectedDevices, currentDeviceLease, subscribeSafetySessions } from '@dg-kit/safety';

/**
 * The seam between a game and the device.
 *
 * Games express intent — "a light pulse", "a stronger one" — and never a
 * number. The strength a game asks for is a request; what actually reaches
 * the body is decided by the device holder's safety caps, and no game may be
 * a way around them.
 *
 * Playground does not own a Bluetooth connection yet: it has no picker and
 * holds no device client. `pulse` is therefore a no-op today, and `connected`
 * says so plainly rather than pretending. That is deliberate — a game that
 * looks like it is driving a device while it is not is worse than one that
 * admits it isn't, and this is the file that gets wired up when Playground
 * grows a real device path (through the same lease + policy engine + command
 * queue every other module uses, never around them).
 */

export type PulseIntensity = 'light' | 'strong';

export function useGameDevice() {
  const connected = useSyncExternalStore(
    subscribeSafetySessions,
    () => allConnectedDevices().length > 0,
    () => false,
  );

  const pulse = useCallback((intensity: PulseIntensity) => {
    // No device path yet — see the note above. Kept as a named call so the
    // games already describe what they want, and wiring it later touches
    // this function only.
    void intensity;
  }, []);

  return { pulse, connected, holdsLease: currentDeviceLease() === 'playground' };
}
