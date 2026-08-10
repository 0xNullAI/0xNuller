import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoyoteSummary } from '../../../chat/src/lib/bluetooth';

interface ActiveFire {
  deviceId: string;
  baseline: number;
}

interface MomentaryFireOptions {
  coyotes: CoyoteSummary[];
  released: boolean;
  setStrength: (channel: 'A' | 'B', value: number, deviceId?: string) => void;
}

/**
 * Local, hold-to-fire strength boost for Control.
 *
 * A fire starts only while that channel already has a running waveform. It
 * snapshots the configured strength, applies a capped boost, and restores the
 * snapshot on every normal release path. Emergency stop/disconnect callers use
 * `cancel` first so a late pointerup can never restore strength after a stop.
 */
export function useMomentaryFire({ coyotes, released, setStrength }: MomentaryFireOptions) {
  const activeRef = useRef<Record<'A' | 'B', ActiveFire | null>>({ A: null, B: null });
  const [firingDeviceIds, setFiringDeviceIds] = useState<Record<'A' | 'B', string | null>>({
    A: null,
    B: null,
  });

  const clear = useCallback(
    (channel: 'A' | 'B', restore: boolean) => {
      const active = activeRef.current[channel];
      if (!active) return;
      activeRef.current[channel] = null;
      setFiringDeviceIds((current) => ({ ...current, [channel]: null }));
      if (restore && !released) setStrength(channel, active.baseline, active.deviceId);
    },
    [released, setStrength],
  );

  const start = useCallback(
    (deviceId: string, channel: 'A' | 'B', boost: number) => {
      if (released || boost <= 0 || activeRef.current[channel]) return;
      const coyote = coyotes.find((candidate) => candidate.id === deviceId);
      if (!coyote?.connected) return;
      const waveActive = channel === 'A' ? coyote.waveActiveA : coyote.waveActiveB;
      if (!waveActive) return;
      const baseline = channel === 'A' ? coyote.strengthA : coyote.strengthB;
      const limit = channel === 'A' ? coyote.limitA : coyote.limitB;
      const target = Math.min(limit, baseline + boost);
      if (target === baseline) return;

      activeRef.current[channel] = { deviceId, baseline };
      setFiringDeviceIds((current) => ({ ...current, [channel]: deviceId }));
      setStrength(channel, target, deviceId);
    },
    [coyotes, released, setStrength],
  );

  const stop = useCallback((channel: 'A' | 'B') => clear(channel, true), [clear]);

  const cancel = useCallback(
    (deviceId?: string) => {
      for (const channel of ['A', 'B'] as const) {
        const active = activeRef.current[channel];
        if (active && (deviceId == null || active.deviceId === deviceId)) clear(channel, false);
      }
    },
    [clear],
  );

  // A disconnect or an externally stopped waveform invalidates the held fire.
  // Clear without restoring: the device may already have been emergency-stopped.
  useEffect(() => {
    for (const channel of ['A', 'B'] as const) {
      const active = activeRef.current[channel];
      if (!active) continue;
      const coyote = coyotes.find((candidate) => candidate.id === active.deviceId);
      const waveActive = channel === 'A' ? coyote?.waveActiveA : coyote?.waveActiveB;
      if (!coyote?.connected || !waveActive || released) clear(channel, false);
    }
  }, [clear, coyotes, released]);

  return { start, stop, cancel, firingDeviceIds };
}
