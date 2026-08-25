import type { LlmImageInput } from '@dg-agent/core';

export const VISUAL_SESSION_MAX_STEPS = 3;
export const VISUAL_SESSION_MAX_MS = 90_000;
export const VISUAL_SESSION_MIN_INTERVAL_MS = 10_000;

export type VisualSessionStatus = 'idle' | 'running' | 'paused' | 'complete' | 'error';

export interface FrameMetadata {
  capturedAt: number;
  width: number;
  height: number;
  byteLength: number;
}

export interface VisualSessionSnapshot {
  status: VisualSessionStatus;
  steps: number;
  requestInFlight: boolean;
  latestFrame: FrameMetadata | null;
  latestExplanation: string;
  error: string | null;
}

interface VisualSessionOptions {
  capture: () => Promise<LlmImageInput | undefined>;
  interpret: (frame: LlmImageInput, signal: AbortSignal) => Promise<string>;
  onChange: (snapshot: VisualSessionSnapshot) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const INITIAL_SNAPSHOT: VisualSessionSnapshot = {
  status: 'idle',
  steps: 0,
  requestInFlight: false,
  latestFrame: null,
  latestExplanation: '',
  error: null,
};

/**
 * Memory-only scheduler for a short visual session. At most one model request
 * runs at once; captures made while it runs replace the previously queued frame.
 */
export class VisualSession {
  private snapshot: VisualSessionSnapshot = { ...INITIAL_SNAPSHOT };
  private intervalMs = VISUAL_SESSION_MIN_INTERVAL_MS;
  private startedAt = 0;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFrame: LlmImageInput | undefined;
  private captureRequestId = 0;
  private controller: AbortController | null = null;
  private generation = 0;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<VisualSessionOptions['setTimer']>;
  private readonly clearTimer: NonNullable<VisualSessionOptions['clearTimer']>;

  constructor(private readonly options: VisualSessionOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  getSnapshot(): VisualSessionSnapshot {
    return this.snapshot;
  }

  start(intervalMs: number): void {
    if (this.snapshot.status === 'running') return;
    const continuing = this.snapshot.status === 'paused';
    if (!continuing) {
      this.startedAt = this.now();
      this.lastRequestAt = Number.NEGATIVE_INFINITY;
      this.snapshot = { ...INITIAL_SNAPSHOT, status: 'running' };
    } else {
      this.snapshot = { ...this.snapshot, status: 'running', error: null };
    }
    this.intervalMs = Math.max(VISUAL_SESSION_MIN_INTERVAL_MS, intervalMs);
    this.generation += 1;
    this.emit();
    this.armDeadline();
    void this.captureNow();
  }

  pause(): void {
    if (this.snapshot.status !== 'running') return;
    this.generation += 1;
    this.clearTimers();
    this.controller?.abort();
    this.controller = null;
    this.pendingFrame = undefined;
    this.snapshot = { ...this.snapshot, status: 'paused', requestInFlight: false };
    this.emit();
  }

  stop(): void {
    this.generation += 1;
    this.clearTimers();
    this.controller?.abort();
    this.controller = null;
    this.pendingFrame = undefined;
    this.snapshot = { ...INITIAL_SNAPSHOT };
    this.emit();
  }

  async captureNow(): Promise<FrameMetadata | null> {
    const generation = this.generation;
    const captureRequestId = ++this.captureRequestId;
    try {
      const frame = await this.options.capture();
      if (!frame || generation !== this.generation || captureRequestId !== this.captureRequestId)
        return null;
      const metadata = {
        capturedAt: this.now(),
        width: frame.width,
        height: frame.height,
        byteLength: frame.byteLength,
      };
      this.snapshot = { ...this.snapshot, latestFrame: metadata, error: null };
      this.emit();

      if (this.snapshot.status === 'running') {
        this.pendingFrame = frame;
        this.processPending();
        this.scheduleAutoCapture();
      }
      return metadata;
    } catch (error) {
      if (generation !== this.generation || captureRequestId !== this.captureRequestId) return null;
      this.snapshot = {
        ...this.snapshot,
        status: this.snapshot.status === 'running' ? 'error' : this.snapshot.status,
        error: error instanceof Error ? error.message : '采集画面失败',
      };
      this.clearTimers();
      this.emit();
      return null;
    }
  }

  private processPending(): void {
    if (this.snapshot.status !== 'running' || this.snapshot.requestInFlight || !this.pendingFrame)
      return;
    if (
      this.snapshot.steps >= VISUAL_SESSION_MAX_STEPS ||
      this.elapsed() >= VISUAL_SESSION_MAX_MS
    ) {
      this.complete();
      return;
    }

    const delay = Math.max(0, VISUAL_SESSION_MIN_INTERVAL_MS - (this.now() - this.lastRequestAt));
    if (delay > 0) {
      if (this.pendingTimer) this.clearTimer(this.pendingTimer);
      this.pendingTimer = this.setTimer(() => {
        this.pendingTimer = null;
        this.processPending();
      }, delay);
      return;
    }

    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.lastRequestAt = this.now();
    this.snapshot = {
      ...this.snapshot,
      steps: this.snapshot.steps + 1,
      requestInFlight: true,
      error: null,
    };
    this.emit();

    void this.options
      .interpret(frame, controller.signal)
      .then((latestExplanation) => {
        if (generation !== this.generation) return;
        this.snapshot = { ...this.snapshot, latestExplanation };
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.snapshot = {
          ...this.snapshot,
          status: 'error',
          error: error instanceof Error ? error.message : '视觉解释失败',
        };
        this.clearTimers();
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.controller = null;
        this.snapshot = { ...this.snapshot, requestInFlight: false };
        this.emit();
        if (this.snapshot.status !== 'running') return;
        if (this.snapshot.steps >= VISUAL_SESSION_MAX_STEPS) this.complete();
        else this.processPending();
      });
  }

  private scheduleAutoCapture(): void {
    if (this.autoTimer) this.clearTimer(this.autoTimer);
    this.autoTimer = this.setTimer(() => {
      this.autoTimer = null;
      if (this.snapshot.status === 'running') void this.captureNow();
    }, this.intervalMs);
  }

  private armDeadline(): void {
    if (this.deadlineTimer) this.clearTimer(this.deadlineTimer);
    const remaining = Math.max(0, VISUAL_SESSION_MAX_MS - this.elapsed());
    this.deadlineTimer = this.setTimer(() => this.complete(), remaining);
  }

  private elapsed(): number {
    return this.startedAt ? this.now() - this.startedAt : 0;
  }

  private complete(): void {
    this.generation += 1;
    this.clearTimers();
    this.controller?.abort();
    this.controller = null;
    this.pendingFrame = undefined;
    this.snapshot = { ...this.snapshot, status: 'complete', requestInFlight: false };
    this.emit();
  }

  private clearTimers(): void {
    for (const timer of [this.autoTimer, this.pendingTimer, this.deadlineTimer]) {
      if (timer) this.clearTimer(timer);
    }
    this.autoTimer = null;
    this.pendingTimer = null;
    this.deadlineTimer = null;
  }

  private emit(): void {
    this.options.onChange(this.snapshot);
  }
}
