/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startBackgroundOutputController,
  type BackgroundOutputTarget,
  type BackgroundTimer,
} from './background-output.js';

const detaches: (() => void)[] = [];
afterEach(() => {
  while (detaches.length) detaches.pop()!();
});

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function setup(keepMs: () => number) {
  let clock = 1_000;
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const timer: BackgroundTimer = (ms, fire) => {
    const entry = { ms, fire, cancelled: false };
    timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const registry = {
    holdForBackground: vi.fn(),
    stopForBackground: vi.fn(async () => ({ attempted: 1, failed: [] })),
    resumeForeground: vi.fn(),
  } satisfies BackgroundOutputTarget;
  const onStopFailure = vi.fn();
  const controller = startBackgroundOutputController({
    registry,
    keepMs,
    now: () => clock,
    timer,
    onStopFailure,
  });
  detaches.push(controller.dispose);
  return {
    controller,
    registry,
    timers,
    onStopFailure,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('后台输出控制', () => {
  it('未选择保留时，切到后台立即停止', () => {
    const { registry } = setup(() => 0);

    setVisibility('hidden');

    expect(registry.stopForBackground).toHaveBeenCalledWith('background', 1_000);
    expect(registry.holdForBackground).not.toHaveBeenCalled();
  });

  it('选择保留时，保持输出并在到时后停止', () => {
    const { registry, timers, advance } = setup(() => 60_000);

    setVisibility('hidden');
    expect(registry.holdForBackground).toHaveBeenCalledWith(61_000, 1_000);
    expect(registry.stopForBackground).not.toHaveBeenCalled();

    advance(60_000);
    timers[0]!.fire();

    expect(registry.stopForBackground).toHaveBeenCalledWith('background-timeout', 61_000);
  });

  it('到时前回到前台，解除保持且不再停止', () => {
    const { registry, timers, advance } = setup(() => 60_000);

    setVisibility('hidden');
    advance(10_000);
    setVisibility('visible');

    expect(timers[0]!.cancelled).toBe(true);
    expect(registry.resumeForeground).toHaveBeenCalledWith(11_000);
    expect(registry.stopForBackground).not.toHaveBeenCalled();
  });

  it('计时器被推迟时，回到前台先补上停止', () => {
    const { registry, advance } = setup(() => 60_000);

    setVisibility('hidden');
    advance(90_000);
    setVisibility('visible');

    expect(registry.stopForBackground).toHaveBeenCalledWith('background-timeout', 91_000);
    expect(registry.resumeForeground).toHaveBeenCalled();
  });

  it('保留期间离开页面也立即停止', () => {
    const { registry, timers } = setup(() => 60_000);

    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));

    expect(registry.stopForBackground).toHaveBeenCalledWith('leave-page', 1_000);
    expect(timers[0]!.cancelled).toBe(true);
  });

  it('读取保留设置失败时按停止处理', () => {
    const { registry } = setup(() => {
      throw new Error('storage gone');
    });

    setVisibility('hidden');

    expect(registry.stopForBackground).toHaveBeenCalledWith('background', 1_000);
  });

  it('停止没有到达全部设备时报告', async () => {
    const { registry, onStopFailure } = setup(() => 0);
    registry.stopForBackground.mockResolvedValueOnce({
      attempted: 1,
      failed: [{ id: 'coyote/1', error: new Error('gone') }] as never,
    });

    setVisibility('hidden');
    await Promise.resolve();
    await Promise.resolve();

    expect(onStopFailure).toHaveBeenCalled();
  });

  it('原生侧停止（到时、急停）结束保持并记录原因', () => {
    const { controller, registry, timers } = setup(() => 60_000);

    setVisibility('hidden');
    controller.stop('background-timeout', 1_000);

    expect(registry.stopForBackground).toHaveBeenCalledWith('background-timeout', 1_000);
    expect(timers[0]!.cancelled).toBe(true);
    setVisibility('visible');
    expect(registry.resumeForeground).toHaveBeenCalled();
  });

  it('原生侧拒绝保留后，迟到的隐藏事件不再开始保持', () => {
    const { controller, registry } = setup(() => 60_000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });

    controller.stop('background');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(registry.stopForBackground).toHaveBeenCalledTimes(1);
    expect(registry.holdForBackground).not.toHaveBeenCalled();
  });

  it('前台收到原生急停：停止但仍按下次隐藏处理', () => {
    const { controller, registry } = setup(() => 0);
    setVisibility('visible');

    controller.stop('background');
    expect(registry.stopForBackground).toHaveBeenCalledWith('background', 1_000);

    setVisibility('hidden');
    expect(registry.stopForBackground).toHaveBeenCalledTimes(2);
  });

  it('同一次停止不重复记录', () => {
    const { controller, registry, advance } = setup(() => 60_000);

    setVisibility('hidden');
    advance(90_000);
    setVisibility('visible');
    expect(registry.stopForBackground).toHaveBeenCalledWith('background-timeout', 91_000);

    // The native deadline's own report of that same stop arrives after the page is back.
    controller.stop('background-timeout', 61_000);
    expect(registry.stopForBackground).toHaveBeenCalledTimes(1);
  });
});
