/**
 * Ported from DG-Agent's `BrowserSafetyGuard`, narrowed for a live call: a
 * voice call has no "keep running in background" option the way DG-Agent's
 * output does — leaving the page or backgrounding the tab always hangs up.
 * For a device that can deliver electrical stimulation, "screen off/away =
 * stop" is the correct default, not a configurable tradeoff.
 */
export interface CallSafetyGuardOptions {
  onHangup: (reason: 'leave-page' | 'background-hidden') => void | Promise<void>;
}

export class CallSafetyGuard {
  constructor(private readonly options: CallSafetyGuardOptions) {}

  start(): () => void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return () => undefined;
    }

    let inFlight: Promise<void> | null = null;
    const invokeHangup = (reason: 'leave-page' | 'background-hidden') => {
      if (inFlight) return;
      inFlight = Promise.resolve(this.options.onHangup(reason)).finally(() => {
        inFlight = null;
      });
    };

    const leaveHandler = () => invokeHangup('leave-page');
    const visibilityHandler = () => {
      if (document.visibilityState === 'hidden') invokeHangup('background-hidden');
    };

    window.addEventListener('pagehide', leaveHandler);
    window.addEventListener('beforeunload', leaveHandler);
    document.addEventListener('visibilitychange', visibilityHandler);

    return () => {
      window.removeEventListener('pagehide', leaveHandler);
      window.removeEventListener('beforeunload', leaveHandler);
      document.removeEventListener('visibilitychange', visibilityHandler);
    };
  }
}
