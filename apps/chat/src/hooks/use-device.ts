import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import type { DeviceLinkRule } from '@dg-kit/core';
import { DeviceLifecycleGuard } from '@dg-kit/safety';
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  DeviceSession,
  type CoyoteSummary,
  type DeviceClientFactory,
  type RequestDeviceFn,
  type WaveFrame,
  type DeviceInfo,
  type SensorSummary,
  type OpossumSummary,
} from '../lib/bluetooth';
import type { DeviceKind } from '../lib/protocol';

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
  /** Override the underlying DeviceClient transport. Used by the Tauri shell. */
  clientFactory?: DeviceClientFactory;
  /**
   * Override `DeviceSession.connectDevice()`'s device-picking step. Defaults
   * to a single Web Bluetooth chooser scoped to all 4 DG-Lab device kinds.
   * The Tauri Android shell passes `requestDgLabDeviceTauri()` instead —
   * same one-chooser, auto-detected-kind experience over plugin-blec.
   */
  requestDevice?: RequestDeviceFn;
}

/**
 * DG-Lab device control hook.
 * Wraps the DeviceSession class (Coyote + optional sensor + optional Opossum)
 * and mirrors its state into React state.
 *
 * Existing field names/semantics are unchanged (connected/deviceInfo/strengthA/
 * .../setStrength/... all still describe the Coyote only); every new field is
 * purely additive: the sensor/opossum state defaults to null/false, so no
 * existing consumer is affected.
 *
 * Several Coyote hosts may be attached at once. The scalar surface above keeps
 * describing exactly one of them — the *primary* (the first connected host) —
 * so consumers written before multi-device keep working unchanged; `coyotes`
 * is the full list, and every command takes an optional trailing `deviceId` to
 * target one host. Omitting it means the primary, which is what those older
 * consumers already meant.
 */
