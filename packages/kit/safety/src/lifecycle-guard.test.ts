/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceLifecycleGuard } from './lifecycle-guard.js';

/**
 * Backgrounding stops output unless the caller explicitly opts into keeping it; leaving the
 * page always stops.
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
  it('切到后台默认停止', () => {
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

  it('调用方选择保留时，切到后台不停止，改为通知保留', () => {
    const onStop = vi.fn();
    const onBackgroundKept = vi.fn();
    const g = new DeviceLifecycleGuard({ onStop, keepInBackground: () => true, onBackgroundKept });
    stops.push(g.start());

    hide();

    expect(onStop).not.toHaveBeenCalled();
    expect(onBackgroundKept).toHaveBeenCalledTimes(1);
  });

  it('保留策略读取失败时按停止处理', () => {
    const onStop = vi.fn();
    const g = new DeviceLifecycleGuard({
      onStop,
      keepInBackground: () => {
        throw new Error('boom');
      },
    });
    stops.push(g.start());

    hide();

    expect(onStop).toHaveBeenCalledWith('background-hidden');
  });

  it('即使选择保留，离开页面也一定停止', () => {
    const onStop = vi.fn();
    const g = new DeviceLifecycleGuard({ onStop, keepInBackground: () => true });
    stops.push(g.start());

    window.dispatchEvent(new Event('pagehide'));

    expect(onStop).toHaveBeenCalledWith('leave-page');
  });
});
