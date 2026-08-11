import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNativeBridge } from '@0xnullai/native';
import { loadDeviceSafety } from '@0xnullai/settings';
import { useSafetySession } from '@0xnullai/ui';
import { currentDeviceLease, hasDeviceLease, subscribeSafetySessions } from '@dg-kit/safety';
import { listBuiltinWaveforms } from '@dg-kit/waveforms';
import { useDevice } from '../../chat/src/hooks/use-device';
import type { DeviceClientFactory, RequestDeviceFn } from '../../chat/src/lib/bluetooth';
import { attachedDeviceSummaries, holdsAnyDevice } from '../../control/src/lib/attached-devices';
import { GameDeviceContext, resolveGamePulse, type PulseIntensity } from './use-game-device';

const GAME_WAVEFORMS = new Map(listBuiltinWaveforms().map((waveform) => [waveform.id, waveform]));

/**
 * Playground's single device owner. It reuses the same session as Control and
 * exposes it through the shell's global bar; games never talk to BLE directly.
 */
export function GameDeviceProvider({ children }: { children: React.ReactNode }) {
  const native = useNativeBridge();
  const device = useDevice({
    clientFactory: native.chat?.deviceClientFactory as DeviceClientFactory | undefined,
    requestDevice: native.chat?.requestDevice as RequestDeviceFn | undefined,
  });
  const {
    coyotes,
    sensor,
    opossum,
    connectDevice,
    disconnectCoyote,
    disconnectSensor,
    disconnectOpossum,
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

  useEffect(() => stopAll, [stopAll]);

  useSafetySession({
    id: 'playground',
    label: 'Playground',
    isActive: () => holdsAnyDevice({ coyotes, sensor, opossum }),
    stop: stopAll,
    connect: connectDevice,
    disconnect: (deviceId) => {
      if (deviceId === 'opossum') return disconnectOpossum();
      if (deviceId === 'paw-prints' || deviceId === 'civet-edging') {
        return disconnectSensor();
      }
      return disconnectCoyote(deviceId);
    },
    onRevoke: stopAll,
    devices: () => attachedDeviceSummaries({ coyotes, sensor, opossum }),
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
