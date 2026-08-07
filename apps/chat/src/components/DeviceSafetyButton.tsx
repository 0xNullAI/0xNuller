import { useEffect, useRef, useState } from 'react';
import { Bluetooth, BluetoothOff, RotateCcw, Radar, Gauge } from 'lucide-react';
import { Popover } from './Popover';
import type { SensorSummary, OpossumSummary } from '../lib/bluetooth';
import type { DeviceKind } from '../lib/protocol';

interface DeviceSafetyButtonProps {
  connected: boolean;
  deviceName: string | null;
  battery: number | null;
  onDisconnect: () => void;
  limitA: number;
  limitB: number;
  onSetLimit: (channel: 'A' | 'B', value: number) => void;
  backgroundBehavior: 'stop' | 'keep';
  onSetBackgroundBehavior: (mode: 'stop' | 'keep') => void;
  firePolicy: 'sum' | 'max' | 'avg';
  onSetFirePolicy: (p: 'sum' | 'max' | 'avg') => void;
  onRestoreDefaults: () => void;
  /** 已接入的传感器（爪印/灵猫边缘，二选一），未接入为 null。 */
  sensor: SensorSummary | null;
  /** 已接入的 Opossum 负鼠振动控制器，未接入为 null。 */
  opossum: OpossumSummary | null;
  /**
   * 统一连接入口：打开一个设备选择器，覆盖全部 4 种 DG-Lab 设备
   * （Coyote 主机 / 爪印传感器 / 灵猫边缘传感器 / Opossum），按设备种类
   * 自动接入对应槽位。反复点击可依次连接多台设备。Web 端走 Web Bluetooth
   * 选择器，Tauri Android 端走 plugin-blec 扫描 + 设备选择器——两端行为一致。
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
  connected, deviceName, battery,
  onDisconnect,
  limitA, limitB, onSetLimit,
  backgroundBehavior, onSetBackgroundBehavior,
  firePolicy, onSetFirePolicy,
  onRestoreDefaults,
  sensor, opossum, onConnectDevice, onDisconnectSensor, onDisconnectOpossum,
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
   * 统一连接入口：一个按钮打开一次蓝牙选择器，覆盖全部 4 种 DG-Lab 设备。
   * 可反复点击以依次连接 Coyote 主机 + 传感器 + Opossum。
   */
  async function handleConnectDevice() {
    setConnectDeviceError(null);
    setConnectingDevice(true);
    try {
      await onConnectDevice();
    } catch (err) {
      setConnectDeviceError(err instanceof Error ? err.message : '连接设备失败');
    } finally {
      setConnectingDevice(false);
    }
  }

  const extraDeviceCount = (sensor ? 1 : 0) + (opossum ? 1 : 0);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        className={`flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-xs transition-colors ${
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
          {/* 统一连接入口：一个按钮 + 一次设备选择器，覆盖 Coyote 主机 / 爪印传感器 /
              灵猫边缘传感器 / Opossum 全部 4 种设备，按名字自动识别种类接入对应槽位。
              Web 端弹出 Web Bluetooth 选择器，Tauri Android 端弹出 plugin-blec 扫描出
              的设备选择器——两端行为一致，可反复点击以依次连接多台设备。 */}
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

          {/* Coyote 主机状态 */}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--surface-border)] pt-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[var(--text-soft)]">Coyote 主机</p>
              <p className="truncate text-[10px] text-[var(--text-faint)]">
                {connected ? `${deviceName ?? '已连接'}${battery != null ? ` · 电量 ${battery}%` : ''}` : '未连接'}
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

          {/* 已接入的传感器 / Opossum 状态（仅在已接入时显示，连接本身走上方统一入口） */}
          {(sensor || opossum) && (
            <div className="space-y-2 border-t border-[var(--surface-border)] pt-3">
              {sensor && (
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--bg-soft)] px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Radar size={14} className="shrink-0 text-[var(--accent)]" />
                    <div className="min-w-0">
                      <p className="truncate text-xs text-[var(--text)]">{SENSOR_KIND_LABEL[sensor.kind] ?? sensor.kind}</p>
                      <p className="text-[10px] text-[var(--text-faint)]">
                        {sensor.connected ? `已连接${sensor.battery != null ? ` · 电量 ${sensor.battery}%` : ''}` : '已断开'}
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
                        {opossum.connected ? `已连接${opossum.battery != null ? ` · 电量 ${opossum.battery}%` : ''}` : '已断开'}
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

          {/* 通道上限 */}
          <div className="space-y-3 border-t border-[var(--surface-border)] pt-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-[var(--text-soft)]">A 通道上限</span>
                <span className="text-xs tabular-nums font-medium text-[var(--accent)]">{limitA}</span>
              </div>
              <input type="range" min={0} max={200} value={limitA} onChange={e => onSetLimit('A', Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-[var(--text-soft)]">B 通道上限</span>
                <span className="text-xs tabular-nums font-medium text-[var(--accent)]">{limitB}</span>
              </div>
              <input type="range" min={0} max={200} value={limitB} onChange={e => onSetLimit('B', Number(e.target.value))} className="w-full" />
            </div>
            <p className="text-[10px] text-[var(--text-faint)]">硬件级别限制，远程控制无法超过此上限（Opossum 振动强度共用同一套上限）</p>
          </div>

          {/* 后台行为 */}
          <div className="flex items-center justify-between border-t border-[var(--surface-border)] pt-3">
            <div>
              <p className="text-xs font-medium text-[var(--text-soft)]">后台行为</p>
              <p className="text-[10px] text-[var(--text-faint)]">切换至其他标签页时</p>
            </div>
            <button
              onClick={() => onSetBackgroundBehavior(backgroundBehavior === 'stop' ? 'keep' : 'stop')}
              className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-colors ${
                backgroundBehavior === 'stop'
                  ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                  : 'bg-[var(--success-soft)] text-[var(--success)]'
              }`}
            >
              {backgroundBehavior === 'stop' ? '停止输出' : '继续运行'}
            </button>
          </div>

          {/* 多人开火聚合 */}
          <div className="border-t border-[var(--surface-border)] pt-3">
            <p className="mb-2 text-xs font-medium text-[var(--text-soft)]">多人开火聚合策略</p>
            <div className="flex gap-1">
              {(['max', 'sum', 'avg'] as const).map(p => (
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

          {/* 恢复默认波形 */}
          <div className="border-t border-[var(--surface-border)] pt-3">
            <button
              onClick={() => {
                if (window.confirm('恢复默认波形：清空全部自定义波形并取消隐藏所有内置波形。此操作无法撤销。')) {
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
