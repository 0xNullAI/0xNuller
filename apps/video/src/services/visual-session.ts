import type { LlmImageInput } from '@dg-agent/core';

export const VISUAL_SESSION_MAX_MS = 15 * 60 * 1000;
export const VISUAL_SESSION_MIN_INTERVAL_MS = 5_000;
export const VISUAL_SESSION_MAX_INTERVAL_MS = 30_000;
export const VISUAL_SESSION_MIN_CAPTURE_INTERVAL_MS = 200;
export const VISUAL_SESSION_MAX_CAPTURE_INTERVAL_MS = 5_000;

export type VisualSafetyStopReason =
  | 'pause'
  | 'stop'
  | 'hidden'
  | 'camera-ended'
  | 'device-loss'
  | 'grant-expired'
  | 'watchdog'
  | 'model-failures'
  | 'lease-loss'
  | 'unmount';
export type VisualSessionStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

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
  consecutiveModelFailures: number;
  emergencyLatched: boolean;
  stopReason: VisualSafetyStopReason | 'emergency' | null;
  error: string | null;
}

interface VisualSessionOptions {
  capture: () => Promise<LlmImageInput | undefined>;
  interpret: (frame: LlmImageInput, signal: AbortSignal) => Promise<string>;
  stopAuthorizedTargets?: (reason: VisualSafetyStopReason | 'emergency') => void | Promise<void>;
  onChange: (snapshot: VisualSessionSnapshot) => void;
  now?: () => number;
  watchdogMs?: number | ((cadenceMs: number) => number);
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const INITIAL_SNAPSHOT: VisualSessionSnapshot = {
  status: 'idle',
  steps: 0,
  requestInFlight: false,
  latestFrame: null,
  latestExplanation: '',
  consecutiveModelFailures: 0,
  emergencyLatched: false,
  stopReason: null,
  error: null,
};

/**
 * Latest-value camera scheduler. Capture uses a recursive async timeout (never
 * overlapping); model consumption is single-flight, and a newer frame replaces
 * the one pending behind it. Only frame metadata enters snapshots.
 */
export class VisualSession {
  private snapshot: VisualSessionSnapshot = { ...INITIAL_SNAPSHOT };
  private cadenceMs = VISUAL_SESSION_MIN_INTERVAL_MS;
  private captureIntervalMs = 1_000;
  private deadlineAt = 0;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFrame: LlmImageInput | undefined;
  private captureInFlight = false;
  private captureRequested = false;
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

  start(cadenceMs: number, durationMs = VISUAL_SESSION_MAX_MS, captureIntervalMs = 1_000): void {
    if (this.snapshot.status === 'running') return;
    if (this.snapshot.emergencyLatched) {
      this.snapshot = { ...this.snapshot, error: '紧急停止已锁定，请重新授权后再开始' };
      this.emit();
      return;
    }

    const continuing = this.snapshot.status === 'paused';
    if (!continuing) {
      this.deadlineAt = this.now() + clamp(durationMs, 1_000, VISUAL_SESSION_MAX_MS);
      this.lastRequestAt = Number.NEGATIVE_INFINITY;
      this.snapshot = { ...INITIAL_SNAPSHOT, status: 'running' };
    } else {
      this.snapshot = {
        ...this.snapshot,
        status: 'running',
        stopReason: null,
        error: null,
      };
    }
    this.cadenceMs = clamp(
      cadenceMs,
      VISUAL_SESSION_MIN_INTERVAL_MS,
      VISUAL_SESSION_MAX_INTERVAL_MS,
    );
    this.captureIntervalMs = clamp(
      captureIntervalMs,
      VISUAL_SESSION_MIN_CAPTURE_INTERVAL_MS,
      VISUAL_SESSION_MAX_CAPTURE_INTERVAL_MS,
    );
    this.generation += 1;
    this.emit();
    this.armDeadline();
    this.armWatchdog();
    void this.captureNow();
  }

  pause(): void {
    if (this.snapshot.status !== 'running') return;
    this.halt('paused', 'pause');
  }

  stop(reason: VisualSafetyStopReason = 'stop'): void {
    this.halt(reason === 'stop' || reason === 'unmount' ? 'idle' : 'stopped', reason, {
      reset: reason === 'stop' || reason === 'unmount',
    });
  }

  failSafeStop(reason: Exclude<VisualSafetyStopReason, 'pause' | 'stop' | 'unmount'>): void {
    this.halt('stopped', reason);
  }

  /**
   * Halt capture/inference after the coordinator has directly attempted the
   * target stop. This avoids issuing a second stop through the callback while
   * still invalidating every visual continuation before a selection changes.
   */
  haltAfterExternalStop(
    reason: Exclude<VisualSafetyStopReason, 'pause' | 'stop' | 'unmount'>,
  ): void {
    this.halt('stopped', reason, { requestStop: false });
  }

