import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import type { DeviceKind, DeviceLinkRule } from '@dg-kit/core';
import { DeviceLifecycleGuard } from '@dg-kit/safety';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { DgLabConnectionRegistry } from './dglab/dglab-connection-registry.js';
import {
  DeviceSession,
  type CoyoteSummary,
  type WaveFrame,
  type DeviceInfo,
  type SensorSummary,
  type OpossumSummary,
} from './device-session.js';

/**
 * Field-by-field comparison of two host lists, so an unchanged tick can reuse
 * the previous array reference (see the call site in `syncState`).
 *
 * Explicit rather than a generic deep-equal: every field here is one the UI
 * renders, so adding a field to `CoyoteSummary` without adding it here would
 * show up as a reading that visibly stops updating — which for strength is a
 * display that lies about what the device is doing.
 */
function sameCoyotes(a: CoyoteSummary[], b: CoyoteSummary[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.name === y.name &&
      x.version === y.version &&
      x.connected === y.connected &&
      x.battery === y.battery &&
      x.strengthA === y.strengthA &&
      x.strengthB === y.strengthB &&
      x.limitA === y.limitA &&
      x.limitB === y.limitB &&
      x.waveActiveA === y.waveActiveA &&
      x.waveActiveB === y.waveActiveB &&
      x.waveIdA === y.waveIdA &&
      x.waveIdB === y.waveIdB
    );
  });
}

export interface UseDeviceOptions {
  /**
   * The lease id this module holds while it is the visible module (`control`, `playground`,
   * `chat`). Every start, raise and LED write is fenced against it in the registry.
   */
  moduleId: string;
  /**
   * The app's one DG-Lab registry (the shell's `NativeBridge.dglab`). Every module that passes
   * the same registry sees the same devices with the same ids; none opens its own BLE link.
   */
  registry: DgLabConnectionRegistry;
}

/**
 * DG-Lab device control hook for one module.
 *
 * Reads the shared devices from the registry and mirrors them into React state. Writes go
 * through this module's registry handle. Unmounting or losing the lease never disconnects:
 * the links belong to the app, not to the module.
 *
 * The scalar surface (`connected`, `strengthA`, `setStrength`, ...) describes the *primary*
 * Coyote — the first connected one. `coyotes` is the full list, and every command takes an
 * optional trailing `deviceId` to target one host.
 */
