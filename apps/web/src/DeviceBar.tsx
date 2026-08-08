import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import {
  allConnectedDevices,
  stopAllSafetySessions,
  subscribeSafetySessions,
} from '@dg-kit/safety';
import type { DeviceSummary } from '@dg-kit/safety';
import { BatteryIcon } from '@0xnullai/ui';

/**
 * 设备栏。连上设备后出现在内容区最上方，停止按钮在最左。
 *
 * **显隐只看「有没有已连接的设备」这一个信号。** 不看租约、不看「是否正在输出」。
 * 把它绑在输出状态上意味着任何一处状态判断出错（订阅漏更新、刚撤销租约但设备还在
 * 跑）都会让停止按钮在最需要它的时刻消失。宁可长期显示一个可能停了空设备的按钮。
 *
 * 轮询而不是纯事件驱动，理由同上：`subscribeSafetySessions` 只在模块挂载/卸载时触发，
 * 电量、强度、连接状态的变化不经过它。漏一次更新的代价是用户看到过期的设备状态——
 * 而这正是他们判断「现在安不安全」的依据。
 */

const POLL_MS = 1000;

function useConnectedDevices() {
  const [groups, setGroups] = useState(() => allConnectedDevices());

  useEffect(() => {
    const refresh = () => setGroups(allConnectedDevices());
    const stop = subscribeSafetySessions(refresh);
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, []);

  return groups;
}

const KIND_LABEL: Record<string, string> = {
  coyote: '郊狼',
  opossum: '负鼠',
  'paw-prints': '爪印',
  'civet-edging': '灵狐',
};

function DeviceChip({ device }: { device: DeviceSummary }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 rounded-[10px] bg-[var(--bg-soft)] px-2.5 py-1.5">
      <span
        className={
          'h-1.5 w-1.5 shrink-0 rounded-full ' +
          (device.active ? 'bg-[var(--accent)]' : 'bg-[var(--success)]')
        }
        aria-hidden
      />
      <span className="shrink-0 text-xs font-medium">{KIND_LABEL[device.kind] ?? device.kind}</span>
      <span className="truncate text-xs text-[var(--text-faint)]">{device.name}</span>
      {device.channels?.map((ch) => (
        <span
          key={ch.label}
          className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-soft)]"
        >
          {ch.label}
          {ch.value}
        </span>
      ))}
      {typeof device.battery === 'number' && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-faint)]">
          <BatteryIcon level={device.battery} />
          {device.battery}%
        </span>
      )}
    </div>
  );
}

export function DeviceBar() {
  const groups = useConnectedDevices();
  const [stopping, setStopping] = useState(false);

  if (groups.length === 0) return null;

  const total = groups.reduce((n, g) => n + g.devices.length, 0);

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
      {/* 停止在最左（阅读顺序的最前）。它是这条栏存在的首要理由，不是附属功能。 */}
      <button
        type="button"
        onClick={async () => {
          setStopping(true);
          try {
            await stopAllSafetySessions();
          } finally {
            setStopping(false);
          }
        }}
        className="flex shrink-0 items-center gap-1.5 rounded-[10px] bg-[var(--danger-button)] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--danger-button-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]"
        title={`立刻停止全部输出（${total} 台设备）`}
      >
        <Square className="h-3.5 w-3.5 fill-current" />
        {stopping ? '停止中…' : '停止'}
      </button>

      <div className="flex min-w-0 items-center gap-2">
        {groups.map((g) =>
          g.devices.map((d) => <DeviceChip key={`${g.sessionId}:${d.id}`} device={d} />),
        )}
      </div>
    </div>
  );
}
