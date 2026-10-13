import type {
  DgLabBackgroundStopReason,
  DgLabConnectionRegistry,
  DgLabDeviceSnapshot,
} from '@0xnullai/device-runtime';
import {
  backgroundKeepMs,
  loadDeviceSafety,
  subscribeDeviceSafety,
  type BackgroundKeepSupport,
} from '@0xnullai/settings';

/**
 * Keeping DG-Lab output in the background on Android.
 *
 * Without a foreground service Android freezes the app in the background, so nothing could end a
 * kept output on time. APKs with native API 3 ship a `connectedDevice` foreground service
 * (`MainActivity.template.kt`) that shows a local 「设备输出中」 notification with 急停, keeps
 * its own deadline and stops output natively through Rust when the time runs out, without the
 * WebView. The page tells it whether keep is armed and whether any output is active; at
 * `onPause` the native side alone decides whether output is kept, and the page reads that one
 * decision (`decideAtHide`). Anything missing — an older APK, a denied notification, no running
 * service — fails closed into today's immediate stop.
 */

/** Dispatched by MainActivity.onPause before the WebView is paused; detail `{kept, until, at}`. */
export const NATIVE_PAUSE_EVENT = '0xnullai:native-pause';
/** Dispatched after the native layer stopped output itself; detail `{reason, at}`. */
export const NATIVE_OUTPUT_STOPPED_EVENT = '0xnullai:native-output-stopped';

/** Oldest native keep service this page can drive (`getBackgroundKeepCapability`). */
const KEEP_CAPABILITY = 1;
/** Android offers 5 or 10 minutes; the native service refuses anything longer. */
const ANDROID_MAX_KEEP_MINUTES = 10;
const POLL_MS = 250;

export interface AndroidBackgroundKeepBridge {
  getBackgroundKeepCapability(): number;
  getNotificationPermissionStatus(): string;
  requestNotificationPermission(): void;
  /** Returns whether the native service is (or is about to be) running for this state. */
  setBackgroundKeep(enabled: boolean, keepMs: number, outputActive: boolean): boolean;
  /** Wall-clock end of the current native keep; 0 unless onPause decided to keep. */
  getBackgroundKeepUntil(): number;
}

export type NotificationPermissionStatus =
  'granted' | 'prompt' | 'requesting' | 'denied' | 'blocked';

const STATUSES = new Set<string>(['granted', 'prompt', 'requesting', 'denied', 'blocked']);
const METHODS = [
  'getBackgroundKeepCapability',
  'getNotificationPermissionStatus',
  'requestNotificationPermission',
  'setBackgroundKeep',
  'getBackgroundKeepUntil',
] as const;

/** The native keep bridge, or null when this APK predates it (or it is not Android at all). */
export function androidBackgroundKeepBridge(
  source: unknown = typeof window === 'undefined'
    ? undefined
    : (window as Window & { AndroidSystem?: unknown }).AndroidSystem,
): AndroidBackgroundKeepBridge | null {
  if (!source || typeof source !== 'object') return null;
  const bridge = source as Partial<Record<(typeof METHODS)[number], unknown>>;
  if (METHODS.some((name) => typeof bridge[name] !== 'function')) return null;
  try {
    const version = (source as AndroidBackgroundKeepBridge).getBackgroundKeepCapability();
    return Number.isInteger(version) && version >= KEEP_CAPABILITY
      ? (source as AndroidBackgroundKeepBridge)
      : null;
  } catch {
    return null;
  }
}

export function readNotificationPermission(
  bridge: AndroidBackgroundKeepBridge,
): NotificationPermissionStatus | null {
  try {
    const status = bridge.getNotificationPermissionStatus();
    return STATUSES.has(status) ? (status as NotificationPermissionStatus) : null;
  } catch {
    return null;
  }
}

export interface RequestNotificationPermissionOptions {
  wait?: (milliseconds: number) => Promise<void>;
  /** How long the system sheet may stay open. */
  timeoutMs?: number;
}

/** Shows the system sheet when it can and waits for the answer; true only when granted. */
export async function requestNotificationPermission(
  bridge: AndroidBackgroundKeepBridge,
  {
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 60_000,
  }: RequestNotificationPermissionOptions = {},
): Promise<boolean> {
  const initial = readNotificationPermission(bridge);
  if (initial === 'granted') return true;
  // Blocked (or switched off for the app): only the system settings can grant it now.
  if (initial === null || initial === 'blocked') return false;
  if (initial !== 'requesting') {
    try {
      bridge.requestNotificationPermission();
    } catch {
      return false;
    }
  }
  for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
    await wait(POLL_MS);
    const status = readNotificationPermission(bridge);
    if (status === 'granted') return true;
    if (status !== 'requesting') return false;
  }
  return false;
}

