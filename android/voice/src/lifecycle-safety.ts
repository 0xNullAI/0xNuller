/**
 * Android lifecycle safety net.
 *
 * Coyote V3 is state-retentive: once a strength is commanded the device keeps
 * running until a new packet arrives. On Android the WebView is suspended at
 * the host activity's onPause — JS timers stop, no further tick packets go
 * out, and the device keeps running at the last commanded strength. Screen
 * lock is the common case.
 *
 * DG-Voice's shared `CallSafetyGuard` already hangs up and emergency-stops on
 * visibilitychange/pagehide, but it is only armed *during a call*. This layer
 * is deliberately independent of call state: any lifecycle signal zeroes both
 * output devices, whether or not a call is running. On mobile, with a device
 * that can deliver electrical stimulation, "screen off = stop" is the only
 * defensible default — there is intentionally no user setting to disable it.
 *
 * Real background operation would need an Android foreground service; that is
 * out of scope (see CLAUDE.md).
 */

interface EmergencyStoppable {
  emergencyStop(): Promise<void>;
  onStateChanged(listener: (state: { connected: boolean }) => void): () => void;
}

type Stopper = () => Promise<void>;

/**
 * Arms lifecycle listeners that emergency-stop `clients` on every suspend
 * signal. Returns a detach function (unused in practice — the shell arms
 * this once for the process lifetime).
 */
export function attachLifecycleSafety(clients: EmergencyStoppable[]): () => void {
  // Track connectedness per client. Without this guard every lifecycle
  // transition fires emergencyStop() — a harmless no-op when nothing is
  // connected, but actively bad during connect-in-progress: backgrounding
  // the app while plugin-blec's GATT discovery retry loop is mid-flight
  // would write into a half-initialised protocol state.
  const connected = new WeakMap<EmergencyStoppable, boolean>();
  const offState = clients.map((client) =>
    client.onStateChanged((state) => connected.set(client, state.connected)),
  );

  let stopping = false;
  const stop: Stopper = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await Promise.all(
        clients
          .filter((client) => connected.get(client))
          .map((client) => client.emergencyStop().catch(() => undefined)),
      );
    } finally {
      stopping = false;
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void stop();
  };
  const onSuspend = () => void stop();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onSuspend);
  document.addEventListener('freeze', onSuspend);

  let detachTauri: (() => void) | undefined;
  void attachTauriExitListener(stop).then((detach) => {
    detachTauri = detach;
  });

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onSuspend);
    document.removeEventListener('freeze', onSuspend);
    offState.forEach((off) => off());
    detachTauri?.();
  };
}

/**
 * `app://paused` is emitted from the Rust side on ExitRequested (see
 * src-tauri/src/lib.rs) — the WebView can be torn down before `pagehide`
 * lands, so this is a separate path rather than a duplicate of it.
 */
async function attachTauriExitListener(stop: Stopper): Promise<(() => void) | undefined> {
  if (!('__TAURI_INTERNALS__' in window)) return undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen('app://paused', () => void stop());
  } catch {
    return undefined;
  }
}
