import { describe, expect, it, vi } from 'vitest';
import { executeCommand } from './commands';
import type { DeviceCommand } from './protocol';

/**
 * `alert` arrives from another member of the room. It used to call
 * window.alert, which blocks all script and interaction until dismissed —
 * including reaching the stop button, while a device is attached to the
 * user's body.
 *
 * CLAUDE.md's first hard constraint is that stop stays one action away. A
 * remote peer must not be able to take that away.
 */

describe('远程指令：提示', () => {
  it('不再调用会阻塞页面的 window.alert', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    executeCommand({ action: 'alert', d: '来自房间的提示' } as DeviceCommand, {
      device: null,
      notify: () => undefined,
    });

    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('提示内容通过非阻塞回调送出', () => {
    const notify = vi.fn();

    executeCommand({ action: 'alert', d: '来自房间的提示' } as DeviceCommand, {
      device: null,
      notify,
    });

    expect(notify).toHaveBeenCalledWith('来自房间的提示');
  });

  it('没有接收方时安静丢弃，绝不回落到 alert', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    expect(() =>
      executeCommand({ action: 'alert', d: '提示' } as DeviceCommand, { device: null }),
    ).not.toThrow();
    expect(alertSpy).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});
