import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  activeSafetySessions,
  stopAllSafetySessions,
  subscribeSafetySessions,
} from '@dg-kit/safety';
import { Button } from './button';

/**
 * 全局停止锚点。
 *
 * 外壳把它放在常驻位置——模块被切走后会隐藏（保持挂载以免断开 BLE），此时该模块
 * 自己的停止按钮用户点不到，但它的设备**仍在输出**。这个按钮不随模块显隐而消失。
 *
 * 没有任何活动会话时不渲染：一个永远在那儿、按了什么也不会发生的停止按钮，会稀释
 * 它在真正需要时的可信度。
 */
export function EmergencyStopButton({ className }: { className?: string }) {
  const [sessions, setSessions] = useState(() => activeSafetySessions());
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const sync = () => setSessions(activeSafetySessions());
    sync();
    // 会话的活动状态（isActive）不走订阅——它随设备连接变化，这里用低频轮询兜底，
    // 避免要求每个模块在每次状态变化时都通知总线。1 秒对「停止按钮该不该出现」足够。
    const timer = window.setInterval(sync, 1000);
    const off = subscribeSafetySessions(sync);
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, []);

  if (sessions.length === 0) return null;

  const names = sessions.map((s) => s.label).join(' · ');

  return (
    <Button
      variant="destructive"
      size="sm"
      className={className}
      disabled={stopping}
      title={`停止全部输出（${names}）`}
      onClick={async () => {
        setStopping(true);
        try {
          const r = await stopAllSafetySessions();
          if (r.failed.length > 0) {
            // 不吞掉：某个模块没停下来，用户必须知道该去物理断开。
            console.error('[safety] 部分会话未能停止', r.failed);
          }
        } finally {
          setStopping(false);
        }
      }}
    >
      <ShieldAlert className="h-4 w-4" />
      {stopping ? '停止中…' : '停止'}
    </Button>
  );
}
