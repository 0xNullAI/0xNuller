import { BACKGROUND_KEEP_MINUTES, loadDeviceSafety } from './device-safety.js';

/**
 * Whether output may keep running while the page is in the background, and for how long.
 *
 * The answer is "stop" unless the user picked a keep duration and the shell declared that this
 * platform can honour it. Each shell declares its own support once: the web shell up to
 * 30 minutes; the Android shell up to 10 minutes, only when its APK has the native keep service
 * and the user allowed its local "设备输出中" notification. Every module asks this same function
 * at the same hide event, so the shell's hold and each module's own guard reach the same decision.
 */

export interface BackgroundKeepSupport {
  /** The longest keep this platform can honour; 0 means it cannot keep at all. */
  maxMinutes: number;
  /** Whether the platform can keep right now (Android: notification permission). Default: yes. */
  ready?: () => boolean;
  /** Asks for what `ready` needs (Android: the notification permission); resolves to `ready()`. */
  prepare?: () => Promise<boolean>;
  /**
   * The platform's own decision at the hide event, in milliseconds it will keep (0: it stops).
   * When present it is the single source: Android's native layer decides at `onPause` whether
   * its foreground service keeps output, and the page must never hold longer or when it said no.
   */
  decideAtHide?: () => number;
  /** One short line for the settings page about how this platform keeps output. */
  hint?: string;
}

const UNSUPPORTED: BackgroundKeepSupport = Object.freeze({ maxMinutes: 0 });
let support: BackgroundKeepSupport = UNSUPPORTED;

/** Called once by each shell before render. */
export function setBackgroundKeepSupport(next: BackgroundKeepSupport): void {
  const maxMinutes = Number.isFinite(next.maxMinutes) ? Math.max(0, next.maxMinutes) : 0;
  support = maxMinutes > 0 ? { ...next, maxMinutes } : UNSUPPORTED;
}

/** The platform can offer a keep duration at all (the settings page shows the choice). */
export function isBackgroundKeepSupported(): boolean {
  return support.maxMinutes > 0;
}

/** The platform could keep output right now; false fails closed. */
export function isBackgroundKeepReady(): boolean {
  if (!isBackgroundKeepSupported()) return false;
  try {
    return support.ready?.() ?? true;
  } catch {
    return false;
  }
}

/** Asks for whatever the platform needs before it can keep (Android: notification permission). */
export async function prepareBackgroundKeep(): Promise<boolean> {
  if (!isBackgroundKeepSupported()) return false;
  if (isBackgroundKeepReady()) return true;
  try {
    return (await support.prepare?.()) === true && isBackgroundKeepReady();
  } catch {
    return false;
  }
}

/** The keep choices this platform offers, `0` (stop at once) first. */
export function backgroundKeepOptions(): readonly number[] {
  return BACKGROUND_KEEP_MINUTES.filter((minutes) => minutes <= support.maxMinutes);
}

export function backgroundKeepHint(): string | undefined {
  return isBackgroundKeepSupported() ? support.hint : undefined;
}

/** The user's choice, capped by the platform; 0 when the platform cannot keep right now. */
export function effectiveBackgroundKeepMinutes(): number {
  if (!isBackgroundKeepReady()) return 0;
  return Math.min(loadDeviceSafety().backgroundKeepMinutes, support.maxMinutes);
}

/**
 * How long to keep output when the page hides; 0 means stop now. Read at the hide event: with a
 * platform decision it never exceeds what the platform said, and a missing or failing answer
 * stops.
 */
export function backgroundKeepMs(): number {
  const chosen = effectiveBackgroundKeepMinutes() * 60_000;
  if (!(chosen > 0) || !support.decideAtHide) return chosen;
  let decided: number;
  try {
    decided = support.decideAtHide();
  } catch {
    return 0;
  }
  return Number.isFinite(decided) && decided > 0 ? Math.min(decided, chosen) : 0;
}
