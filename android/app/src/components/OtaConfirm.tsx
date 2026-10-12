import { useEffect } from 'react';
import { otaUpdater } from '../services/ota.js';

const HEALTHY_AFTER_MS = 5_000;

/**
 * Tells the native layer this UI works, so it is kept past probation.
 *
 * Rendered after <Shell/>: if the Shell throws while rendering, React unmounts
 * the tree, this timer is cleared, and the bundle is never confirmed — after a
 * few such starts the native side brings back the previous UI.
 */
export function OtaConfirm({ buildId }: { buildId: string }): null {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!document.getElementById('root')?.childElementCount) return;
      void otaUpdater.confirm(buildId).catch(() => undefined);
    }, HEALTHY_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [buildId]);
  return null;
}
