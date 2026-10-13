import type { DgLabBackgroundStopReason, DgLabStopAllResult } from './dglab-connection-registry.js';

/** The registry calls the controller drives. */
export interface BackgroundOutputTarget {
  holdForBackground(until: number, now?: number): void;
  stopForBackground(reason: DgLabBackgroundStopReason, now?: number): Promise<DgLabStopAllResult>;
  resumeForeground(now?: number): void;
}

/** Runs `callback` once after `ms`; returns the cancel. Must keep firing in a background page. */
export type BackgroundTimer = (ms: number, callback: () => void) => () => void;

export interface BackgroundOutputControllerOptions {
  registry: BackgroundOutputTarget;
  /** How long output may keep running once the page hides; 0 stops at once. Read at each hide. */
  keepMs: () => number;
  now?: () => number;
  timer?: BackgroundTimer;
  /** A stop that did not reach every device. */
  onStopFailure?: () => void;
}

/**
 * The one owner of "the page left the foreground" for every DG-Lab output.
 *
 * Hidden: stop everything, or — when the user chose a keep duration and the platform supports
 * it — hold output at its current level and stop it when the time runs out. Leaving or freezing
 * the page always stops. Visible again: lift the hold, after first stopping if the deadline
 * passed while a throttled timer had not fired yet.
 */
export function startBackgroundOutputController(
  options: BackgroundOutputControllerOptions,
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const now = options.now ?? Date.now;
  const timer = options.timer ?? workerTimer;
  let phase: 'foreground' | 'kept' | 'stopped' = 'foreground';
  let deadline = 0;
  let cancelTimer: (() => void) | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };
  const stop = (reason: DgLabBackgroundStopReason) => {
    clearTimer();
    phase = 'stopped';
    void options.registry.stopForBackground(reason, now()).then(
      (result) => {
        if (result.failed.length > 0) options.onStopFailure?.();
      },
      () => options.onStopFailure?.(),
    );
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (phase !== 'foreground') return;
      let ms = 0;
      try {
        ms = options.keepMs();
      } catch {
        // Fail closed: an unreadable policy stops.
      }
      if (!(ms > 0)) {
        stop('background');
        return;
      }
      phase = 'kept';
      deadline = now() + ms;
      options.registry.holdForBackground(deadline, now());
      cancelTimer = timer(ms, () => {
        if (phase === 'kept') stop('background-timeout');
      });
      return;
    }
    if (phase === 'foreground') return;
    if (phase === 'kept' && now() >= deadline) stop('background-timeout');
    clearTimer();
    phase = 'foreground';
    options.registry.resumeForeground(now());
  };
  const onLeave = () => {
    if (phase === 'stopped') return;
    stop('leave-page');
  };
  const onFreeze = () => {
    if (phase === 'stopped') return;
    stop('background');
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('beforeunload', onLeave);
  document.addEventListener('freeze', onFreeze);
  return () => {
    clearTimer();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onLeave);
    window.removeEventListener('beforeunload', onLeave);
    document.removeEventListener('freeze', onFreeze);
  };
}

/**
 * A one-shot timer in a dedicated Worker: a hidden page's own timers can be delayed by a minute
 * or more, a Worker's are not. Falls back to `setTimeout`; the visible-again check above covers
 * a fallback timer that fired late.
 */
const workerTimer: BackgroundTimer = (ms, callback) => {
  try {
    const code = 'onmessage=(e)=>{setTimeout(()=>postMessage(1),e.data)}';
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const worker = new Worker(url);
    const end = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = () => {
      end();
      callback();
    };
    worker.postMessage(ms);
    return end;
  } catch {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  }
};
