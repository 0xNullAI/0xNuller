import { Radar, BatteryMedium } from 'lucide-react';
import type { CmdAction, DeviceCommand, MemberState } from '../lib/protocol';
import { LedColorPicker } from './LedColorPicker';

interface SensorCardProps {
  peerId: string;
  member: MemberState;
  onSendCommand: (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => void;
}

const KIND_LABEL: Record<string, string> = {
  'paw-prints': '爪印传感器',
  'civet-edging': '灵猫边缘传感器',
};

function formatAgo(at: number | null | undefined): string {
  if (!at) return '';
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  return `${min} 分钟前`;
}

/**
 * 只读传感器遥测卡片：爪印传感器展示最近的按钮/触发事件，灵猫边缘传感器展示
 * 压力数值。两者共用 MemberState.sensorKind 区分展示形式。
 *
 * 重要：这里只展示，不触发任何联动 —— 传感器事件是否应该驱动其他人的设备是
 * 一个需要专门同意/授权 UI 的功能，这一版本刻意没做（见 lib/commands.ts 里的
 * TODO 和 DeviceSession.attachSensor 里的同名说明）。
 */
export function SensorCard({ peerId, member, onSendCommand }: SensorCardProps) {
  if (!member.sensorKind) return null;

  const label = KIND_LABEL[member.sensorKind] ?? member.sensorKind;
  const isCivet = member.sensorKind === 'civet-edging';

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <Radar size={15} className="text-[var(--accent)]" />
          {label}
          <span className={`h-2 w-2 rounded-full ${member.sensorConnected ? 'bg-[var(--success)]' : 'bg-[var(--text-faint)]'}`} />
        </div>
        {member.sensorBattery != null && (
          <span className="flex items-center gap-0.5 text-xs text-[var(--text-soft)]">
            <BatteryMedium size={13} /> {member.sensorBattery}%
          </span>
        )}
      </div>

      {!member.sensorConnected ? (
        <p className="text-xs text-[var(--text-faint)]">已断开</p>
      ) : isCivet ? (
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
            {member.sensorLastValue != null ? member.sensorLastValue.toFixed(1) : '--'}
          </span>
          <span className="text-xs text-[var(--text-faint)]">kPa</span>
          {member.sensorLastEventAt != null && (
            <span className="ml-auto text-[10px] text-[var(--text-faint)]">{formatAgo(member.sensorLastEventAt)}</span>
          )}
        </div>
      ) : (
        <div>
          <p className="text-sm text-[var(--text)]">
            {member.sensorLastEvent ?? '暂无事件'}
          </p>
          {member.sensorLastEventAt != null && (
            <p className="text-[10px] text-[var(--text-faint)]">{formatAgo(member.sensorLastEventAt)}</p>
          )}
        </div>
      )}

      {member.sensorConnected && (
        <LedColorPicker
          className="mt-3 border-t border-[var(--surface-border)] pt-2"
          onPick={color => onSendCommand(peerId, 'set_led', { kind: member.sensorKind ?? undefined, color })}
        />
      )}
    </div>
  );
}
