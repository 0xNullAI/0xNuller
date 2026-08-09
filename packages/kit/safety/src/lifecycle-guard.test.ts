/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceLifecycleGuard } from './lifecycle-guard.js';

/**
 * The merged guard keeps the stricter of the two it replaced: backgrounding
 * always stops output, with no setting to turn it off. Agent used to make
 * that configurable; Android ignored the setting anyway.
 */

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

function guard(onStop: (reason: string) => void) {
  const g = new DeviceLifecycleGuard({ onStop });
  stops.push(g.start());
}

function hide() {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('设备生命周期安全网', () => {
  it('切到后台就停止——没有「继续运行」这个选项', () => {
    const onStop = vi.fn();
    guard(onStop);

    hide();

    expect(onStop).toHaveBeenCalledWith('background-hidden');
  });

  it('离开页面就停止', () => {
    const onStop = vi.fn();
    guard(onStop);

    window.dispatchEvent(new Event('pagehide'));

    expect(onStop).toHaveBeenCalledWith('leave-page');
  });

  it('同时触发的两个事件只停一次', () => {
    const onStop = vi.fn(() => new Promise<void>(() => undefined));
    guard(onStop);

    window.dispatchEvent(new Event('pagehide'));
    hide();

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('取消订阅后不再触发', () => {
    const onStop = vi.fn();
    const g = new DeviceLifecycleGuard({ onStop });
    g.start()();

    window.dispatchEvent(new Event('pagehide'));

    expect(onStop).not.toHaveBeenCalled();
  });
});
