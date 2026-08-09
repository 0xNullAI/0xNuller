import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  DeviceSession,
  type DeviceClientFactory,
  type RequestDeviceFn,
  type WaveFrame,
  type DeviceInfo,
  type SensorSummary,
  type OpossumSummary,
} from '../lib/bluetooth';
import type { DeviceKind } from '../lib/protocol';
import { DeviceLifecycleGuard } from '@dg-kit/safety';

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
 */
export function useDevice(options: UseDeviceOptions = {}) {
  const [connected, setConnected] = useState(false);
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
    setSensor(session.getSensorSummary());
    setOpossum(session.getOpossumSummary());
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
      const session = new DeviceSession(clientFactoryRef.current, requestDeviceRef.current);
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
    const { coyoteInfo, ...result } = await session.connectDevice();
    if (coyoteInfo) setDeviceInfo(coyoteInfo);
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

  /** Disconnect only the Coyote host (keep the sensor / Opossum). */
  const disconnectCoyote = useCallback(() => {
    sessionRef.current?.disconnectCoyote();
  }, []);

  /** Disconnect only the sensor (keep the Coyote / Opossum). */
  const disconnectSensor = useCallback(() => {
    sessionRef.current?.disconnectSensor();
  }, []);

  /** Disconnect only the Opossum (keep the Coyote / sensor). */
  const disconnectOpossum = useCallback(() => {
    sessionRef.current?.disconnectOpossum();
  }, []);

  /** Set the strength of the given channel */
  const setStrength = useCallback((channel: 'A' | 'B', value: number) => {
    sessionRef.current?.coyote.setStrength(channel, value);
  }, []);

  /** Set the waveform of the given channel */
  const setWave = useCallback(
    (channel: 'A' | 'B', frames: WaveFrame[], waveformId: string, loop?: boolean) => {
      sessionRef.current?.coyote.setWave(channel, frames, waveformId, loop);
    },
    [],
  );

  /** Stop the waveform on the given channel */
  const stopWave = useCallback((channel: 'A' | 'B') => {
    sessionRef.current?.coyote.stopWave(channel);
  }, []);

  /** Set a channel's strength cap (Coyote and Opossum share one set of caps, see the DeviceSession docs). */
  const setLimit = useCallback((channel: 'A' | 'B', value: number) => {
    sessionRef.current?.coyote.setLimit(channel, value);
  }, []);

  /** Emergency stop: zero both Coyote channels and both Opossum channels. */
  const stopAll = useCallback(() => {
    sessionRef.current?.stopAllOutputs();
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
      sessionRef.current?.coyote.setLimit('A', safety.maxStrengthA);
      sessionRef.current?.coyote.setLimit('B', safety.maxStrengthB);
      setLimitA(safety.maxStrengthA);
      setLimitB(safety.maxStrengthB);
    };
    apply();
    return subscribeDeviceSafety(apply);
  }, []);

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
    setLedColor,
  };
}
