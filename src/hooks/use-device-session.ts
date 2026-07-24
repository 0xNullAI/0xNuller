import { useCallback, useEffect, useState } from 'react';
import { createEmptyDeviceState } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { DeviceSession, type DeviceSessionState } from '@/lib/device-session';

const EMPTY_STATE: DeviceSessionState = {
  coyote: createEmptyDeviceState(),
  opossum: createEmptyOpossumState(),
};

export function useDeviceSession() {
  // Lazy `useState` initializer (not a ref) — it runs exactly once and is
  // the pattern the stricter react-hooks/refs rule actually wants for
  // "construct once, keep stable across re-renders" values.
  const [session] = useState(() => new DeviceSession());

  const [state, setState] = useState<DeviceSessionState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void session.getState().then(setState);
  }, [session]);

  useEffect(() => {
    refresh();
    return session.onChanged(refresh);
  }, [session, refresh]);

  const connectDevice = useCallback(async () => {
    setError(null);
    try {
      await session.connectDevice();
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A cancelled Web Bluetooth chooser is a normal user action, not an error.
      if (!/cancelled|user gesture/i.test(message)) {
        setError(message);
      }
    }
  }, [session, refresh]);

  const emergencyStop = useCallback(async () => {
    await session.emergencyStop();
    refresh();
  }, [session, refresh]);

  const disconnectCoyote = useCallback(async () => {
    await session.disconnectCoyote();
    refresh();
  }, [session, refresh]);

  const disconnectOpossum = useCallback(async () => {
    await session.disconnectOpossum();
    refresh();
  }, [session, refresh]);

  return { session, state, error, connectDevice, emergencyStop, disconnectCoyote, disconnectOpossum };
}
