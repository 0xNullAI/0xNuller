import { loadDeviceSafety } from './device-safety.js';

/**
 * Whether output may keep running while the page is in the background, and for how long.
 *
 * The answer is "stop" unless two things hold: the user picked a keep duration, and the shell
 * declared that this platform can honour it. Android cannot yet — its WebView is suspended in the
 * background, so nothing could stop the device when the time runs out — so its shell never
 * declares support and keeps stopping at once. Every module asks this same function at the same
 * hide event, so the shell's hold and each module's own guard reach the same decision.
 */

let keepSupported = false;

/** Called once by a shell whose background timers keep running (the web shell). */
export function setBackgroundKeepSupported(supported: boolean): void {
  keepSupported = supported;
}

export function isBackgroundKeepSupported(): boolean {
  return keepSupported;
}

/** How long to keep output when the page hides; 0 means stop now. */
export function backgroundKeepMs(): number {
  if (!keepSupported) return 0;
  return loadDeviceSafety().backgroundKeepMinutes * 60_000;
}