export function useDevice(options: UseDeviceOptions = {}) {
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
  // Seeded from the shared device-safety settings, not a local 50. Lowering
  // the cap to 30 in the unified settings used to leave Chat still running at
  // 50 — a safety control that visibly did nothing in one of the modules it
  // claimed to govern.
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
  const sessionRef = useRef<DeviceSession | null>(null);

  /** Sync state from the device instance into React state */
  const syncState = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const s = session.coyote.getState();
    setConnected(s.connected);
    setStrengthA(s.strengthA);
    setStrengthB(s.strengthB);
    setBattery(s.battery);
    setWaveActiveA(s.waveActiveA);
    setWaveActiveB(s.waveActiveB);
    setWaveIdA(s.waveIdA);
    setWaveIdB(s.waveIdB);
    setLimitA(s.limitA);
    setLimitB(s.limitB);
    const nextCoyotes = session.getCoyoteSummaries();
    const primary = nextCoyotes[0] ?? null;
    // Every scalar in this hook describes the primary host. Keep deviceInfo
    // on the same host too: setting it from the most recently attached Coyote
    // made the name/battery say device #2 while the strength controls still
    // drove device #1.
    setDeviceInfo(
      primary
        ? { version: primary.version, name: primary.name, battery: primary.battery ?? 0 }
        : null,
    );
    // Keep the previous array when nothing actually changed. The protocol
    // emits on every tick (100ms) while a device is connected, and syncState
    // runs on each one; the scalar setters above bail out of re-rendering when
    // their value is unchanged, but a freshly-built array never compares equal
    // and would re-render the whole module tree ten times a second for as long
    // as a device is attached.
    setCoyotes((prev) => {
      return sameCoyotes(prev, nextCoyotes) ? prev : nextCoyotes;
    });
    setSensor(session.getSensorSummary());
    setOpossum(session.getOpossumSummary());
    setDeviceLinkState(session.getDeviceLinkRule());
  }, []);

  // The factory is intended to be stable across the hook's lifetime:
  // either omitted (web) or set once by the Tauri shell. Capturing once at
  // first render keeps useCallback's identity stable and avoids the
  // `Cannot update ref during render` lint that fires when a ref is
  // assigned in the render body.
  const clientFactoryRef = useRef(options.clientFactory);
  const requestDeviceRef = useRef(options.requestDevice);

  /** Ensure the session exists (created lazily — only needed on the first connectDevice). */
  const ensureSession = useCallback((): DeviceSession => {
    if (!sessionRef.current) {
      const safety = loadDeviceSafety();
      const session = new DeviceSession(clientFactoryRef.current, requestDeviceRef.current, {
        strengthA: safety.maxStrengthA,
        strengthB: safety.maxStrengthB,
        intensityA: safety.maxIntensityA,
        intensityB: safety.maxIntensityB,
      });
      session.setOnStateChange(syncState);
      sessionRef.current = session;
    }
    return sessionRef.current;
  }, [syncState]);

  /**
   * Unified connect entry point: opens one device chooser covering all 4
   * DG-Lab device kinds (Coyote / paw-prints sensor / civet-edging sensor /
   * Opossum), identifies the kind by name prefix and attaches it to the
   * matching slot — a Coyote is routed inside DeviceSession.connectDevice() to
   * coyote.connectViaChosenDevice(), the other three go to
   * attachSensor/attachOpossum. Tap it again to add another device. On web
   * this is the Web Bluetooth chooser; on Tauri Android it is a plugin-blec
   * scan + device picker (see UseDeviceOptions.requestDevice).
   */
  const connectDevice = useCallback(async (): Promise<{ kind: DeviceKind; name: string }> => {
    const session = ensureSession();
    const { coyoteInfo: _coyoteInfo, ...result } = await session.connectDevice();
    syncState();
    return result;
  }, [ensureSession, syncState]);

  /**
   * Tear down the whole session (Coyote + sensor + Opossum). Used by the
   * "断开" button and when leaving the room.
   */
  const disconnect = useCallback(() => {
    sessionRef.current?.disconnectAll();
    sessionRef.current = null;
    setConnected(false);
    setCoyotes([]);
    setDeviceInfo(null);
    setBattery(null);
    setStrengthA(0);
    setStrengthB(0);
    setWaveActiveA(false);
    setWaveActiveB(false);
    setWaveIdA(null);
    setWaveIdB(null);
    setLimitA(loadDeviceSafety().maxStrengthA);
    setLimitB(loadDeviceSafety().maxStrengthB);
    setSensor(null);
    setOpossum(null);
  }, []);

  /**
   * Disconnect Coyote hosts (keep the sensor / Opossum).
   *
   * `deviceId` targets one host; omitting it disconnects every attached
   * Coyote — see `DeviceSession.disconnectCoyote`.
   */
  const disconnectCoyote = useCallback(
    (deviceId?: string) => {
      // Anything that is not a string means "all hosts". This function is
      // wired straight to onClick in places (`onClick={onDisconnect}`), where
      // React hands the handler a MouseEvent — as a device id that matches
      // nothing, so the disconnect would silently do nothing at all. TypeScript
      // cannot see it: those props are declared `() => void`, and a handler
      // taking fewer parameters is assignable to one taking more.
      const id = typeof deviceId === 'string' ? deviceId : undefined;
      const session = sessionRef.current;
      session?.disconnectCoyote(id);
      // The scalar surface tracks the primary, and the primary may just have
      // become a different host (disconnecting #1 while #2 is still attached)
      // or none at all. Leaving the old name/battery on screen would claim a
      // device is attached that no longer is.
      const primary = session?.getCoyoteSummaries()[0] ?? null;
      setDeviceInfo(
        primary
          ? { version: primary.version, name: primary.name, battery: primary.battery ?? 0 }
          : null,
      );
      syncState();
    },
    [syncState],
  );

  /** Disconnect only the sensor (keep the Coyote / Opossum). */
  const disconnectSensor = useCallback(() => {
    sessionRef.current?.disconnectSensor();
  }, []);

  /** Disconnect only the Opossum (keep the Coyote / sensor). */
  const disconnectOpossum = useCallback(() => {
    sessionRef.current?.disconnectOpossum();
  }, []);

  /** Set the strength of the given channel. `deviceId` omitted = the primary host. */
  const setStrength = useCallback((channel: 'A' | 'B', value: number, deviceId?: string) => {
    sessionRef.current?.coyoteById(deviceId)?.setStrength(channel, value);
  }, []);

  /** Set the waveform of the given channel. `deviceId` omitted = the primary host. */
  const setWave = useCallback(
    (
      channel: 'A' | 'B',
      frames: WaveFrame[],
      waveformId: string,
      loop?: boolean,
      deviceId?: string,
    ) => {
      sessionRef.current?.coyoteById(deviceId)?.setWave(channel, frames, waveformId, loop);
    },
    [],
  );

  /** Stop the waveform on the given channel. `deviceId` omitted = the primary host. */
  const stopWave = useCallback((channel: 'A' | 'B', deviceId?: string) => {
    sessionRef.current?.coyoteById(deviceId)?.stopWave(channel);
  }, []);

  /**
   * Set a channel's strength cap (Coyote and Opossum share one set of caps,
   * see the DeviceSession docs).
   *
   * With no `deviceId` this applies to *every* attached host and to any host
   * attached later — a cap the user lowered must not quietly fail to cover
   * the second device.
   */
  const setLimit = useCallback(
    (channel: 'A' | 'B', value: number, deviceId?: string) => {
      const session = sessionRef.current;
      if (!session) return;
      if (deviceId) session.coyoteById(deviceId)?.setLimit(channel, value);
      else session.setCoyoteLimit(channel, value);
      syncState();
    },
    [syncState],
  );

  /**
   * Emergency stop: zero **every** attached Coyote and both Opossum channels.
   *
   * Deliberately takes NO arguments, unlike every other command here. It is
   * wired straight to onClick in several places (`onClick={device.stopAll}`),
   * and an optional `deviceId` would let React hand it a MouseEvent as the
   * target id — which resolves to no device, so the emergency stop would
   * silently stop nothing at all. Per-device zeroing is `stopCoyote` below;
   * this one is never narrowed.
   */
  const stopAll = useCallback(() => {
    sessionRef.current?.stopAllOutputs();
  }, []);

  /**
   * Zero one Coyote host. A convenience for a per-device 归零 button — it is
   * NOT the emergency stop, which is `stopAll` above and always covers
   * everything.
   */
  const stopCoyote = useCallback((deviceId: string) => {
    sessionRef.current?.coyoteById(deviceId)?.stopAll();
  }, []);

  /**
   * Set an Opossum channel's intensity, capped by the Opossum's own limit.
   *
   * This used to borrow the Coyote's limitA/limitB. The shared settings have
   * always carried separate maxIntensityA/B for the Opossum, and nothing read
   * them — lowering the Opossum cap in settings had no effect here, which is
   * a safety control that visibly does nothing.
   */
  const setOpossumIntensity = useCallback((channel: 'A' | 'B', value: number) => {
    const session = sessionRef.current;
    if (!session) return;
    const safety = loadDeviceSafety();
    const limit = channel === 'A' ? safety.maxIntensityA : safety.maxIntensityB;
    session.setOpossumIntensity(channel, value, limit);
  }, []);

  /** One-tap Opossum burst: spike to the target strength briefly, then fall back automatically. */
  const opossumBurst = useCallback((channel: 'A' | 'B', strength: number, durationMs = 500) => {
    const session = sessionRef.current;
    if (!session) return;
    const safety = loadDeviceSafety();
    const limit = channel === 'A' ? safety.maxIntensityA : safety.maxIntensityB;
    session.opossumBurst(channel, strength, durationMs, limit);
  }, []);

  /** Stop one or both Opossum channels. */
  const opossumStop = useCallback((channel?: 'A' | 'B') => {
    sessionRef.current?.opossumStop(channel);
  }, []);

  /** Select a shared waveform for one Opossum channel. */
  const setOpossumWaveform = useCallback(
    (channel: 'A' | 'B', frames: WaveFrame[], waveformId: string) => {
      sessionRef.current?.setOpossumWaveform(channel, frames, waveformId);
    },
    [],
  );

  const setOpossumPattern = useCallback(
    (channel: 'A' | 'B', pattern: 'constant' | 'pulse' | 'wave' | 'ramp' | 'heartbeat') => {
      sessionRef.current?.setOpossumPattern(channel, pattern);
    },
    [],
  );

  const setDeviceLink = useCallback((rule: DeviceLinkRule) => {
    sessionRef.current?.setDeviceLinkRule(rule);
    setDeviceLinkState({ ...rule });
  }, []);

  /** Set the LED color of the sensor or the Opossum (discrete 0-7 enum, see LedColorPicker). */
  const setLedColor = useCallback((target: 'sensor' | 'opossum', color: number) => {
    sessionRef.current?.setLedColor(target, color);
  }, []);

  /** Set the multi-user fire aggregation policy */
  const setFirePolicy = useCallback((p: 'sum' | 'max' | 'avg') => {
    setFirePolicyState(p);
    localStorage.setItem('dg-fire-policy', p);
  }, []);

  // Background behavior: stop output (Coyote + Opossum) when the page goes to
  // the background, if that is what the setting says.
  //
  // Note this only covers **browser-level foreground/background** (switching
  // tabs, locking the screen, switching to another app). "Switching to another
  // module" does not come through here — in the unified shell, switching
  // modules only sets DOM hidden, the page itself is still visible, and this
  // handler never fires at all. That path is covered by revoking the
  // device-control lease (see onRevoke).
  // Follow the shared caps live: changing them in settings must take effect
  // in an open Chat session, not only after a reconnect.
  useEffect(() => {
    const apply = () => {
      const safety = loadDeviceSafety();
      // Every attached host, not just the primary — and the session keeps
      // these as the seed for hosts attached later.
      sessionRef.current?.setCoyoteLimit('A', safety.maxStrengthA);
      sessionRef.current?.setCoyoteLimit('B', safety.maxStrengthB);
      sessionRef.current?.setOpossumLimits(safety.maxIntensityA, safety.maxIntensityB);
      setLimitA(safety.maxStrengthA);
      setLimitB(safety.maxStrengthB);
      syncState();
    };
    apply();
    return subscribeDeviceSafety(apply);
  }, [syncState]);

  useEffect(() => {
    const guard = new DeviceLifecycleGuard({
      onStop: () => {
        sessionRef.current?.stopAllOutputs();
        syncState();
      },
    });
    return guard.start();
  }, [syncState]);

  return {
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
    disconnect,
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
  };
}
