import { useCallback, useRef, useEffect } from 'react';
import { Gauge, Zap, RotateCcw, BatteryMedium } from 'lucide-react';
import type { CmdAction, DeviceCommand, MemberState } from '../lib/protocol';
import { LedColorPicker } from './LedColorPicker';

interface OpossumControlProps {
  peerId: string;
  member: MemberState;
  onSendCommand: (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => void;
  /** 与 Coyote 共用的安全上限（0-200），见 DeviceSafetyButton 的说明。 */
  limitA: number;
  limitB: number;
}

const RING_R = 40;
const RING_C = 2 * Math.PI * RING_R;
const BURST_STRENGTH_RATIO = 0.8;

/** 与 MemberControl 里的 RepeatButton 同样的长按连发模式，独立实现以保持 OpossumControl 自包含。 */
function useRepeatAction(action: () => void, initialDelay = 400, repeatInterval = 100) {
  const timerRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  const stop = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  const start = useCallback(() => {
    stop();
    actionRef.current();
    timerRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => actionRef.current(), repeatInterval);
    }, initialDelay);
  }, [stop, initialDelay, repeatInterval]);

  useEffect(() => stop, [stop]);

  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop };
}

function RepeatButton({ onAction, children }: { onAction: () => void; children: React.ReactNode }) {
  const handlers = useRepeatAction(onAction);
  return (
    <button
      {...handlers}
      onContextMenu={e => e.preventDefault()}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xs text-[var(--text)] hover:border-[var(--accent)] active:scale-90"
      style={{ touchAction: 'manipulation', WebkitUserSelect: 'none', userSelect: 'none' }}
    >{children}</button>
  );
}

function IntensityRing({ label, value, limit }: { label: string; value: number; limit: number }) {
  const pct = limit > 0 ? Math.min(1, value / limit) : 0;
  const offset = RING_C * (1 - pct);
  return (
    <div className="relative flex items-center justify-center" style={{ width: 96, height: 96 }}>
      <svg className="absolute inset-0" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={RING_R} fill="none" stroke="var(--surface-border)" strokeWidth="6" />
        <circle
          cx="48" cy="48" r={RING_R}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={offset}
          transform="rotate(-90 48 48)"
          className="transition-all duration-150"
        />
      </svg>
      <div className="flex flex-col items-center">
        <span className="text-xl font-bold tabular-nums text-[var(--text)]">{value}</span>
        <span className="text-[10px] text-[var(--text-faint)]">{label}:{limit}</span>
      </div>
    </div>
  );
}

/**
 * Opossum（负鼠双通道振动控制器）控制面板。以 MemberControl 的双通道强度环
 * 作为模板改造：范围 0-200（复用 Coyote 的 limitA/limitB 安全上限，而不是
 * 单独一套上限 UI —— 见 DeviceSafetyButton 的说明），没有波形/频率概念所以
 * 没有波形 Tab，只有直接强度 +/- 和一个"一键脉冲"便捷按钮。
 */
export function OpossumControl({ peerId, member, onSendCommand, limitA, limitB }: OpossumControlProps) {
  if (!member.opossumConnected) return null;

  const intensityA = member.opossumIntensityA ?? 0;
  const intensityB = member.opossumIntensityB ?? 0;

  const adjust = (channel: 'A' | 'B', delta: number) => {
    onSendCommand(peerId, 'vibrate_adjust', { c: channel, v: delta });
  };

  const burst = (channel: 'A' | 'B') => {
    const limit = channel === 'A' ? limitA : limitB;
    onSendCommand(peerId, 'vibrate_burst', { c: channel, v: Math.round(limit * BURST_STRENGTH_RATIO), ms: 500 });
  };

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <Gauge size={15} className="text-[var(--accent)]" />
          Opossum 振动控制器
        </div>
        {member.opossumBattery != null && (
          <span className="flex items-center gap-0.5 text-xs text-[var(--text-soft)]">
            <BatteryMedium size={13} /> {member.opossumBattery}%
          </span>
        )}
      </div>

      <div className="flex items-center justify-center gap-6">
        {(['A', 'B'] as const).map(channel => {
          const value = channel === 'A' ? intensityA : intensityB;
          const limit = channel === 'A' ? limitA : limitB;
          return (
            <div key={channel} className="flex flex-col items-center">
              <IntensityRing label={channel} value={value} limit={limit} />
              <div className="mt-2 flex items-center gap-2">
                <RepeatButton onAction={() => adjust(channel, -1)}>−</RepeatButton>
                <RepeatButton onAction={() => adjust(channel, +1)}>+</RepeatButton>
              </div>
              <button
                onClick={() => burst(channel)}
                className="mt-2 flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] text-[var(--accent)] transition-opacity hover:opacity-80"
                title="短促脉冲后自动回落"
              >
                <Zap size={11} /> 脉冲
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex justify-center">
        <button
          onClick={() => onSendCommand(peerId, 'vibrate_stop')}
          className="flex h-9 flex-1 max-w-xs items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-soft)] active:scale-[0.98]"
        >
          <RotateCcw size={14} className="text-[var(--danger)]" />
          归零
        </button>
      </div>

      <LedColorPicker
        className="mt-3 border-t border-[var(--surface-border)] pt-2"
        onPick={color => onSendCommand(peerId, 'set_led', { kind: 'opossum', color })}
      />
    </div>
  );
}
