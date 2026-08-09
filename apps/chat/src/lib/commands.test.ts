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

/**
 * Multi-device routing.
 *
 * A session can hold a Coyote, an Opossum and a sensor at once. Three of
 * these commands assumed the Coyote was the only thing that could be
 * attached, and the stop one is a safety defect: it bailed out when no
 * Coyote was present, so 归零 on an Opossum-only session did nothing while
 * the device was running.
 */
describe('多设备指令路由', () => {
  function session(over: Record<string, unknown> = {}) {
    return {
      opossumConnected: true,
      sensorConnected: false,
      setOpossumIntensity: vi.fn(),
      opossumBurst: vi.fn(),
      opossumStop: vi.fn(),
      setLedColor: vi.fn(),
      ...over,
    } as never;
  }

  it('只连负鼠时，停止依然要停到负鼠', () => {
    const s = session();
    const result = executeCommand({ action: 'stop' } as DeviceCommand, {
      device: null,
      session: s,
    });

    expect((s as unknown as { opossumStop: ReturnType<typeof vi.fn> }).opossumStop)
      .toHaveBeenCalled();
    expect(result).toBe('已停止所有输出');
  });

  it('什么都没连才报未连接', () => {
    const result = executeCommand({ action: 'stop' } as DeviceCommand, {
      device: null,
      session: session({ opossumConnected: false }),
    });
    expect(result).toBe('未连接蓝牙设备');
  });

  it('脉冲不再谎报成功', () => {
    // It used to return 「脉冲已发送」 having called nothing.
    const result = executeCommand({ action: 'burst', c: 'A', v: 30 } as DeviceCommand, {
      device: null,
      session: session(),
    });
    expect(result).not.toContain('已发送');
  });

  it('灯光目标不明时拒绝，而不是写到传感器上', () => {
    const s = session({ sensorConnected: true });
    const result = executeCommand({ action: 'set_led', color: 3 } as DeviceCommand, {
      device: null,
      session: s,
    });

    expect((s as unknown as { setLedColor: ReturnType<typeof vi.fn> }).setLedColor)
      .not.toHaveBeenCalled();
    expect(result).toBe('未知的灯光目标');
  });

  it('明确指定负鼠时写到负鼠', () => {
    const s = session();
    executeCommand({ action: 'set_led', color: 3, kind: 'opossum' } as DeviceCommand, {
      device: null,
      session: s,
    });

    expect((s as unknown as { setLedColor: ReturnType<typeof vi.fn> }).setLedColor)
      .toHaveBeenCalledWith('opossum', 3);
  });
});
