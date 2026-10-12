import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useDgLabRegistry } from '@0xnullai/native';
import { loadDeviceSafety } from '@0xnullai/settings';
import { useSafetySession } from '@0xnullai/ui';
import { currentDeviceLease, hasDeviceLease, subscribeSafetySessions } from '@dg-kit/safety';
import { listBuiltinWaveforms } from '@dg-kit/waveforms';
import { holdsAnyDevice, useDevice } from '@0xnullai/device-runtime';
import { GameDeviceContext, resolveGamePulse, type PulseIntensity } from './use-game-device';

const GAME_WAVEFORMS = new Map(listBuiltinWaveforms().map((waveform) => [waveform.id, waveform]));

/**
 * Playground's device access for games. It borrows the app's one DG-Lab
 * registry — the same devices and ids Control sees — through a view fenced to
 * the `playground` lease; games never talk to BLE directly.
 */
export function GameDeviceProvider({ children }: { children: React.ReactNode }) {
  const device = useDevice({ moduleId: 'playground', registry: useDgLabRegistry() });
  const {
    coyotes,
    sensor,
    opossum,
    connectDevice,
    setWave,
    setStrength,
    stopAll: stopDeviceOutputs,
    opossumBurst,
  } = device;
  const pulseTimer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (pulseTimer.current === null) return;
    window.clearTimeout(pulseTimer.current);
    pulseTimer.current = null;
  }, []);

  const stopAll = useCallback(() => {
    clearTimer();
    stopDeviceOutputs();
  }, [clearTimer, stopDeviceOutputs]);

  // The devices are shared with every module now, so unmounting stops output only while a game
  // could have started it (Playground holds the lease); otherwise it would zero Control's output.
  useEffect(
    () => () => {
      clearTimer();
      if (hasDeviceLease('playground')) stopDeviceOutputs();
    },
    [clearTimer, stopDeviceOutputs],
  );

  // Stop, revoke and the shell's connect entry only. The registry's own
  // `dglab-devices` session lists and disconnects the devices; listing them
  // here too would show each one twice in the device bar.
  useSafetySession({
    id: 'playground',
    label: 'Playground',
    isActive: () => holdsAnyDevice({ coyotes, sensor, opossum }),
    stop: stopAll,
    connect: connectDevice,
    // The registry already stopped every output on the lease switch. Drop only the game's own
    // pulse timer; a device stop here would bypass the fence and zero the new holder's output.
    onRevoke: clearTimer,
  });

  const holdsLease = useSyncExternalStore(
    subscribeSafetySessions,
    () => currentDeviceLease() === 'playground',
    () => false,
  );
  const coyote = coyotes.find((candidate) => candidate.connected) ?? null;
  const opossumConnected = Boolean(opossum?.connected);
  const connected = Boolean(coyote || opossumConnected);

  const pulse = useCallback(
    (intensity: PulseIntensity) => {
      if (!hasDeviceLease('playground')) return;

      const targetCoyote = coyotes.find((candidate) => candidate.connected) ?? null;
      const targetOpossum = Boolean(opossum?.connected);
      if (!targetCoyote && !targetOpossum) return;

      const request = resolveGamePulse(intensity, loadDeviceSafety());
      if (request.durationMs === 0) return;
      const useCoyote = Boolean(targetCoyote && request.coyoteStrength > 0);
      const useOpossum = !useCoyote && targetOpossum && request.opossumIntensity > 0;
      if (!useCoyote && !useOpossum) return;

      // A new game event replaces the previous one. The emergency path also
      // invalidates any writes still queued for that older event.
      stopAll();

      if (useCoyote && targetCoyote) {
        const waveform = GAME_WAVEFORMS.get(request.waveformId);
        if (waveform) {
          setWave('A', waveform.frames, waveform.id, true, targetCoyote.id);
          setStrength('A', request.coyoteStrength, targetCoyote.id);
        }
      } else if (useOpossum) {
        opossumBurst('A', request.opossumIntensity, request.durationMs);
      }

      pulseTimer.current = window.setTimeout(stopAll, request.durationMs);
    },
    [coyotes, opossum, opossumBurst, setStrength, setWave, stopAll],
  );

  const value = useMemo(() => ({ connected, holdsLease, pulse }), [connected, holdsLease, pulse]);

  return <GameDeviceContext.Provider value={value}>{children}</GameDeviceContext.Provider>;
}