export function useDevice({ moduleId, registry }: UseDeviceOptions) {
  const handle = useMemo(() => registry.forModule(moduleId), [registry, moduleId]);
  const session = useMemo(() => {
    const safety = loadDeviceSafety();
    return new DeviceSession(handle, {
      strengthA: safety.maxStrengthA,
      strengthB: safety.maxStrengthB,
      intensityA: safety.maxIntensityA,
      intensityB: safety.maxIntensityB,
    });
  }, [handle]);

  const [connected, setConnected] = useState(false);
  const [coyotes, setCoyotes] = useState<CoyoteSummary[]>([]);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [strengthA, setStrengthA] = useState(0);
  const [strengthB, setStrengthB] = useState(0);
  const [battery, setBattery] = useState<number | null>(null);
  const [waveActiveA, setWaveActiveA] = useState(false);
  const [waveActiveB, setWaveActiveB] = useState(false);
  const [waveIdA, setWaveIdA] = useState<string | null>(null);
  const [waveIdB, setWaveIdB] = useState<string | null>(null);
  // Seeded from the shared device-safety settings, not a local 50: lowering the cap in the
  // unified settings must show up in every module that claims to follow it.
  const [limitA, setLimitA] = useState(() => loadDeviceSafety().maxStrengthA);
  const [limitB, setLimitB] = useState(() => loadDeviceSafety().maxStrengthB);
  const [sensor, setSensor] = useState<SensorSummary | null>(null);
  const [opossum, setOpossum] = useState<OpossumSummary | null>(null);
  const [deviceLink, setDeviceLinkState] = useState<DeviceLinkRule | null>(null);
  const [firePolicy, setFirePolicyState] = useState<'sum' | 'max' | 'avg'>(
    () => (localStorage.getItem('dg-fire-policy') as 'sum' | 'max' | 'avg' | null) ?? 'max',
  );
  const firePolicyRef = useRef(firePolicy);
  firePolicyRef.current = firePolicy;

  /** Mirror the module view into React state. */
  const syncState = useCallback(() => {
    const nextCoyotes = session.getCoyoteSummaries();
    const primary = nextCoyotes[0] ?? null;
    const caps = loadDeviceSafety();
    setConnected(primary?.connected ?? false);
    setStrengthA(primary?.strengthA ?? 0);
    setStrengthB(primary?.strengthB ?? 0);
    setBattery(primary ? (primary.battery ?? 0) : null);
    setWaveActiveA(primary?.waveActiveA ?? false);
    setWaveActiveB(primary?.waveActiveB ?? false);
    setWaveIdA(primary?.waveIdA ?? null);
    setWaveIdB(primary?.waveIdB ?? null);
    setLimitA(primary?.limitA ?? caps.maxStrengthA);
    setLimitB(primary?.limitB ?? caps.maxStrengthB);
    // Keep deviceInfo on the same host as every other scalar.
    setDeviceInfo(
      primary
        ? { version: primary.version, name: primary.name, battery: primary.battery ?? 0 }
        : null,
    );
    // The registry emits on every protocol tick while a device is attached. Reuse the previous
    // array when nothing changed so the module tree does not re-render ten times a second.
    setCoyotes((prev) => (sameCoyotes(prev, nextCoyotes) ? prev : nextCoyotes));
    setSensor(session.getSensorSummary());
    setOpossum(session.getOpossumSummary());
    setDeviceLinkState(session.getDeviceLinkRule());
  }, [session]);

  useEffect(() => {
    const offState = session.subscribe(syncState);
    const stop = session.start();
    syncState();
    return () => {
      offState();
      stop();
    };
  }, [session, syncState]);

  /**
   * The one shared picker for all four DG-Lab kinds. A device another module already attached
   * is reused, not opened a second time.
   */
  const connectDevice = useCallback(async (): Promise<{ kind: DeviceKind; name: string }> => {
    const result = await session.connectDevice();
    syncState();
    return result;
  }, [session, syncState]);

  /**
   * Stop every output and forget this module's held targets, e.g. when leaving a Chat room.
   * The links stay up: they are shared with every other module, and dropping one here would
   * pull a device out from under Control.
   */
  const release = useCallback(() => {
    session.stopAllOutputs();
    syncState();
  }, [session, syncState]);

  /**
   * Disconnect Coyote hosts (keep the sensor / Opossum). `deviceId` targets one host; omitting
   * it disconnects every Coyote. The registry stops each one before it drops the link.
   */
  const disconnectCoyote = useCallback(
    (deviceId?: string) => {
      // Anything that is not a string means "all hosts". Wired straight to onClick, React hands
      // this a MouseEvent, which as a device id would match nothing and disconnect nothing.
      const id = typeof deviceId === 'string' ? deviceId : undefined;
      return session.disconnectCoyote(id).catch(() => undefined);
    },
    [session],
  );

  /** Disconnect the sensor (keep the Coyote / Opossum). */
  const disconnectSensor = useCallback(
    () => session.disconnectSensor().catch(() => undefined),
    [session],
  );

  /** Disconnect the Opossum (keep the Coyote / sensor). */
  const disconnectOpossum = useCallback(
    () => session.disconnectOpossum().catch(() => undefined),
    [session],
  );

  /** Set the strength of the given channel. `deviceId` omitted = the primary host. */
  const setStrength = useCallback(
    (channel: 'A' | 'B', value: number, deviceId?: string) => {
      session.coyoteById(deviceId)?.setStrength(channel, value);
    },
    [session],
  );

  /** Set the waveform of the given channel. `deviceId` omitted = the primary host. */
  const setWave = useCallback(
    (
      channel: 'A' | 'B',
      frames: WaveFrame[],
      waveformId: string,
      loop?: boolean,
      deviceId?: string,
    ) => {
      session.coyoteById(deviceId)?.setWave(channel, frames, waveformId, loop);
    },
    [session],
  );

  /** Stop the waveform on the given channel. `deviceId` omitted = the primary host. */
  const stopWave = useCallback(
    (channel: 'A' | 'B', deviceId?: string) => {
      session.coyoteById(deviceId)?.stopWave(channel);
    },
    [session],
  );

  /**
   * Set a channel's software cap. With no `deviceId` it applies to every host, including hosts
   * attached later — a lowered cap must not quietly miss the second device.
   */
  const setLimit = useCallback(
    (channel: 'A' | 'B', value: number, deviceId?: string) => {
      if (deviceId) session.coyoteById(deviceId)?.setLimit(channel, value);
      else session.setCoyoteLimit(channel, value);
      syncState();
    },
    [session, syncState],
  );

  /**
   * Emergency stop: every Coyote and Opossum in the app.
   *
   * Deliberately takes NO arguments. It is wired straight to onClick, and an optional
   * `deviceId` would let React pass a MouseEvent as the target, which stops nothing.
   */
  const stopAll = useCallback(() => {
    session.stopAllOutputs();
  }, [session]);

  /** Zero one Coyote host. Not the emergency stop, which is `stopAll` above. */
  const stopCoyote = useCallback(
    (deviceId: string) => {
      session.coyoteById(deviceId)?.stopAll();
    },
    [session],
  );

  /** Set an Opossum channel's intensity, capped by the Opossum's own shared-settings limit. */
  const setOpossumIntensity = useCallback(
    (channel: 'A' | 'B', value: number) => {
      const safety = loadDeviceSafety();
      const limit = channel === 'A' ? safety.maxIntensityA : safety.maxIntensityB;
      session.setOpossumIntensity(channel, value, limit);
    },
    [session],
  );

  /** One-tap Opossum burst: spike to the target strength briefly, then fall back. */
  const opossumBurst = useCallback(
    (channel: 'A' | 'B', strength: number, durationMs = 500) => {
      const safety = loadDeviceSafety();
      const limit = channel === 'A' ? safety.maxIntensityA : safety.maxIntensityB;
      session.opossumBurst(channel, strength, durationMs, limit);
    },
    [session],
  );

  /** Stop one or both Opossum channels. */
  const opossumStop = useCallback(
    (channel?: 'A' | 'B') => {
      session.opossumStop(channel);
    },
    [session],
  );

  /** Select a shared waveform for one Opossum channel. */
  const setOpossumWaveform = useCallback(
    (channel: 'A' | 'B', frames: WaveFrame[], waveformId: string) => {
      session.setOpossumWaveform(channel, frames, waveformId);
    },
    [session],
  );

  const setOpossumPattern = useCallback(
    (channel: 'A' | 'B', pattern: 'constant' | 'pulse' | 'wave' | 'ramp' | 'heartbeat') => {
      session.setOpossumPattern(channel, pattern);
    },
    [session],
  );

  const setDeviceLink = useCallback(
    (rule: DeviceLinkRule) => {
      session.setDeviceLinkRule(rule);
      setDeviceLinkState(session.getDeviceLinkRule());
    },
    [session],
  );

  /** Set the LED color of the sensor or the Opossum (discrete 0-7 enum, see LedColorPicker). */
  const setLedColor = useCallback(
    (target: 'sensor' | 'opossum', color: number) => {
      session.setLedColor(target, color);
    },
    [session],
  );

  /**
   * Run `listener` when this module loses the lease, right after the registry stopped every
   * output. For module state the registry cannot see, such as Chat's held fire boosts.
   */
  const onRevoked = useCallback((listener: () => void) => handle.onRevoked(listener), [handle]);

  /** Set the multi-user fire aggregation policy */
  const setFirePolicy = useCallback((p: 'sum' | 'max' | 'avg') => {
    setFirePolicyState(p);
    localStorage.setItem('dg-fire-policy', p);
  }, []);

  // Follow the shared caps live: a lowered cap must take effect in an open module, not only
  // after a reconnect. The registry re-clamps every write against the same settings as well.
  useEffect(() => {
    const apply = () => {
      const safety = loadDeviceSafety();
      session.setCoyoteLimit('A', safety.maxStrengthA);
      session.setCoyoteLimit('B', safety.maxStrengthB);
      session.setOpossumLimits(safety.maxIntensityA, safety.maxIntensityB);
      syncState();
    };
    apply();
    return subscribeDeviceSafety(apply);
  }, [session, syncState]);

  // Browser-level background (tab switch, screen lock) stops output if the setting says so.
  // Switching modules does not come through here; the lease revoke covers that path.
  useEffect(() => {
    const guard = new DeviceLifecycleGuard({
      onStop: () => {
        session.stopAllOutputs();
        syncState();
      },
    });
    return guard.start();
  }, [session, syncState]);

  return {
    moduleId,
    connected,
    /**
     * Every attached Coyote host, primary first. The scalars above describe
     * `coyotes[0]`; this is the only place the other hosts are visible.
     */
    coyotes,
    deviceInfo,
    strengthA,
    strengthB,
    battery,
    waveActiveA,
    waveActiveB,
    waveIdA,
    waveIdB,
    release,
    disconnectCoyote,
    setStrength,
    setWave,
    stopWave,
    stopAll,
    stopCoyote,
    limitA,
    limitB,
    setLimit,
    firePolicy,
    firePolicyRef,
    setFirePolicy,
    // —— Multi-device (sensor / opossum) ——
    sensor,
    opossum,
    connectDevice,
    disconnectSensor,
    disconnectOpossum,
    setOpossumIntensity,
    opossumBurst,
    opossumStop,
    setOpossumWaveform,
    setOpossumPattern,
    deviceLink,
    setDeviceLink,
    setLedColor,
    onRevoked,
  };
}
