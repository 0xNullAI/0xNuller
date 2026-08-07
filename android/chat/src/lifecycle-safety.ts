/**
 * Android lifecycle safety net for DG-Chat.
 *
 * Background context (same problem as DG-Agent's lifecycle-safety.ts):
 * Coyote V3 is state-retentive — once a strength is commanded, the device
 * keeps running until a new packet arrives. On Android the WebView is
 * suspended when the host activity hits onPause, JS timers stop, no more
 * tick packets are sent, and the device keeps running at the last
 * commanded strength.
 *
 * DG-Chat already has a `visibilitychange` handler in `useDevice` that
 * calls `stopAll()` when `backgroundBehavior === 'stop'`. This wrapper is
 * a belt-and-braces second layer that fires `emergencyStop()` on every
 * lifecycle signal (visibility, pagehide, freeze, Tauri exit), unconditionally
 * — even if the user chose `backgroundBehavior === 'keep'`. The reasoning:
 *   - The "keep" mode is intended for "still in the room, just looking at
 *     another app for a second" cases. On a phone, switching apps regularly
 *     means the OS may kill the WebView and our BLE connection.
 *   - State-retentive Coyote + suspended JS + dropped BLE = device runs
 *     forever at last strength. That's never the right default on mobile.
 *
 * Users who want true keep-running on Android should be told to use a
 * Foreground Service (future work) — this safety net is intentionally
 * stricter than the web version.
 */

import type { DeviceClient } from '@dg-kit/core';

interface LifecycleListener {
  detach(): void;
}

type Stopper = () => Promise<void>;

function attachWebListeners(stop: Stopper): LifecycleListener {
  const onHidden = () => {
    if (document.visibilityState === 'hidden') {
      void stop();
    }
  };
  const onPageHide = () => {
    void stop();
  };
  const onFreeze = () => {
    void stop();
  };

  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('freeze', onFreeze);

  return {
    detach() {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('freeze', onFreeze);
    },
  };
}

async function attachTauriListener(stop: Stopper): Promise<LifecycleListener> {
  type Unlistener = () => void;
  type TauriEventModule = {
    listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<Unlistener>;
  };

  if (!('__TAURI_INTERNALS__' in window)) {
    return { detach: () => undefined };
  }
  try {
    const mod = (await import('@tauri-apps/api/event')) as unknown as TauriEventModule;
    const offPause = await mod.listen('app://paused', () => {
      void stop();
    });
    return { detach: () => offPause() };
  } catch {
    return { detach: () => undefined };
  }
}

/**
 * Wrap a `DeviceClient` so any lifecycle transition that suspends the
 * webview triggers an emergencyStop before suspension takes effect.
 * The returned object is a transparent proxy: every other method is
 * forwarded unchanged.
 */
export function wrapWithLifecycleSafety(client: DeviceClient): DeviceClient {
  // Track the underlying client's connected state. Without this guard,
  // every lifecycle transition fires `client.emergencyStop()` — a no-op
  // when nothing is connected, but worse during connect-in-progress: if
  // the user backgrounds the app while plugin-blec's GATT discovery
  // retry loop is mid-flight, emergencyStop tries to write into a
  // half-initialised protocol state.
  let connected = false;
  const offState = client.onStateChanged((state) => {
    connected = state.connected;
  });

  let stopping = false;
  const stop: Stopper = async () => {
    if (!connected || stopping) return;
    stopping = true;
    try {
      await client.emergencyStop();
    } catch {
      // Best-effort — the device may already be unreachable. Swallow.
    } finally {
      stopping = false;
    }
  };

  const webListener = attachWebListeners(stop);
  let tauriListener: LifecycleListener | null = null;
  void attachTauriListener(stop).then((l) => {
    tauriListener = l;
  });

  const wrapped: DeviceClient = {
    connect: () => client.connect(),
    disconnect: async () => {
      try {
        await client.disconnect();
      } finally {
        webListener.detach();
        tauriListener?.detach();
        offState();
      }
    },
    execute: (command) => client.execute(command),
    emergencyStop: () => client.emergencyStop(),
    getState: () => client.getState(),
    onStateChanged: (l) => client.onStateChanged(l),
  };
  return wrapped;
}
