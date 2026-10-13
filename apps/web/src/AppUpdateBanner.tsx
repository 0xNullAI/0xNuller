import { RefreshCw } from 'lucide-react';
import { stopThenReload, useAppUpdate } from './app-update';

/**
 * Offers the reload a new deployment needs, instead of forcing it.
 *
 * The person decides when: mid-call or mid-session they can finish first. Pressing it
 * stops every device and reloads only after the stop is confirmed.
 */
export function AppUpdateBanner() {
  const update = useAppUpdate();
  if (update.status === 'current') return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] flex justify-center px-3 md:bottom-4"
      style={{ zIndex: 'var(--z-toast)', pointerEvents: 'none' }}
    >
      <div
        className="flex max-w-[520px] items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm shadow-[var(--shadow-panel)]"
        style={{ pointerEvents: 'auto' }}
      >
        <p className="min-w-0 flex-1 text-[var(--text)]">
          {update.status === 'stop-failed'
            ? '设备未确认停止，暂不重新加载。请先手动断开设备。'
            : '猫愿已更新，重新加载后才能打开新页面。重新加载前会先停止设备。'}
        </p>
        <button
          type="button"
          disabled={update.status === 'stopping'}
          onClick={() => void stopThenReload()}
          className="ui-press flex shrink-0 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--button-text)] disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {update.status === 'stopping' ? '正在停止设备…' : '重新加载'}
        </button>
      </div>
    </div>
  );
}
