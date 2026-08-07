import type { ReactNode } from 'react';
import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from 'lucide-react';
import { Meter } from './meter';

/**
 * 设备连接状态的共享原语。
 *
 * 合并前这几个内核在 DG-Agent 的 ChatPanel 与 DG-Voice 的 DeviceStatusBar 里各存
 * 一份，**逐字复制**：DEVICE_STRENGTH_CAP、BatteryIcon（同样的 10/30/70 三档）、
 * DeviceStatusChip、ChannelStrengthBar、clampPercentage 五个全都一样。
 *
 * 这里只收「怎么显示」，不收「有哪些设备」——Agent 支持四种设备（多爪印/灵猫两个
 * 没有强度条），Voice 只做郊狼与负鼠。设备种类的差异留在各自的编排层，共享的是
 * 电量档位、强度条刻度、chip 交互这些真正相同的东西。
 */

/** 协议层的强度上限。强度条按这个值归一化，用户设的上限画成刻度线。 */
export const DEVICE_STRENGTH_CAP = 200;

export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 电量图标。三档阈值（10/30/70）与配色是产品既定行为，不要随手改。 */
export function BatteryIcon({ level }: { level: number | null | undefined }) {
  if (level == null) return <Battery className="h-3.5 w-3.5 text-[var(--text-faint)]" />;
  if (level <= 10) return <BatteryWarning className="h-3.5 w-3.5 text-[var(--danger)]" />;
  if (level <= 30) return <BatteryLow className="h-3.5 w-3.5 text-[var(--warning)]" />;
  if (level <= 70) return <BatteryMedium className="h-3.5 w-3.5 text-[var(--text-soft)]" />;
  return <BatteryFull className="h-3.5 w-3.5 text-[var(--success)]" />;
}

export interface DeviceStatusChipProps {
  icon: ReactNode;
  battery: number | null | undefined;
  onClick: () => void;
  title: string;
  children?: ReactNode;
}

/** 一台设备的状态块：图标 + 电量（点击断开）+ 右侧自定义内容（通常是强度条）。 */
export function DeviceStatusChip({ icon, battery, onClick, title, children }: DeviceStatusChipProps) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 rounded-[8px] px-1.5 py-1 text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] sm:gap-1.5 sm:px-2"
        onClick={onClick}
        title={title}
      >
        {icon}
        <BatteryIcon level={battery} />
        <span className="hidden text-[11px] tabular-nums sm:inline">
          {typeof battery === 'number' ? `${battery}%` : '--'}
        </span>
      </button>
      {children}
    </div>
  );
}

export interface ChannelStrengthBarProps {
  channel: 'A' | 'B';
  /** 当前强度（协议标度 0–200）。 */
  value: number;
  /** 生效上限，画成刻度线。通常是 min(设备上限, 用户安全设置)。 */
  max: number;
  className?: string;
}

/**
 * 单通道强度条。刻度线画的是**生效上限**——用户一眼能看到「还能涨多少」，
 * 这是安全链在界面上的可见部分，不要把它简化掉。
 */
export function ChannelStrengthBar({ channel, value, max, className }: ChannelStrengthBarProps) {
  const normalizedValue = clampPercentage((value / DEVICE_STRENGTH_CAP) * 100);
  const normalizedMax = clampPercentage((max / DEVICE_STRENGTH_CAP) * 100);

  return (
    <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 sm:gap-1.5">
      <span className="text-[10px] font-semibold leading-none tracking-wide text-[var(--accent)]">
        {channel}
      </span>
      <Meter value={normalizedValue} marker={normalizedMax} className={className ?? 'w-16 sm:w-20'} />
      <span className="text-[10px] font-medium tabular-nums leading-none text-[var(--text-soft)]">
        {value}
      </span>
    </div>
  );
}

/** 状态条外壳。各模块把自己的设备 chip 塞进来，容器样式统一。 */
export function DeviceStatusRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 sm:px-4">
      {children}
    </div>
  );
}
