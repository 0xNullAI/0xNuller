import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  activeSafetySessions,
  stopAllSafetySessions,
  subscribeSafetySessions,
} from '@dg-kit/safety';
import { Button } from './button';

/**
 * The global stop anchor.
 *
 * The shell keeps it in a persistent spot — a switched-away module is
 * hidden (kept mounted so BLE doesn't drop), its own stop button
 * unreachable while its device is *still outputting*. This button does not
 * come and go with module visibility.
 *
 * Not rendered when no session is active: a stop button that is always
 * there and does nothing when pressed erodes its credibility for the moment
 * it is truly needed.
 */
export function EmergencyStopButton({ className }: { className?: string }) {
  const [sessions, setSessions] = useState(() => activeSafetySessions());
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const sync = () => setSessions(activeSafetySessions());
    sync();
    // isActive is not subscription-driven — it follows device connections,
    // so a low-frequency poll backstops it instead of requiring every
    // module to notify the bus on every change. One second is plenty for
    // "should the stop button show".
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
            // Not swallowed: if a module failed to stop, the user must
            // know to physically disconnect.
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
