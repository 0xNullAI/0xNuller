/**
 * Android lifecycle safety net.
 *
 * Coyote V3 is state-retentive: when the BLE link drops or no further B0
 * packets arrive, the device keeps running at its last commanded strength.
 * Browsers are forgiving — even backgrounded tabs keep timers ticking
 * (throttled but alive), so the tick loop writes a fresh B0 every 100 ms
 * and the device stays responsive to a UI stop.
 *
 * Android Tauri is not forgiving. When the user swipes home / locks the
 * screen, the WebView is suspended. setInterval and Workers stop. The
 * device just keeps running until either the user backgrounds long enough
 * for plugin-blec's GATT connection to drop (still: state-retentive), or
 * comes back to the app.
 *
 * This wrapper hooks the DeviceClient with browser + Tauri lifecycle
 * signals and fires `emergencyStop()` on every transition that takes the
 * app off-screen. It is a belt-and-braces: the JS side covers
 * `visibilitychange` / `pagehide` / `freeze`; MainActivity.onPause also
 * dispatches `0xnullai:native-pause` before the WebView is paused, so the stop
 * is issued even when the page events arrive late; and lib.rs emits
 * `app://paused` when the app exits. Independently of all of this, onPause
 * also makes plugin-blec write each device's registered stop packet natively
 * (see `@dg-kit/transport-tauri-blec`'s native-safety), which does not need
 * this page to run at all.
 *
 * The one exception is a background keep the user chose: then the native
 * foreground service decides at onPause whether output is kept (`{kept: true}`
 * in the pause event, and the same answer through `outputKeptInBackground`),
 * and these listeners leave a kept hide alone. Leaving or freezing the page,
 * the Tauri exit event and every native stop (deadline, notification 急停,
 * teardown) still stop.
 */

import type { DeviceClient } from '@dg-agent/core';
import type { DgLabBackgroundStopReason } from '@0xnullai/device-runtime';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import {
  disarmAndroidBackgroundKeep,
  NATIVE_OUTPUT_STOPPED_EVENT,
  NATIVE_PAUSE_EVENT,
  outputKeptInBackground,
  readNativeOutputStopped,
  readNativePause,
  type NativeOutputStoppedDetail,
  type NativePauseDetail,
} from '@0xnullai/native';

interface LifecycleListener {
  detach(): void;
}

/**
 * `TauriBlecDeviceClient` implements `DeviceClient` but also has an extra
 * `connectDevice()` passthrough (for the unified cross-kind picker) that
 * isn't part of the `DeviceClient` interface. Since this wrapper builds its
 * return value as an explicit object literal (deliberately, to avoid the
 * "spreading a class instance drops prototype methods" trap — see
 * `main.tsx`'s `withConnectPermissionHelp` doc comment for the general
 * version of that bug), any method not named here gets silently dropped.
 * `connectDevice` was added to `TauriBlecDeviceClient` after this wrapper
 * was written and wasn't added to the explicit list, so every Coyote
 * connection made through the unified picker failed with "当前环境不支持连接郊狼设备"
 * — the connect path checked the wrapped client, found no `connectDevice`,
 * and refused. Forwarding it here (the shared registry's Tauri transport
 * attaches every picked Coyote through it)
 * when present closes that gap without giving up the explicit-list safety
 * this wrapper relies on elsewhere.
 */
interface ConnectDeviceCapable {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
}

function hasConnectDevice(value: unknown): value is ConnectDeviceCapable {
  return !!value && typeof (value as Partial<ConnectDeviceCapable>).connectDevice === 'function';
}

type Stopper = () => Promise<void>;

export interface LifecycleSafetyOptions {
  /**
   * The keep decision at a hide or pause event. Defaults to the one shared decision
   * (`outputKeptInBackground`, which on Android is the native onPause decision); tests inject it.
   */
  keepInBackground?: () => boolean;
}

function keptNow(keepInBackground: () => boolean): boolean {
  try {
    return keepInBackground();
  } catch {
    // A failing policy read must fail closed.
    return false;
  }
}

interface LifecycleHandlers {
  /** The page hid, or the native layer paused: may be kept. */
  hidden(pause?: NativePauseDetail): void;
  /** The page is leaving or freezing: always stops. */
  leave(): void;
  /** The native layer already stopped output; record it. */
  nativeStopped(detail: NativeOutputStoppedDetail): void;
}

