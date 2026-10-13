/**
 * Stops device output when the page goes away or into the background.
 *
 * Leaving the page always stops. Going to the background stops too, unless the caller passes
 * `keepInBackground` and it returns true at that moment; then `onBackgroundKept` runs instead
 * and the caller owns what "kept" means (the product shell holds output and times it out).
 * A caller that passes nothing keeps the strict behavior, so no module ever ships "keeps
 * firing while backgrounded" without choosing it.
 */

export type LifecycleStopReason = 'leave-page' | 'background-hidden';

export interface DeviceLifecycleGuardOptions {
  /** Called to stop output. Must be idempotent — the guard may fire more than once. */
  onStop: (reason: LifecycleStopReason) => void | Promise<void>;
  /** Asked when the page hides. True keeps output running; omitted or false stops. */
  keepInBackground?: () => boolean;
  /** Called instead of `onStop` when the page hides and `keepInBackground` returned true. */
  onBackgroundKept?: () => void;
}

export class DeviceLifecycleGuard {
  // Not a constructor parameter property: `erasableSyntaxOnly` is on in Chat
  // and the Android shell, and that syntax fails their build with TS1294
  // while typecheck stays green.
  private readonly onStop: DeviceLifecycleGuardOptions['onStop'];
  private readonly keepInBackground: () => boolean;
  private readonly onBackgroundKept: () => void;

  constructor(options: DeviceLifecycleGuardOptions) {
    this.onStop = options.onStop;
    this.keepInBackground = options.keepInBackground ?? (() => false);
    this.onBackgroundKept = options.onBackgroundKept ?? (() => undefined);
  }

  /** Begin watching. Returns the unsubscribe. */
  start(): () => void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return () => undefined;
    }

    // One stop at a time: pagehide and visibilitychange both fire when a tab
    // is closed, and a second stop landing mid-flight would race the first.
    let inFlight: Promise<void> | null = null;
    const stop = (reason: LifecycleStopReason) => {
      if (inFlight) return;
      inFlight = Promise.resolve(this.onStop(reason)).finally(() => {
        inFlight = null;
      });
    };

    const onLeave = () => stop('leave-page');
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      let keep = false;
      try {
        keep = this.keepInBackground();
      } catch {
        // A failing policy read must fail closed.
      }
      if (keep) this.onBackgroundKept();
      else stop('background-hidden');
    };

    // Both leave events: pagehide is the reliable one on mobile Safari, and
    // beforeunload is what fires on desktop closes.
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }
}
