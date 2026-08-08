import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { registerSafetySession, type DeviceSummary } from '@dg-kit/safety';
import { DeviceBar } from './DeviceBar';

/**
 * 设备栏与停止按钮。
 *
 * 这些是**没有真设备就验不了**的那部分——浏览器里连不上蓝牙，所以正向情形（连上
 * 设备 → 栏出现 → 停止可点）只能在这里守住。反过来说，如果这几条挂了，真机上
 * 用户就会遇到「设备连着但找不到停止按钮」。
 *
 * 上一轮的教训是全局停止按钮从未渲染过而所有检查全绿。所以这里断言的是**它出现了**，
 * 不只是它的逻辑正确。
 */

const cleanups: (() => void)[] = [];

function connectFake(id: string, devices: DeviceSummary[], stop = vi.fn()) {
  cleanups.push(
    registerSafetySession({
      id,
      label: id,
      isActive: () => devices.length > 0,
      stop,
      devices: () => devices,
    }),
  );
  return stop;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  cleanup();
});

const COYOTE: DeviceSummary = {
  id: 'coyote',
  kind: 'coyote',
  name: '47L121000',
  connected: true,
  battery: 82,
  channels: [
    { label: 'A', value: 12, max: 50 },
    { label: 'B', value: 0, max: 50 },
  ],
};

describe('设备栏', () => {
  it('没有设备时整条不渲染', () => {
    const { container } = render(<DeviceBar />);
    expect(container.innerHTML).toBe('');
  });

  it('连上设备后出现，且带停止按钮', () => {
    connectFake('agent', [COYOTE]);
    render(<DeviceBar />);
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();
    expect(screen.getByText('47L121000')).toBeTruthy();
    expect(screen.getByText('郊狼')).toBeTruthy();
  });

  it('显示电量与通道强度', () => {
    connectFake('agent', [COYOTE]);
    render(<DeviceBar />);
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getByText('A12')).toBeTruthy();
  });

  it('多个模块的设备一起列出', () => {
    connectFake('agent', [COYOTE]);
    connectFake('chat', [{ id: 'op', kind: 'opossum', name: '负鼠 A', connected: true }]);
    render(<DeviceBar />);
    expect(screen.getByText('47L121000')).toBeTruthy();
    expect(screen.getByText('负鼠 A')).toBeTruthy();
  });

  it('未连接的设备不列出', () => {
    connectFake('agent', [COYOTE, { id: 'x', kind: 'opossum', name: '已断开', connected: false }]);
    render(<DeviceBar />);
    expect(screen.queryByText('已断开')).toBeNull();
  });

  it('点停止会停掉全部模块，不只是当前那个', async () => {
    const stopAgent = connectFake('agent', [COYOTE]);
    const stopChat = connectFake('chat', [
      { id: 'c', kind: 'coyote', name: '另一台', connected: true },
    ]);
    render(<DeviceBar />);

    await act(async () => {
      screen.getByRole('button', { name: /停止/ }).click();
    });

    // 「停止」停的是所有已注册会话。只停当前模块的话，后台模块的设备还在输出，
    // 而用户以为自己已经全停了。
    expect(stopAgent).toHaveBeenCalled();
    expect(stopChat).toHaveBeenCalled();
  });

  it('某个模块停止时抛错不影响其余模块', async () => {
    const boom = vi.fn(() => {
      throw new Error('设备已断开');
    });
    connectFake('agent', [COYOTE], boom);
    const stopChat = connectFake('chat', [
      { id: 'c', kind: 'coyote', name: '另一台', connected: true },
    ]);
    render(<DeviceBar />);

    await act(async () => {
      screen.getByRole('button', { name: /停止/ }).click();
    });

    // 这正是最危险的情形：一台设备断连报错，其余的一个都停不了。
    expect(stopChat).toHaveBeenCalled();
  });

  it('设备状态变化会被轮询到', async () => {
    vi.useFakeTimers();
    const devices: DeviceSummary[] = [];
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => devices.length > 0,
        stop: vi.fn(),
        devices: () => devices,
      }),
    );
    const { container } = render(<DeviceBar />);
    expect(container.innerHTML).toBe('');

    // 电量、强度、连接状态的变化都不经过 subscribeSafetySessions（它只在模块挂载/
    // 卸载时触发），所以设备栏必须轮询——否则用户看到的是过期的设备状态，而那正是
    // 他们判断「现在安不安全」的依据。
    devices.push(COYOTE);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();
    vi.useRealTimers();
  });
});