  emergencyStop(): void {
    this.halt('stopped', 'emergency', { emergencyLatched: true });
  }

  resetEmergencyLatch(): void {
    if (this.snapshot.status === 'running') return;
    this.snapshot = { ...this.snapshot, emergencyLatched: false, stopReason: null, error: null };
    this.emit();
  }

  async captureNow(): Promise<FrameMetadata | null> {
    if (this.captureInFlight) {
      this.captureRequested = true;
      return null;
    }
    const generation = this.generation;
    this.captureInFlight = true;
    try {
      const frame = await this.options.capture();
      if (!frame || generation !== this.generation) return null;
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
      }
      return metadata;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.snapshot = {
        ...this.snapshot,
        status: 'error',
        error: error instanceof Error ? error.message : '采集画面失败',
      };
      this.clearTimers();
      this.abortInference();
      this.requestStop('camera-ended');
      this.emit();
      return null;
    } finally {
      this.captureInFlight = false;
      if (generation === this.generation && this.snapshot.status === 'running') {
        if (this.captureRequested) {
          this.captureRequested = false;
          void this.captureNow();
        } else {
          this.scheduleAutoCapture();
        }
      }
    }
  }

  private processPending(): void {
    if (this.snapshot.status !== 'running' || this.snapshot.requestInFlight || !this.pendingFrame) {
      return;
    }
    if (this.now() >= this.deadlineAt) {
      this.failSafeStop('grant-expired');
      return;
    }

    const delay = Math.max(0, this.cadenceMs - (this.now() - this.lastRequestAt));
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
        this.snapshot = {
          ...this.snapshot,
          latestExplanation,
          consecutiveModelFailures: 0,
          error: null,
        };
        this.armWatchdog();
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        const failures = this.snapshot.consecutiveModelFailures + 1;
        this.snapshot = {
          ...this.snapshot,
          consecutiveModelFailures: failures,
          error: error instanceof Error ? error.message : '视觉分析失败',
        };
        if (failures >= 2) this.failSafeStop('model-failures');
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.controller = null;
        this.snapshot = { ...this.snapshot, requestInFlight: false };
        this.emit();
        if (this.snapshot.status === 'running') this.processPending();
      });
  }

  private scheduleAutoCapture(): void {
    if (this.autoTimer) this.clearTimer(this.autoTimer);
    this.autoTimer = this.setTimer(() => {
      this.autoTimer = null;
      if (this.snapshot.status === 'running') void this.captureNow();
    }, this.captureIntervalMs);
  }

  private armDeadline(): void {
    if (this.deadlineTimer) this.clearTimer(this.deadlineTimer);
    const remaining = Math.max(0, this.deadlineAt - this.now());
    this.deadlineTimer = this.setTimer(() => this.failSafeStop('grant-expired'), remaining);
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) this.clearTimer(this.watchdogTimer);
    const configured = this.options.watchdogMs;
    const timeout =
      typeof configured === 'function'
        ? configured(this.cadenceMs)
        : (configured ?? Math.max(30_000, this.cadenceMs * 3));
    this.watchdogTimer = this.setTimer(() => this.failSafeStop('watchdog'), Math.max(1, timeout));
  }

  private halt(
    status: VisualSessionStatus,
    reason: VisualSafetyStopReason | 'emergency',
    options: { reset?: boolean; emergencyLatched?: boolean; requestStop?: boolean } = {},
  ): void {
    this.generation += 1;
    this.clearTimers();
    this.abortInference();
    this.pendingFrame = undefined;
    this.captureRequested = false;
    this.snapshot = options.reset
      ? {
          ...INITIAL_SNAPSHOT,
          emergencyLatched: options.emergencyLatched ?? this.snapshot.emergencyLatched,
        }
      : {
          ...this.snapshot,
          status,
          requestInFlight: false,
          emergencyLatched: options.emergencyLatched ?? this.snapshot.emergencyLatched,
          stopReason: reason,
        };
    if (options.requestStop !== false) this.requestStop(reason);
    this.emit();
  }

  private abortInference(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private requestStop(reason: VisualSafetyStopReason | 'emergency'): void {
    try {
      void Promise.resolve(this.options.stopAuthorizedTargets?.(reason)).catch(() => undefined);
    } catch {
      // The global safety session reports stop failures; scheduler state must
      // still remain stopped even if a disconnected transport rejects.
    }
  }

  private clearTimers(): void {
    for (const timer of [
      this.autoTimer,
      this.pendingTimer,
      this.deadlineTimer,
      this.watchdogTimer,
    ]) {
      if (timer) this.clearTimer(timer);
    }
    this.autoTimer = null;
    this.pendingTimer = null;
    this.deadlineTimer = null;
    this.watchdogTimer = null;
  }

  private emit(): void {
    this.options.onChange({ ...this.snapshot });
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, normalized));
}
