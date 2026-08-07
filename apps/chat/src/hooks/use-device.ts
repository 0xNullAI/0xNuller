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
 * DG-Lab 设备控制 Hook
 * 封装 DeviceSession 类（Coyote + 可选 sensor + 可选 Opossum），提供 React 状态同步。
 *
 * 保持既有字段名/语义不变（connected/deviceInfo/strengthA/.../setStrength/...
 * 全部仍然只描述 Coyote），新增字段全部是加法：sensor/opossum 相关状态默认为
 * null/false，不影响任何既有消费者。
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
  const [limitA, setLimitA] = useState(50);
  const [limitB, setLimitB] = useState(50);
  const [sensor, setSensor] = useState<SensorSummary | null>(null);
  const [opossum, setOpossum] = useState<OpossumSummary | null>(null);
  const [backgroundBehavior, setBackgroundBehaviorState] = useState<'stop' | 'keep'>(
    () => (localStorage.getItem('dg-bg-behavior') as 'stop' | 'keep') ?? 'stop'
  );
  const [firePolicy, setFirePolicyState] = useState<'sum' | 'max' | 'avg'>(
    () => (localStorage.getItem('dg-fire-policy') as 'sum' | 'max' | 'avg' | null) ?? 'max'
  );
  const firePolicyRef = useRef(firePolicy);
  firePolicyRef.current = firePolicy;
  const sessionRef = useRef<DeviceSession | null>(null);
  const bgBehaviorRef = useRef(backgroundBehavior);
  bgBehaviorRef.current = backgroundBehavior;

  /** 从设备实例同步状态到 React state */
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

  /** 确保 session 已创建（懒创建，首次 connectDevice 时才需要）。 */
  const ensureSession = useCallback((): DeviceSession => {
    if (!sessionRef.current) {
      const session = new DeviceSession(clientFactoryRef.current, requestDeviceRef.current);
      session.setOnStateChange(syncState);
      sessionRef.current = session;
    }
    return sessionRef.current;
  }, [syncState]);

  /**
   * 统一连接入口：打开一个设备选择器，覆盖全部 4 种 DG-Lab 设备
   * （Coyote / 爪印传感器 / 灵猫边缘传感器 / Opossum），按名字前缀自动识别
   * 种类并接入对应槽位——Coyote 走 DeviceSession.connectDevice() 内部路由到
   * coyote.connectViaChosenDevice()，其余三种走 attachSensor/attachOpossum。
   * 反复点击可依次添加更多设备。Web 端走 Web Bluetooth 选择器，Tauri
   * Android 端走 plugin-blec 扫描 + 设备选择器（见 UseDeviceOptions.requestDevice）。
   */
  const connectDevice = useCallback(async (): Promise<{ kind: DeviceKind; name: string }> => {
    const session = ensureSession();
    const { coyoteInfo, ...result } = await session.connectDevice();
    if (coyoteInfo) setDeviceInfo(coyoteInfo);
    syncState();
    return result;
  }, [ensureSession, syncState]);

  /** 断开整个 session（Coyote + 传感器 + Opossum）。用于"断开"按钮和离开房间。 */
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
    setLimitA(50);
    setLimitB(50);
    setSensor(null);
    setOpossum(null);
  }, []);

  /** 仅断开 Coyote 主机（保留传感器 / Opossum）。 */
  const disconnectCoyote = useCallback(() => {
    sessionRef.current?.disconnectCoyote();
  }, []);

  /** 仅断开传感器（保留 Coyote / Opossum）。 */
  const disconnectSensor = useCallback(() => {
    sessionRef.current?.disconnectSensor();
  }, []);

  /** 仅断开 Opossum（保留 Coyote / 传感器）。 */
  const disconnectOpossum = useCallback(() => {
    sessionRef.current?.disconnectOpossum();
  }, []);

  /** 设置指定通道强度 */
  const setStrength = useCallback((channel: 'A' | 'B', value: number) => {
    sessionRef.current?.coyote.setStrength(channel, value);
  }, []);

  /** 设置指定通道波形 */
  const setWave = useCallback(
    (channel: 'A' | 'B', frames: WaveFrame[], waveformId: string, loop?: boolean) => {
      sessionRef.current?.coyote.setWave(channel, frames, waveformId, loop);
    },
    [],
  );

  /** 停止指定通道波形 */
  const stopWave = useCallback((channel: 'A' | 'B') => {
    sessionRef.current?.coyote.stopWave(channel);
  }, []);

  /** 设置通道强度上限（Coyote 和 Opossum 共用同一套上限，见 DeviceSession 文档）。 */
  const setLimit = useCallback((channel: 'A' | 'B', value: number) => {
    sessionRef.current?.coyote.setLimit(channel, value);
  }, []);

  /** 紧急停止：Coyote 双通道 + Opossum 双通道全部归零。 */
  const stopAll = useCallback(() => {
    sessionRef.current?.stopAllOutputs();
  }, []);

  /** 设置 Opossum 指定通道强度（绝对值，受 limitA/limitB 上限约束）。 */
  const setOpossumIntensity = useCallback((channel: 'A' | 'B', value: number) => {
    const session = sessionRef.current;
    if (!session) return;
    const state = session.coyote.getState();
    const limit = channel === 'A' ? state.limitA : state.limitB;
    session.setOpossumIntensity(channel, value, limit);
  }, []);

  /** Opossum 一键脉冲：短时冲到目标强度后自动回落。 */
  const opossumBurst = useCallback((channel: 'A' | 'B', strength: number, durationMs = 500) => {
    const session = sessionRef.current;
    if (!session) return;
    const state = session.coyote.getState();
    const limit = channel === 'A' ? state.limitA : state.limitB;
    session.opossumBurst(channel, strength, durationMs, limit);
  }, []);

  /** 停止 Opossum 一个或两个通道。 */
  const opossumStop = useCallback((channel?: 'A' | 'B') => {
    sessionRef.current?.opossumStop(channel);
  }, []);

  /** 设置传感器或 Opossum 的 LED 颜色（0-7 离散枚举，见 LedColorPicker）。 */
  const setLedColor = useCallback((target: 'sensor' | 'opossum', color: number) => {
    sessionRef.current?.setLedColor(target, color);
  }, []);

  /** 设置后台行为 */
  const setBackgroundBehavior = useCallback((mode: 'stop' | 'keep') => {
    setBackgroundBehaviorState(mode);
    localStorage.setItem('dg-bg-behavior', mode);
  }, []);

  /** 设置多人开火聚合策略 */
  const setFirePolicy = useCallback((p: 'sum' | 'max' | 'avg') => {
    setFirePolicyState(p);
    localStorage.setItem('dg-fire-policy', p);
  }, []);

  // 后台行为：切换至后台时按设置停止输出（Coyote + Opossum）
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden' && bgBehaviorRef.current === 'stop') {
        sessionRef.current?.stopAllOutputs();
        syncState();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
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
    backgroundBehavior,
    setBackgroundBehavior,
    firePolicy,
    firePolicyRef,
    setFirePolicy,
    // —— 多设备（sensor / opossum） ——
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