function attachWebListeners(handlers: LifecycleHandlers): LifecycleListener {
  const onHidden = () => {
    if (document.visibilityState === 'hidden') handlers.hidden();
  };
  // pagehide covers iOS Safari / Tauri WebView teardown that doesn't fire
  // visibilitychange. freeze covers Chromium's bfcache eviction.
  const onLeave = () => handlers.leave();
  const onNativePause = (event: Event) => handlers.hidden(readNativePause(event));
  const onNativeStopped = (event: Event) => handlers.nativeStopped(readNativeOutputStopped(event));

  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onLeave);
  document.addEventListener('freeze', onLeave);
  window.addEventListener(NATIVE_PAUSE_EVENT, onNativePause);
  window.addEventListener(NATIVE_OUTPUT_STOPPED_EVENT, onNativeStopped);

  return {
    detach() {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('freeze', onLeave);
      window.removeEventListener(NATIVE_PAUSE_EVENT, onNativePause);
      window.removeEventListener(NATIVE_OUTPUT_STOPPED_EVENT, onNativeStopped);
    },
  };
}

/**
 * Whether a hide or pause keeps output. A native pause keeps only when the native layer said so
 * *and* the shared decision agrees; if the two would ever disagree, it stops.
 */
function keepsOutput(keepInBackground: () => boolean, pause?: NativePauseDetail): boolean {
  if (pause && !pause.kept) return false;
  return keptNow(keepInBackground);
}

/**
 * Subscribe to the Tauri `app://paused` event lib.rs emits when the app
 * exits (`RunEvent::ExitRequested`; Tauri has no stable onPause event). Returns a no-op listener if the @tauri-apps
 * runtime is not present (e.g. browser preview build).
 */
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

/** The registry-level stop: through the shell's background controller, with why and when. */
export type DgLabLifecycleStop = (
  reason?: Extract<DgLabBackgroundStopReason, 'background' | 'background-timeout'>,
  at?: number,
) => void;

/**
 * Attach every off-screen signal (web visibility/pagehide/freeze, the native pause and native
 * stops, plus Tauri `app://paused`) to the shared DG-Lab registry's stop.
 *
 * The registry has no web listeners of its own, and it also owns Opossum links that
 * `wrapWithLifecycleSafety` never covered. Every stop the page decides also disarms the native
 * keep service, so the native side cannot keep what the page stopped.
 */
export async function attachAndroidDgLabLifecycle(
  stop: DgLabLifecycleStop,
  { keepInBackground = outputKeptInBackground }: LifecycleSafetyOptions = {},
): Promise<() => void> {
  const stopHere = (at?: number) => {
    stop('background', at);
    disarmAndroidBackgroundKeep();
  };
  const web = attachWebListeners({
    hidden: (pause) => {
      if (!keepsOutput(keepInBackground, pause)) stopHere(pause?.at);
    },
    leave: () => stopHere(),
    nativeStopped: ({ reason, at }) => stop(reason, at),
  });
  const tauri = await attachTauriListener(async () => stopHere());
  return () => {
    web.detach();
    tauri.detach();
  };
}

/**
 * Wrap a `DeviceClient` so any lifecycle transition that suspends the
 * webview triggers an emergencyStop before suspension takes effect.
 * The returned object is a transparent proxy: every other method is
 * forwarded unchanged.
 */
export function wrapWithLifecycleSafety(
  client: DeviceClient,
  { keepInBackground = outputKeptInBackground }: LifecycleSafetyOptions = {},
): DeviceClient & Partial<ConnectDeviceCapable> {
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
      // Allow the next transition (e.g. resume → backgrounded again) to
      // fire emergencyStop without being suppressed by the previous one.
      stopping = false;
    }
  };

  // Same decision as the registry-level listeners: kept output is left to the registry's hold;
  // leaving, freezing and a native stop always stop this client too.
  const webListener = attachWebListeners({
    hidden: (pause) => {
      if (!keepsOutput(keepInBackground, pause)) void stop();
    },
    leave: () => void stop(),
    nativeStopped: () => void stop(),
  });
  let tauriListener: LifecycleListener | null = null;
  void attachTauriListener(stop).then((l) => {
    tauriListener = l;
  });

  const wrapped: DeviceClient & Partial<ConnectDeviceCapable> = {
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
  if (hasConnectDevice(client)) {
    wrapped.connectDevice = (device, server) => client.connectDevice(device, server);
  }
  return wrapped;
}
