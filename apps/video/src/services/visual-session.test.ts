import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmImageInput } from '@dg-agent/core';
import { VisualSession, type VisualSessionSnapshot } from './visual-session.js';

function frame(data: string): LlmImageInput {
  return { mediaType: 'image/jpeg', data, width: 640, height: 480, byteLength: 100 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VisualSession latest-frame loop', () => {
  it('keeps one model request in flight and replaces stale queued frames', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const interpret = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue('third');
    const capture = vi
      .fn()
      .mockResolvedValueOnce(frame('first'))
      .mockResolvedValueOnce(frame('second'))
      .mockResolvedValueOnce(frame('third'));
    let snapshot: VisualSessionSnapshot | undefined;
    const session = new VisualSession({
      capture,
      interpret,
      onChange: (next) => (snapshot = next),
    });

    session.start(10_000);
    await vi.runAllTicks();
    await session.captureNow();
    await session.captureNow();
    expect(interpret).toHaveBeenCalledTimes(1);

    first.resolve('first');
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(interpret).toHaveBeenCalledTimes(2);
    expect(interpret.mock.calls[1]?.[0].data).toBe('third');
    expect(snapshot?.requestInFlight).toBe(false);
  });

  it('never overlaps async captures, even when manual and interval ticks coincide', async () => {
    vi.useFakeTimers();
    const firstCapture = deferred<LlmImageInput | undefined>();
    const capture = vi
      .fn()
      .mockImplementationOnce(() => firstCapture.promise)
      .mockResolvedValue(frame('latest'));
    const session = new VisualSession({
      capture,
      interpret: vi.fn().mockResolvedValue('ok'),
      onChange: vi.fn(),
    });

    session.start(10_000);
    const manual = session.captureNow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capture).toHaveBeenCalledTimes(1);

    firstCapture.resolve(frame('first'));
    await manual;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('refreshes the latest frame faster than the model cadence without overlapping inference', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(frame('latest'));
    const interpret = vi.fn().mockResolvedValue('ok');
    const session = new VisualSession({ capture, interpret, onChange: vi.fn() });

    session.start(10_000, 60_000, 200);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(capture.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it('does not retain image bytes in its observable snapshot', async () => {
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(frame('never-persist-this-image')),
      interpret: vi.fn().mockResolvedValue('visible response'),
      onChange: vi.fn(),
    });
    session.start(10_000);
    await Promise.resolve();
    await Promise.resolve();

    const serialized = JSON.stringify(session.getSnapshot());
    expect(serialized).not.toContain('never-persist-this-image');
    expect(serialized).toContain('visible response');
  });
});

describe('VisualSession fail-safe stops', () => {
  it('aborts inference and requests a target stop on pause without awaiting the stop', async () => {
    const request = deferred<string>();
    const stopping = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(frame('ephemeral')),
      interpret: vi.fn((_frame, signal) => {
        requestSignal = signal;
        return request.promise;
      }),
      stopAuthorizedTargets: vi.fn(() => stopping.promise),
      onChange: vi.fn(),
    });

    session.start(10_000);
    await Promise.resolve();
    session.pause();

    expect(requestSignal?.aborted).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ status: 'paused', requestInFlight: false });
    stopping.resolve();
  });

  it('stops authorized targets immediately when the device is lost', async () => {
    const stop = vi.fn();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(undefined),
      interpret: vi.fn(),
      stopAuthorizedTargets: stop,
      onChange: vi.fn(),
    });

    session.start(10_000);
    session.failSafeStop('device-loss');

    expect(session.getSnapshot()).toMatchObject({ status: 'stopped', stopReason: 'device-loss' });
    expect(stop).toHaveBeenCalledWith('device-loss');
  });

  it('halts visual continuations without duplicating a coordinator-owned stop', () => {
    const stop = vi.fn();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(undefined),
      interpret: vi.fn(),
      stopAuthorizedTargets: stop,
      onChange: vi.fn(),
    });

    session.start(10_000);
    session.haltAfterExternalStop('device-loss');

    expect(session.getSnapshot()).toMatchObject({ status: 'stopped', stopReason: 'device-loss' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('watchdog-stops a session with no successful observation', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(undefined),
      interpret: vi.fn(),
      stopAuthorizedTargets: stop,
      watchdogMs: 500,
      onChange: vi.fn(),
    });

    session.start(10_000);
    await vi.advanceTimersByTimeAsync(500);

    expect(session.getSnapshot()).toMatchObject({ status: 'stopped', stopReason: 'watchdog' });
    expect(stop).toHaveBeenCalledWith('watchdog');
  });

  it('stops after two consecutive model failures and resets the counter after success', async () => {
    vi.useFakeTimers();
    const interpret = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));
    const stop = vi.fn();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(frame('ephemeral')),
      interpret,
      stopAuthorizedTargets: stop,
      onChange: vi.fn(),
    });

    session.start(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(interpret).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toMatchObject({
      status: 'stopped',
      stopReason: 'model-failures',
      consecutiveModelFailures: 2,
    });
    expect(stop).toHaveBeenCalledWith('model-failures');
  });

  it('expires at the bounded session deadline', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(undefined),
      interpret: vi.fn(),
      stopAuthorizedTargets: stop,
      watchdogMs: 60_000,
      onChange: vi.fn(),
    });

    session.start(10_000, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(session.getSnapshot().stopReason).toBe('grant-expired');
    expect(stop).toHaveBeenCalledWith('grant-expired');
  });

  it('emergency stop latches and an old inference cannot resume the session', async () => {
    const request = deferred<string>();
    const interpret = vi.fn(() => request.promise);
    const stop = vi.fn();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(frame('ephemeral')),
      interpret,
      stopAuthorizedTargets: stop,
      onChange: vi.fn(),
    });

    session.start(10_000);
    await Promise.resolve();
    session.emergencyStop();
    request.resolve('late result');
    await Promise.resolve();
    session.start(10_000);

    expect(session.getSnapshot()).toMatchObject({
      status: 'stopped',
      emergencyLatched: true,
      stopReason: 'emergency',
    });
    expect(stop).toHaveBeenCalledWith('emergency');

    session.resetEmergencyLatch();
    session.start(10_000);
    expect(session.getSnapshot().status).toBe('running');
  });
});
