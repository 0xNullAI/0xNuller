import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmImageInput } from '@dg-agent/core';
import {
  VISUAL_SESSION_MAX_MS,
  VisualSession,
  type VisualSessionSnapshot,
} from './visual-session.js';

function frame(data: string): LlmImageInput {
  return { mediaType: 'image/jpeg', data, width: 640, height: 480, byteLength: 100 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VisualSession', () => {
  it('keeps one request in flight and replaces stale queued frames', async () => {
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

    session.start(30_000);
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

  it('aborts and forgets queued image data when paused', async () => {
    const request = deferred<string>();
    let requestSignal: AbortSignal | undefined;
    const interpret = vi.fn((_frame: LlmImageInput, signal: AbortSignal) => {
      requestSignal = signal;
      return request.promise;
    });
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(frame('secret')),
      interpret,
      onChange: vi.fn(),
    });

    session.start(10_000);
    await Promise.resolve();
    session.pause();

    expect(requestSignal?.aborted).toBe(true);
    expect(session.getSnapshot().status).toBe('paused');
    expect(session.getSnapshot().requestInFlight).toBe(false);
  });

  it('completes after at most three interpretation steps', async () => {
    vi.useFakeTimers();
    const interpret = vi.fn().mockResolvedValue('ok');
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(frame('ephemeral')),
      interpret,
      onChange: vi.fn(),
    });

    session.start(10_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(interpret).toHaveBeenCalledTimes(3);
    expect(session.getSnapshot().steps).toBe(3);
    expect(session.getSnapshot().status).toBe('complete');
  });

  it('ends at the 90 second hard deadline', async () => {
    vi.useFakeTimers();
    const session = new VisualSession({
      capture: vi.fn().mockResolvedValue(undefined),
      interpret: vi.fn(),
      onChange: vi.fn(),
    });
    session.start(30_000);
    await vi.advanceTimersByTimeAsync(VISUAL_SESSION_MAX_MS);
    expect(session.getSnapshot().status).toBe('complete');
  });
});
