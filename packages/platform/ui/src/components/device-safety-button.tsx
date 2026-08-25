import { useEffect, useRef, useState } from 'react';
import { Bluetooth, BluetoothOff, RotateCcw, Radar, Gauge } from 'lucide-react';
import { Popover } from './popover';
import type { SensorSummary, OpossumSummary } from '@0xnullai/device-runtime';
import type { DeviceKind } from '@dg-kit/core';
import { isDevicePickerCancelled } from '@dg-kit/core';
import type { DeviceLinkRule } from '@dg-kit/core';

export interface DeviceSafetyButtonProps {
  connected: boolean;
  deviceName: string | null;
  battery: number | null;
  onDisconnect: () => void;
  limitA: number;
  limitB: number;
  onSetLimit: (channel: 'A' | 'B', value: number) => void;
  /**
   * How several controllers holding fire at once combine. Optional, and the whole block
   * disappears when it is left out: in a single-user module there is never more than one
   * controller, so a chooser between 取最大 / 叠加 / 平均 offers a decision that cannot
   * arise, in the one panel where every visible control has to mean something.
   */
  firePolicy?: 'sum' | 'max' | 'avg';
  onSetFirePolicy?: (p: 'sum' | 'max' | 'avg') => void;
  /** Omit in modules without a waveform library, such as Voice. */
  onRestoreDefaults?: () => void;
  /** The attached sensor (paw-prints or civet-edging, one of the two), null when none. */
  sensor: SensorSummary | null;
  /** The attached Opossum vibration controller, null when none. */
  opossum: OpossumSummary | null;
  /**
   * Unified connect entry point: opens one device picker covering all 4 kinds of DG-Lab
   * device (Coyote host / paw-prints sensor / civet-edging sensor / Opossum) and attaches
   * each into the matching slot by device kind. Click it repeatedly to connect several
   * devices one after another. On the web it goes through the Web Bluetooth picker, on
   * Tauri Android through a plugin-blec scan + device picker — both behave the same.
   */
  onConnectDevice: () => Promise<unknown>;
  onDisconnectSensor?: () => void;
  onDisconnectOpossum: () => void;
  /** Device families this module can actually use. Defaults to every supported family. */
  supportedDeviceKinds?: readonly DeviceKind[];
  /** Optional, explicit sensor/button → Opossum linkage controls. */
  deviceLink?: DeviceLinkRule | null;
  onSetDeviceLink?: (rule: DeviceLinkRule) => void;
}

const SENSOR_KIND_LABEL: Record<string, string> = {
  'paw-prints': '爪印传感器',
  'civet-edging': '灵猫边缘传感器',
};

