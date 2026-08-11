import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  activeSafetySessions,
  hasActiveSafetySession,
  stopAllSafetySessions,
} from '@dg-kit/safety';
import { useSafetySession } from './use-safety-session';

/**
 * These tests guard an "all green but the feature does not exist" failure
 * mode.
 *
 * The previous shell's global stop button never rendered —
 * `registerSafetySession` had zero callers repo-wide, so
 * `EmergencyStopButton` always hit `return null`. Build, typecheck, lint,
 * and unit tests were all green, and screenshots showed nothing wrong
 * (with no device connected it is not supposed to appear anyway).
 *
 * So the assertions here are "registration actually happened", not
 * "registration logic is correct".
 */

afterEach(cleanup);

function Probe({
  id = 'probe',
  active = true,
  stop = () => undefined,
}: {
  id?: string;
  active?: boolean;
  stop?: () => void | Promise<void>;
}) {
  useSafetySession({ id, label: id, isActive: () => active, stop });
  return null;
}

describe('useSafetySession', () => {
  it('挂载即注册，卸载即注销', () => {
    expect(hasActiveSafetySession()).toBe(false);
    const view = render(<Probe />);
    expect(activeSafetySessions().map((s) => s.id)).toEqual(['probe']);
    view.unmount();
    expect(hasActiveSafetySession()).toBe(false);
  });

  it('stopAll 能停到注册进来的模块', async () => {
    const stop = vi.fn();
    render(<Probe stop={stop} />);
    await act(async () => {
      await stopAllSafetySessions();
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('重渲染不会重复注册，也不会留下过期闭包', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Probe stop={first} />);
    view.rerender(<Probe stop={second} />);

    // Exactly one registration — callbacks in the deps array would
    // re-register every frame.
    expect(activeSafetySessions()).toHaveLength(1);

    await act(async () => {
      await stopAllSafetySessions();
    });
    // The latest one must be called: registration happens once, but stop
    // is a new function every render; without the ref indirection the bus
    // would hold the first frame's forever-stale closure.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('isActive 为假时不算活动会话，但仍然注册着', () => {
    render(<Probe active={false} />);
    expect(activeSafetySessions()).toHaveLength(0);
    // Still registered — stopAll will still stop it. The device may be
    // connected while this module merely believes it is not outputting; a
    // missed stop is far more dangerous than an extra one.
    expect(stopAllSafetySessions()).resolves.toMatchObject({ attempted: 1 });
  });

  it('多个模块同时注册时互不覆盖', () => {
    render(
      <>
        <Probe id="agent" />
        <Probe id="chat" />
        <Probe id="voice" />
      </>,
    );
    expect(
      activeSafetySessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['agent', 'chat', 'voice']);
  });
});