/** Any connected Coyote or Opossum with a nonzero output level. */
export function isDgLabOutputActive(devices: readonly DgLabDeviceSnapshot[]): boolean {
  return devices.some((device) => {
    if (!device.connected) return false;
    if (device.kind === 'coyote') return device.state.strengthA > 0 || device.state.strengthB > 0;
    if (device.kind === 'opossum') {
      return device.state.intensityA > 0 || device.state.intensityB > 0;
    }
    return false;
  });
}

export interface NativePauseDetail {
  kept: boolean;
  until: number;
  at?: number;
}

/** A malformed or missing detail means "not kept". */
export function readNativePause(event: Event): NativePauseDetail {
  const detail = (event as CustomEvent<unknown>).detail as Partial<NativePauseDetail> | null;
  const at = typeof detail?.at === 'number' && Number.isFinite(detail.at) ? detail.at : undefined;
  const until =
    typeof detail?.until === 'number' && Number.isFinite(detail.until) ? detail.until : 0;
  const kept = detail?.kept === true && until > 0;
  return { kept, until: kept ? until : 0, ...(at === undefined ? {} : { at }) };
}

export interface NativeOutputStoppedDetail {
  reason: Extract<DgLabBackgroundStopReason, 'background' | 'background-timeout'>;
  at?: number;
}

/** The native deadline reports `timeout`; 急停, task removal and teardown are background stops. */
export function readNativeOutputStopped(event: Event): NativeOutputStoppedDetail {
  const detail = (event as CustomEvent<unknown>).detail as {
    reason?: unknown;
    at?: unknown;
  } | null;
  const at = typeof detail?.at === 'number' && Number.isFinite(detail.at) ? detail.at : undefined;
  return {
    reason: detail?.reason === 'timeout' ? 'background-timeout' : 'background',
    ...(at === undefined ? {} : { at }),
  };
}

/**
 * The one keep decision every Android lifecycle listener asks at a hide or pause event. It is the
 * same `backgroundKeepMs()` the shell's controller and each module's guard read, which on Android
 * is the native layer's own `onPause` decision.
 */
export function outputKeptInBackground(): boolean {
  try {
    return backgroundKeepMs() > 0;
  } catch {
    return false;
  }
}

/**
 * The page decided to stop: make sure the native service does not keep anything either. While a
 * native keep runs this also writes every device's stop packet natively.
 */
export function disarmAndroidBackgroundKeep(
  bridge: AndroidBackgroundKeepBridge | null = androidBackgroundKeepBridge(),
): void {
  try {
    bridge?.setBackgroundKeep(false, 0, false);
  } catch {
    // The native onPause path still stops when it was never armed.
  }
}

export interface InstallAndroidBackgroundKeepOptions {
  bridge?: AndroidBackgroundKeepBridge | null;
  now?: () => number;
  requestOptions?: RequestNotificationPermissionOptions;
}

/**
 * Background keep support for the Android shell, and the feed that tells the native service
 * whether keep is armed and whether any output is active. Unsupported without the native bridge.
 */
export function installAndroidBackgroundKeep(
  registry: Pick<DgLabConnectionRegistry, 'list' | 'subscribe'>,
  {
    bridge = androidBackgroundKeepBridge(),
    now = Date.now,
    requestOptions,
  }: InstallAndroidBackgroundKeepOptions = {},
): BackgroundKeepSupport {
  if (!bridge) return { maxMinutes: 0 };
  const granted = () => readNotificationPermission(bridge) === 'granted';
  let permission = granted();
  let sent = '';

  const sync = (force = false) => {
    if (force) permission = granted();
    // Computed here rather than through the settings module: this runs before the shell has
    // registered the support object it returns.
    const minutes = permission
      ? Math.min(loadDeviceSafety().backgroundKeepMinutes, ANDROID_MAX_KEEP_MINUTES)
      : 0;
    const keepMs = minutes > 0 ? minutes * 60_000 : 0;
    const active = isDgLabOutputActive(registry.list());
    const key = `${keepMs}:${active}`;
    if (!force && key === sent) return;
    sent = key;
    try {
      bridge.setBackgroundKeep(keepMs > 0, keepMs, active);
    } catch {
      sent = '';
    }
  };

  // Shell lifetime, like the registry: these subscriptions are never removed.
  registry.subscribe(() => sync());
  subscribeDeviceSafety(() => sync());
  if (typeof document !== 'undefined') {
    // Permission may change in the system settings while the app is away; a native stop may
    // also have cleared the armed state, so resend the whole state on every return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync(true);
    });
  }
  sync(true);

  return {
    maxMinutes: ANDROID_MAX_KEEP_MINUTES,
    ready: granted,
    prepare: async () => {
      const ok = await requestNotificationPermission(bridge, requestOptions);
      sync(true);
      return ok;
    },
    decideAtHide: () => {
      try {
        const until = bridge.getBackgroundKeepUntil();
        return Number.isFinite(until) ? Math.max(0, until - now()) : 0;
      } catch {
        return 0;
      }
    },
    hint: '安卓需要通知权限：后台保持时通知栏显示剩余时间，可在通知里急停。',
  };
}
