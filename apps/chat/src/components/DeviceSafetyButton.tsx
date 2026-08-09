import { useEffect, useRef, useState } from 'react';
import { Bluetooth, BluetoothOff, RotateCcw, Radar, Gauge } from 'lucide-react';
import { Popover } from './Popover';
import type { SensorSummary, OpossumSummary } from '../lib/bluetooth';
import type { DeviceKind } from '../lib/protocol';
import { isDevicePickerCancelled } from '@dg-kit/core';

interface DeviceSafetyButtonProps {
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
  onRestoreDefaults: () => void;
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
  onConnectDevice: () => Promise<{ kind: DeviceKind; name: string }>;
  onDisconnectSensor: () => void;
  onDisconnectOpossum: () => void;
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

  const extraDeviceCount = (sensor ? 1 : 0) + (opossum ? 1 : 0);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-1.5 rounded-[var(--radius-ctl)] px-2.5 text-xs transition-colors ${
          connected
            ? 'bg-[var(--success-soft)] text-[var(--success)]'
            : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'
        }`}
        title={connected ? `已连接 ${deviceName ?? ''}` : '设备与个人安全设置'}
        aria-label="设备与个人安全设置"
      >
        {connected ? (
          <>
            <Bluetooth className="h-4 w-4" />
            {battery != null && <span className="hidden sm:inline">{battery}%</span>}
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
              {connectingDevice ? '正在打开选择器…' : '连接设备'}
            </button>
            {connectDeviceError && (
              <p className="text-[10px] text-[var(--danger)]">{connectDeviceError}</p>
            )}
            <p className="text-[10px] text-[var(--text-faint)]">
              自动识别 Coyote 主机、爪印传感器、灵猫边缘传感器、Opossum 振动控制器，
              点击后从选择器中选取即可；每种设备一次只支持接入一台，重复点击可依次连接多台。
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
                    onClick={onDisconnectSensor}
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
            <p className="text-[10px] text-[var(--text-faint)]">
              硬件级别限制，远程控制无法超过此上限。负鼠的振动强度另有一套上限，在设置的「设备安全」里调。
            </p>
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
              <p className="mt-1 text-[10px] text-[var(--text-faint)]">
                取最大：任意控制者按下都不超过其单人份。叠加：多人累计（受上限封顶）。平均：多人按时反而稀释。
              </p>
            </div>
          )}

          {/* Restore default waveforms */}
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
        </div>
      </Popover>
    </>
  );
}
