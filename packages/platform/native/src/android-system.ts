/**
 * Media permissions and screen wake for modules, over the Android shell's synchronous
 * `AndroidSystem` JavascriptInterface. Each method is feature-detected: APKs older than a method
 * keep their previous behaviour, and the web uses the browser's own APIs.
 */

export type MediaPermissionKind = 'camera' | 'microphone';

/** `blocked` means denied with "don't ask again": only App settings can grant it now. */
export type MediaPermissionStatus = 'granted' | 'prompt' | 'requesting' | 'denied' | 'blocked';

export interface AndroidMediaBridge {
  getMediaPermissionStatus?(kind: MediaPermissionKind): string;
  requestMediaPermission?(kind: MediaPermissionKind): void;
  hasCameraPermission?(): boolean;
  requestCameraPermission?(): void;
  openAppSettings?(): void;
  setKeepScreenOn?(on: boolean): void;
}

const LABEL: Record<MediaPermissionKind, string> = { camera: '摄像头', microphone: '麦克风' };
const STATUSES = new Set<string>(['granted', 'prompt', 'requesting', 'denied', 'blocked']);

export function androidMediaBridge(): AndroidMediaBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { AndroidSystem?: AndroidMediaBridge }).AndroidSystem ?? null;
}

/** A denial the user can only undo in the App's system settings. */
export class MediaPermissionDeniedError extends Error {
  readonly kind: MediaPermissionKind;
  readonly permanent: boolean;

  constructor(kind: MediaPermissionKind, permanent: boolean) {
    super(
      permanent
        ? `${LABEL[kind]}权限已被拒绝，系统不会再弹出授权框。请点「去设置」，在权限中允许${LABEL[kind]}。`
        : `未获得${LABEL[kind]}权限。请点「去设置」，在权限中允许${LABEL[kind]}后重试。`,
    );
    this.name = 'MediaPermissionDeniedError';
    this.kind = kind;
    this.permanent = permanent;
  }
}

/** Reads the native status, or null when the APK predates the method. */
export function readMediaPermissionStatus(
  kind: MediaPermissionKind,
  bridge: AndroidMediaBridge | null = androidMediaBridge(),
): MediaPermissionStatus | null {
  if (typeof bridge?.getMediaPermissionStatus !== 'function') return null;
  try {
    const status = bridge.getMediaPermissionStatus(kind);
    return STATUSES.has(status) ? (status as MediaPermissionStatus) : null;
  } catch {
    return null;
  }
}

/** Whether the shell can open this App's system settings page. */
export function canOpenAppSettings(bridge: AndroidMediaBridge | null = androidMediaBridge()) {
  return typeof bridge?.openAppSettings === 'function';
}

export function openAppSettings(bridge: AndroidMediaBridge | null = androidMediaBridge()): void {
  bridge?.openAppSettings?.();
}

export interface EnsureMediaPermissionOptions {
  bridge?: AndroidMediaBridge | null;
  /** False once the caller no longer wants the result (stopped, unmounted, retried). */
  isCurrent?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  /** How long the system sheet may stay open. */
  timeoutMs?: number;
}

const POLL_MS = 250;

/**
 * Ask Android for a media permission before getUserMedia and wait for the system sheet.
 *
 * Resolves true when granted, false when the caller went away, and throws
 * MediaPermissionDeniedError as soon as the user denies. Off Android it resolves true and lets
 * getUserMedia ask. An APK without the status method falls back to the camera-only check.
 */
export async function ensureAndroidMediaPermission(
  kind: MediaPermissionKind,
  {
    bridge = androidMediaBridge(),
    isCurrent = () => true,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 60_000,
  }: EnsureMediaPermissionOptions = {},
): Promise<boolean> {
  if (!bridge) return true;
  const initial = readMediaPermissionStatus(kind, bridge);
  if (initial === 'granted') return true;
  const attempts = Math.ceil(timeoutMs / POLL_MS);

  if (initial !== null && typeof bridge.requestMediaPermission === 'function') {
    if (initial !== 'requesting') bridge.requestMediaPermission(kind);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isCurrent()) return false;
      const status = readMediaPermissionStatus(kind, bridge);
      if (status === 'granted') return true;
      if (status === 'denied' || status === 'blocked') {
        throw new MediaPermissionDeniedError(kind, status === 'blocked');
      }
      await wait(POLL_MS);
    }
    throw new MediaPermissionDeniedError(kind, false);
  }

  // Older APKs: only the camera has a native request; the WebView asks for the microphone.
  if (
    kind !== 'camera' ||
    typeof bridge.hasCameraPermission !== 'function' ||
    typeof bridge.requestCameraPermission !== 'function'
  ) {
    return true;
  }
  if (bridge.hasCameraPermission()) return true;
  bridge.requestCameraPermission();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isCurrent()) return false;
    if (bridge.hasCameraPermission()) return true;
    await wait(POLL_MS);
  }
  throw new Error('未获得摄像头权限');
}

/**
 * Explain a failed getUserMedia. On Android a refused media permission becomes
 * MediaPermissionDeniedError (with the settings action); everything else is returned unchanged.
 */
export function explainMediaFailure(
  kind: MediaPermissionKind,
  cause: unknown,
  bridge: AndroidMediaBridge | null = androidMediaBridge(),
): unknown {
  if (cause instanceof MediaPermissionDeniedError) return cause;
  const status = readMediaPermissionStatus(kind, bridge);
  if (status === null || status === 'granted' || status === 'requesting') return cause;
  // The WebView just asked: "prompt" here means Android declined without showing a sheet.
  return new MediaPermissionDeniedError(kind, status !== 'denied');
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/**
 * Keep the screen on until the returned release runs. Android uses the window flag; the web
 * uses the Screen Wake Lock API where it exists (best effort, the browser may refuse or drop it).
 */
export function holdScreenAwake(bridge: AndroidMediaBridge | null = androidMediaBridge()) {
  if (typeof bridge?.setKeepScreenOn === 'function') {
    try {
      bridge.setKeepScreenOn(true);
    } catch {
      return () => undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        bridge.setKeepScreenOn?.(false);
      } catch {
        // The flag only applies while this window is visible.
      }
    };
  }

  const wakeLock =
    typeof navigator === 'undefined' ? undefined : (navigator as WakeLockNavigator).wakeLock;
  if (!wakeLock) return () => undefined;
  let released = false;
  let sentinel: WakeLockSentinelLike | null = null;
  const request = () => {
    wakeLock
      .request('screen')
      .then((next) => {
        if (released) void next.release().catch(() => undefined);
        else sentinel = next;
      })
      .catch(() => undefined);
  };
  // Browsers drop the lock when the page is hidden; take it again when it comes back.
  const onVisibility = () => {
    if (!released && document.visibilityState === 'visible') request();
  };
  request();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    if (released) return;
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}
