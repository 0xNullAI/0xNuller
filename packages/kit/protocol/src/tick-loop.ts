/**
 * Shared 100ms tick-loop primitive: runs `callback` roughly every 100ms via
 * a Web Worker timer (immune to a backgrounded tab's `setInterval`
 * throttling) with a plain `setInterval` fallback when Workers aren't
 * available (e.g. some Tauri WebViews, or `new Blob()`/`URL.createObjectURL`
 * unsupported). Guarantees no re-entrant overlap: if `callback` is still
 * running when the next tick fires, that tick is skipped rather than
 * queued or run concurrently.
 *
 * Extracted from `BaseCoyoteProtocolAdapter` (the mechanism was originally
 * inline there) so `OpossumVibrateAdapter`'s vibration-pattern tick can
 * reuse the identical Worker/fallback/reentrancy behavior — both device
 * families need the exact same "keep streaming a B0-shaped packet every
 * 100ms, survive backgrounding, never overlap writes" guarantee.
 */
export class ProtocolTickLoop {
  private worker: Worker | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** No-op if already running (matches the pre-extraction behavior). */
  start(callback: () => Promise<void>): void {
    if (this.worker || this.interval) {
      return;
    }

    const fire = (): void => {
      void this.runOnce(callback);
    };

    try {
      this.worker = this.createWorker();
      this.worker.onmessage = fire;
      this.worker.postMessage('start');
    } catch {
      this.interval = setInterval(fire, 100);
    }
  }

  stop(): void {
    if (this.worker) {
      this.worker.postMessage('stop');
      this.worker.terminate();
      this.worker = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Resolves once any in-flight `callback` invocation has finished. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async runOnce(callback: () => Promise<void>): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await callback();
    } catch {
      // A thrown callback error must not kill the loop — the next tick
      // should still fire. Callers are expected to handle/log their own
      // per-tick failures (e.g. a disconnected GATT write).
    } finally {
      this.inFlight = false;
    }
  }

  private createWorker(): Worker {
    const code =
      'let timer;onmessage=(event)=>{if(event.data==="start"){if(timer)return;timer=setInterval(()=>postMessage(1),100);}else{clearInterval(timer);timer=null;}};';
    const blob = new Blob([code], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }
}