export function DeviceSafetyButton({
  connected,
  deviceName,
  battery,
  onDisconnect,
  limitA,
  limitB,
  onSetLimit,
  firePolicy,
  onSetFirePolicy,
  onRestoreDefaults,
  sensor,
  opossum,
  onConnectDevice,
  onDisconnectSensor,
  onDisconnectOpossum,
  supportedDeviceKinds = ['coyote', 'paw-prints', 'civet-edging', 'opossum'],
  deviceLink,
  onSetDeviceLink,
}: DeviceSafetyButtonProps) {
  const [open, setOpen] = useState(false);
  const [connectingDevice, setConnectingDevice] = useState(false);
  const [connectDeviceError, setConnectDeviceError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchorTop, setAnchorTop] = useState(0);

  useEffect(() => {
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setAnchorTop(r.bottom + 4);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  /**
   * Unified connect entry point: one button opens one Bluetooth picker covering all 4 kinds
   * of DG-Lab device. Click it repeatedly to connect Coyote host + sensor + Opossum in turn.
   */
  async function handleConnectDevice() {
    setConnectDeviceError(null);
    setConnectingDevice(true);
    try {
      await onConnectDevice();
    } catch (err) {
      // Closing the picker is a normal action, not a failure worth a red banner.
      if (!isDevicePickerCancelled(err)) {
        setConnectDeviceError(err instanceof Error ? err.message : '连接设备失败');
      }
    } finally {
      setConnectingDevice(false);
    }
  }

  const extraDeviceCount = (sensor?.connected ? 1 : 0) + (opossum?.connected ? 1 : 0);
  const connectedDeviceCount = (connected ? 1 : 0) + extraDeviceCount;
  const anyConnected = connectedDeviceCount > 0;
  const supportedDeviceText = supportedDeviceKinds
    .map((kind) => {
      if (kind === 'coyote') return 'Coyote 主机';
      if (kind === 'paw-prints') return '爪印传感器';
      if (kind === 'civet-edging') return '灵猫边缘传感器';
      return 'Opossum 振动控制器';
    })
    .join('、');

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-1.5 rounded-[var(--radius-ctl)] px-2.5 text-xs transition-colors ${
          anyConnected
            ? 'bg-[var(--success-soft)] text-[var(--success)]'
            : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
        }`}
        title={anyConnected ? `已连接 ${connectedDeviceCount} 台设备` : '设备与个人安全设置'}
        aria-label="设备与个人安全设置"
      >
        {anyConnected ? (
          <>
            <Bluetooth className="h-4 w-4" />
            {connected && battery != null && <span className="hidden sm:inline">{battery}%</span>}
          </>
        ) : (
          <BluetoothOff className="h-4 w-4" />
        )}
        {extraDeviceCount > 0 && (
          <span className="rounded-full bg-[var(--accent-soft)] px-1 text-[9px] font-medium text-[var(--accent)]">
            +{extraDeviceCount}
          </span>
        )}
      </button>

      <Popover open={open} onOpenChange={setOpen} title="设备与个人安全设置" anchorTop={anchorTop}>
        <div className="space-y-4">
          {/* Unified connect entry point: one button + one device picker, covering all 4 kinds
              of device (Coyote host / paw-prints sensor / civet-edging sensor / Opossum);
              the kind is recognized from the name and attached into the matching slot.
              On the web this pops the Web Bluetooth picker, on Tauri Android the picker
              built from a plugin-blec scan — both behave the same, and repeated clicks
              connect several devices one after another. */}
          <div className="space-y-2">
            <button
              onClick={handleConnectDevice}
              disabled={connectingDevice}
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] text-xs font-medium text-[var(--accent)] transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {connected ? <Bluetooth size={14} /> : <BluetoothOff size={14} />}
              {connectingDevice ? '连接中…' : '连接设备'}
            </button>
            {connectDeviceError && (
              <p className="text-[10px] text-[var(--danger)]">{connectDeviceError}</p>
            )}
            <p className="text-[10px] text-[var(--text-faint)]">
              自动识别{supportedDeviceText}，点击后从选择器中选取即可；重复点击可依次连接设备。
            </p>
          </div>

          {/* Coyote host status */}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--surface-border)] pt-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[var(--text-soft)]">Coyote 主机</p>
              <p className="truncate text-[10px] text-[var(--text-faint)]">
                {connected
                  ? `${deviceName ?? '已连接'}${battery != null ? ` · 电量 ${battery}%` : ''}`
                  : '未连接'}
              </p>
            </div>
            {connected && (
              <button
                onClick={onDisconnect}
                className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-1.5 text-xs font-medium text-[var(--danger)]"
              >
                断开
              </button>
            )}
          </div>

          {/* Status of the attached sensor / Opossum (shown only once attached; connecting
              itself goes through the unified entry point above) */}
          {(sensor || opossum) && (
            <div className="space-y-2 border-t border-[var(--surface-border)] pt-3">
              {sensor && (
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--bg-soft)] px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Radar size={14} className="shrink-0 text-[var(--accent)]" />
                    <div className="min-w-0">
                      <p className="truncate text-xs text-[var(--text)]">
                        {SENSOR_KIND_LABEL[sensor.kind] ?? sensor.kind}
                      </p>
                      <p className="text-[10px] text-[var(--text-faint)]">
                        {sensor.connected
                          ? `已连接${sensor.battery != null ? ` · 电量 ${sensor.battery}%` : ''}`
                          : '已断开'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => onDisconnectSensor?.()}
                    className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-2 py-1 text-[10px] font-medium text-[var(--danger)]"
                  >
                    断开
                  </button>
                </div>
              )}

              {opossum && (
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--bg-soft)] px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Gauge size={14} className="shrink-0 text-[var(--accent)]" />
                    <div className="min-w-0">
                      <p className="truncate text-xs text-[var(--text)]">Opossum 振动控制器</p>
                      <p className="text-[10px] text-[var(--text-faint)]">
                        {opossum.connected
                          ? `已连接${opossum.battery != null ? ` · 电量 ${opossum.battery}%` : ''}`
                          : '已断开'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={onDisconnectOpossum}
                    className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-2 py-1 text-[10px] font-medium text-[var(--danger)]"
                  >
                    断开
                  </button>
                </div>
              )}
            </div>
          )}

          {deviceLink && onSetDeviceLink && sensor?.connected && opossum?.connected && (
            <div className="space-y-2 border-t border-[var(--surface-border)] pt-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--text-soft)]">设备联动</p>
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
                  <input
                    type="checkbox"
                    checked={deviceLink.enabled}
                    onChange={(e) => onSetDeviceLink({ ...deviceLink, enabled: e.target.checked })}
                  />
                  启用
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <select
                  value={deviceLink.source}
                  onChange={(e) =>
                    onSetDeviceLink({
                      ...deviceLink,
                      source: e.target.value as DeviceLinkRule['source'],
                    })
                  }
                  className="rounded border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1"
                >
                  <option value="civet-pressure">灵猫压力</option>
                  <option value="paw-button">爪印按键</option>
                  <option value="opossum-button">负鼠按键</option>
                </select>
                <select
                  value={deviceLink.channel}
                  onChange={(e) =>
                    onSetDeviceLink({
                      ...deviceLink,
                      channel: e.target.value as DeviceLinkRule['channel'],
                    })
                  }
                  className="rounded border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1"
                >
                  <option value="A">负鼠 A</option>
                  <option value="B">负鼠 B</option>
                  <option value="both">负鼠 A+B</option>
                </select>
                <select
                  value={deviceLink.pattern}
                  onChange={(e) =>
                    onSetDeviceLink({
                      ...deviceLink,
                      pattern: e.target.value as DeviceLinkRule['pattern'],
                    })
                  }
                  className="rounded border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1"
                >
                  <option value="constant">恒定</option>
                  <option value="pulse">脉冲</option>
                  <option value="wave">波浪</option>
                  <option value="ramp">渐强</option>
                  <option value="heartbeat">心跳</option>
                </select>
                <label className="flex items-center gap-1 rounded border border-[var(--surface-border)] px-2 py-1">
                  强度
                  <input
                    type="number"
                    min={0}
                    max={200}
                    value={deviceLink.intensity}
                    onChange={(e) =>
                      onSetDeviceLink({ ...deviceLink, intensity: Number(e.target.value) })
                    }
                    className="w-12 bg-transparent text-right"
                  />
                </label>
              </div>
              {deviceLink.source === 'civet-pressure' && (
                <label className="flex items-center justify-between text-[10px] text-[var(--text-faint)]">
                  压力阈值 {deviceLink.thresholdKPa.toFixed(1)} kPa
                  <input
                    type="range"
                    min={0}
                    max={30}
                    step={0.5}
                    value={deviceLink.thresholdKPa}
                    onChange={(e) =>
                      onSetDeviceLink({ ...deviceLink, thresholdKPa: Number(e.target.value) })
                    }
                  />
                </label>
              )}
              <p className="text-[10px] text-[var(--text-faint)]">
                默认关闭；只在当前成员自己的设备之间联动。
              </p>
            </div>
          )}

          {/* Channel limits */}
          <div className="space-y-3 border-t border-[var(--surface-border)] pt-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-[var(--text-soft)]">A 通道上限</span>
                <span className="text-xs tabular-nums font-medium text-[var(--accent)]">
                  {limitA}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={200}
                value={limitA}
                onChange={(e) => onSetLimit('A', Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-[var(--text-soft)]">B 通道上限</span>
                <span className="text-xs tabular-nums font-medium text-[var(--accent)]">
                  {limitB}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={200}
                value={limitB}
                onChange={(e) => onSetLimit('B', Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>

          {/* Backgrounding always stops output now — it is not a choice, so
              there is nothing here to toggle. */}
          {/* Multi-controller fire aggregation — only where several people can hold fire at once. */}
          {onSetFirePolicy && (
            <div className="border-t border-[var(--surface-border)] pt-3">
              <p className="mb-2 text-xs font-medium text-[var(--text-soft)]">多人开火聚合策略</p>
              <div className="flex gap-1">
                {(['max', 'sum', 'avg'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => onSetFirePolicy(p)}
                    className={`flex-1 rounded-[var(--radius-sm)] py-1.5 text-xs transition-colors ${
                      firePolicy === p
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border border-[var(--surface-border)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
                    }`}
                  >
                    {p === 'max' ? '取最大' : p === 'sum' ? '叠加' : '平均'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Restore default waveforms */}
          {onRestoreDefaults && (
            <div className="border-t border-[var(--surface-border)] pt-3">
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      '恢复默认波形：清空全部自定义波形并取消隐藏所有内置波形。此操作无法撤销。',
                    )
                  ) {
                    onRestoreDefaults();
                  }
                }}
                className="flex h-9 w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] text-xs font-medium text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
              >
                <RotateCcw size={13} /> 恢复默认波形
              </button>
              <p className="mt-1 text-[10px] text-[var(--text-faint)]">清空自定义 + 取消隐藏内置</p>
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
