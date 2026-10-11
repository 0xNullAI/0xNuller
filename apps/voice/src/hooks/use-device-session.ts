import { useCallback, useEffect, useState } from 'react';
import { createEmptyDeviceState, isDevicePickerCancelled } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import {
  DeviceSession,
  type AnyDeviceSessionTransport,
  type DeviceSessionState,
} from '@voice/lib/device-session';

const EMPTY_STATE: DeviceSessionState = {
  coyotes: [],
  coyote: createEmptyDeviceState(),
  opossum: createEmptyOpossumState(),
};

/**
 * `transport` is normally the shared DG-Lab registry handle (`createRegistryTransport`). A legacy
 * own-link transport is only the fallback; omitting it builds the Web Bluetooth default.
 */
export function useDeviceSession(transport?: AnyDeviceSessionTransport) {
  // Lazy `useState` initializer (not a ref) — it runs exactly once and is
  // the pattern the stricter react-hooks/refs rule actually wants for
  // "construct once, keep stable across re-renders" values. `transport` is
  // read once at construction; changing it later has no effect by design.
  const [session] = useState(() => new DeviceSession(transport));

  const [state, setState] = useState<DeviceSessionState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  // In-flight flag for the connect flow. On Android `connectDevice()` runs an
  // ~8s BLE scan before the picker resolves; without visible feedback the
  // button looks dead ("nothing happens when you tap it"). Also guards against a second tap kicking
  // off a concurrent scan.
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    void session.getState().then(setState);
  }, [session]);

  useEffect(() => {
    refresh();
    return session.onChanged(refresh);
  }, [session, refresh]);

  const connectDevice = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      await session.connectDevice();
      refresh();
    } catch (err) {
      // Through the shared predicate: the local regex only knew the English
      // Web Bluetooth wording, so on Android — where the Tauri transport
      // throws a Chinese message — backing out of the picker raised an error
      // banner.
      if (!isDevicePickerCancelled(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setConnecting(false);
    }
  }, [session, refresh]);

  const emergencyStop = useCallback(async () => {
    await session.emergencyStop();
    refresh();
  }, [session, refresh]);

  const disconnectCoyote = useCallback(
    async (targetId?: string) => {
      await session.disconnectCoyote(targetId);
      refresh();
    },
    [session, refresh],
  );

  const disconnectOpossum = useCallback(async () => {
    await session.disconnectOpossum();
    refresh();
  }, [session, refresh]);

  /** Lease loss from the shared registry; output is already stopped when it fires. */
  const onRevoked = useCallback(
    (listener: () => void) =>
      session.onRevoked(() => {
        listener();
        refresh();
      }),
    [session, refresh],
  );

  return {
    session,
    onRevoked,
    state,
    error,
    connecting,
    connectDevice,
    emergencyStop,
    disconnectCoyote,
    disconnectOpossum,
  };
}
