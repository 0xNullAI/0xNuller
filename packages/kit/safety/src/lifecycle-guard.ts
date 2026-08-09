/**
 * Stops device output when the page goes away or into the background.
 *
 * There used to be two of these — DG-Agent's `BrowserSafetyGuard` and
 * DG-Voice's `CallSafetyGuard`, near-identical down to the in-flight guard
 * and the listener set. They differed in exactly one way: Agent made
 * "keep running while backgrounded" a user setting, Voice always stopped.
 *
 * This keeps Voice's behavior, for everyone. Screen off or tab away means
 * stop, unconditionally, and there is no option to turn that off — which is
 * also why the two can now be one class without the earlier worry that a
 * wrong default would quietly ship "keeps firing while backgrounded" to a
 * module whose author never chose it.
 *
 * Android already worked this way regardless of the setting (see the shell's
 * lifecycle safety), so the setting was already a lie on the platform where
 * it mattered most.
 */

export type LifecycleStopReason = 'leave-page' | 'background-hidden';

export interface DeviceLifecycleGuardOptions {
  /** Called to stop output. Must be idempotent — the guard may fire more than once. */
  onStop: (reason: LifecycleStopReason) => void | Promise<void>;
}

export class DeviceLifecycleGuard {
  // Not a constructor parameter property: `erasableSyntaxOnly` is on in Chat
  // and the Android shell, and that syntax fails their build with TS1294
  // while typecheck stays green.
  private readonly onStop: DeviceLifecycleGuardOptions['onStop'];

  constructor(options: DeviceLifecycleGuardOptions) {
    this.onStop = options.onStop;
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
      if (document.visibilityState === 'hidden') stop('background-hidden');
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
