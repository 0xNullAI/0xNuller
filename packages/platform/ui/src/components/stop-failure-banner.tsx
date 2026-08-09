import { useSyncExternalStore } from 'react';
import { AlertTriangle } from 'lucide-react';
import { clearStopFailure, stopFailureLabels, subscribeStopFailure } from '../stop-all';

/**
 * Tells the user when a stop did not take.
 *
 * Rendered once by the shell, above everything else. It uses `--z-stop`,
 * the top of the z scale, which existed for exactly this and had no callers:
 * a warning that a device may still be running must not be coverable by a
 * dialog, a drawer, or a toast.
 *
 * Only the user dismisses it. It does not auto-hide on a timer and it does
 * not clear itself on the next successful stop of some other device —
 * disappearing on its own would read as "handled".
 *
 * The copy names the physical action, not the app state, because at this
 * point the app has already failed to help: the software path is what just
 * broke, so the instruction has to be one that does not depend on it.
 */
export function StopFailureBanner() {
  const labels = useSyncExternalStore(subscribeStopFailure, stopFailureLabels, stopFailureLabels);

  if (labels.length === 0) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 flex justify-center px-3 py-2"
      style={{ zIndex: 'var(--z-stop)' }}
    >
      <div className="flex w-full max-w-[560px] flex-col gap-2 rounded-[12px] border border-[var(--danger)] bg-[var(--danger-surface)] p-3 shadow-[var(--shadow-panel)]">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger-button)]" />
          <div className="min-w-0 text-sm text-[var(--text)]">
            <p className="font-semibold">这些设备没有确认停止：{labels.join('、')}</p>
            <p className="mt-1 text-[var(--text-soft)]">
              请立刻手动断开：长按郊狼电源键关机，或者直接拔掉电极线。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={clearStopFailure}
          className="self-end rounded-[10px] border border-[var(--surface-border)] px-3 py-1 text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]"
        >
          我已断开
        </button>
      </div>
    </div>
  );
}
