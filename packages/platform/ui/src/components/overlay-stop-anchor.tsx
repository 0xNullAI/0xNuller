import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Square } from 'lucide-react';
import { allConnectedDevices, subscribeSafetySessions } from '@dg-kit/safety';
import { openModalCount, subscribeModalPresence, STOP_ANCHOR_ATTRIBUTE } from '../modal-presence';
import { stopAllDevices } from '../stop-all';

/**
 * The stop control that stays reachable while a modal is open.
 *
 * Dialogs outrank the shell chrome, and a modal Radix dialog additionally sets
 * `pointer-events:none` on <body> and marks everything outside it aria-hidden.
 * With a device connected that turned "stop" into "find and close the dialog,
 * then stop" — two actions, under the exact conditions (a permission prompt,
 * a settings dialog mid-session) where output may be running.
 *
 * So while any blocking surface is open and any device is connected, the shell
 * shows this compact copy of the device bar's stop. It is not a second stop
 * implementation: it calls the same `stopAllDevices`, so failures still land
 * in StopFailureBanner.
 *
 * How it gets past the modal:
 * - it sits at `--z-stop`, above every overlay layer;
 * - it opts back in with `pointer-events:auto`, which beats the inherited
 *   `none` Radix puts on <body>;
 * - its container is always mounted and carries `aria-live="off"`: the
 *   aria-hidden pass Radix runs on open spares `[aria-live]` elements, and a
 *   container that only appeared after the dialog opened would be hidden
 *   with the rest of the page. "off" keeps it from announcing itself;
 * - it is tagged with STOP_ANCHOR_ATTRIBUTE, so Dialog and Sheet do not read
 *   a press here as an outside click that dismisses them.
 */

const POLL_MS = 1000;

function useHasConnectedDevice(enabled: boolean): boolean {
  const [connected, setConnected] = useState(() => allConnectedDevices().length > 0);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setConnected(allConnectedDevices().length > 0);
    refresh();
    // Connection state does not go through the session bus, so poll it like the device bar.
    const timer = window.setInterval(refresh, POLL_MS);
    const off = subscribeSafetySessions(refresh);
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [enabled]);
  return enabled && connected;
}

export function OverlayStopAnchor() {
  const modalOpen =
    useSyncExternalStore(subscribeModalPresence, openModalCount, openModalCount) > 0;
  const visible = useHasConnectedDevice(modalOpen);
  const [stopping, setStopping] = useState(false);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div {...{ [STOP_ANCHOR_ATTRIBUTE]: '' }} aria-live="off">
      {visible && (
        <button
          type="button"
          // Keep focus where it is: a modal's focus trap would otherwise pull it back
          // mid-press, and the dialog underneath should not lose its caret either.
          onMouseDown={(event) => event.preventDefault()}
          onClick={async () => {
            setStopping(true);
            try {
              // Failures surface through StopFailureBanner, same as the device bar.
              await stopAllDevices();
            } finally {
              setStopping(false);
            }
          }}
          className="ui-press fixed flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--danger-button)] px-3 text-[13px] font-semibold text-white shadow-[var(--shadow-panel)] hover:bg-[var(--danger-button-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]"
          style={{
            zIndex: 'var(--z-stop)',
            pointerEvents: 'auto',
            // Same corner as the device bar's stop, so the hand already knows where it is.
            top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
            left: 'calc(env(safe-area-inset-left, 0px) + 8px)',
          }}
          title="立刻停止全部设备输出"
        >
          <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
          {stopping ? '停止中…' : '停止设备'}
        </button>
      )}
    </div>,
    document.body,
  );
}
