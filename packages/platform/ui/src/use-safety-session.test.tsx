import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  activeSafetySessions,
  hasActiveSafetySession,
  stopAllSafetySessions,
} from '@dg-kit/safety';
import { useSafetySession } from './use-safety-session';

/**
 * 这些测试守的是一个「全绿但功能不存在」的失效模式。
 *
 * 上一版外壳的全局停止按钮从未渲染过——`registerSafetySession` 全仓零调用方，
 * `EmergencyStopButton` 永远走 `return null`。构建、typecheck、lint、单测全绿，
 * 截图里也看不出来（没连设备时它本来就不该出现）。
 *
 * 所以这里断言的是「注册确实发生了」，而不是「注册逻辑正确」。
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

    // 只有一条注册——回调放依赖数组会导致每帧重新注册。
    expect(activeSafetySessions()).toHaveLength(1);

    await act(async () => {
      await stopAllSafetySessions();
    });
    // 调到的必须是最新的那个：注册只发生一次，但 stop 每次渲染都是新函数，
    // 没有 ref 中转的话总线里存的会是第一帧那个永远过期的闭包。
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('isActive 为假时不算活动会话，但仍然注册着', () => {
    render(<Probe active={false} />);
    expect(activeSafetySessions()).toHaveLength(0);
    // 仍在注册表里——stopAll 依然会停它。设备可能已连接只是本模块认为自己没在输出，
    // 漏停比多停危险得多。
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
