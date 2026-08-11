import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { registerSafetySession, type DeviceSummary } from '@dg-kit/safety';
import { DeviceBar } from './DeviceBar';

/**
 * The device bar and the stop button.
 *
 * These are the parts that **cannot be verified without a real device** — Bluetooth
 * cannot be reached from the browser here, so the happy path (device connects → the
 * bar appears → stop is clickable) can only be guarded here. Put the other way
 * round: if these cases break, users on real hardware hit "the device is connected
 * but I cannot find the stop button".
 *
 * The lesson of the previous round was that the global stop button was never
 * rendered while every check stayed green. So what is asserted here is that **it
 * shows up**, not merely that its logic is correct.
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

  it('当前模块未连接时仍常驻顶部，并只提供连接入口', async () => {
    const connect = vi.fn(async () => undefined);
    cleanups.push(
      registerSafetySession({
        id: 'control',
        label: 'Control',
        isActive: () => false,
        stop: vi.fn(),
        devices: () => [],
        connect,
      }),
    );
    render(<DeviceBar activeSessionId="control" />);

    const connectButton = screen.getByRole('button', { name: '连接设备' });
    expect(screen.getAllByRole('button', { name: '连接设备' })).toHaveLength(1);
    expect(connectButton.parentElement?.lastElementChild).toBe(connectButton);
    expect(screen.queryByRole('button', { name: /归零/ })).toBeNull();
    await act(async () => connectButton.click());
    expect(connect).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole('button', { name: '设备安全' })).toBeNull();
  });

  it('不会把后台模块的连接入口显示到当前页面', () => {
    cleanups.push(
      registerSafetySession({
        id: 'control',
        label: 'Control',
        isActive: () => false,
        stop: vi.fn(),
        connect: vi.fn(),
      }),
    );
    const { container } = render(<DeviceBar activeSessionId="market" />);
    expect(container.innerHTML).toBe('');
  });

  it('连上设备后出现，且带停止按钮', () => {
    connectFake('agent', [COYOTE]);
    render(<DeviceBar />);
    expect(screen.getByRole('button', { name: /归零/ })).toBeTruthy();
    expect(screen.queryByText('47L121000')).toBeNull();
    expect(screen.getByText('郊狼')).toBeTruthy();
  });

  it('连接后的设备可从同一顶部横栏断开', async () => {
    const disconnect = vi.fn(async () => undefined);
    cleanups.push(
      registerSafetySession({
        id: 'control',
        label: 'Control',
        isActive: () => true,
        stop: vi.fn(),
        devices: () => [COYOTE],
        disconnect,
      }),
    );
    render(<DeviceBar activeSessionId="control" />);
    await act(async () => screen.getByRole('button', { name: '断开郊狼' }).click());
    expect(disconnect).toHaveBeenCalledWith('coyote');
  });

  it('断开同步抛错时会恢复按钮并在横栏提示', async () => {
    cleanups.push(
      registerSafetySession({
        id: 'control',
        label: 'Control',
        isActive: () => true,
        stop: vi.fn(),
        devices: () => [COYOTE],
        disconnect: () => {
          throw new Error('蓝牙断开失败');
        },
      }),
    );
    render(<DeviceBar activeSessionId="control" />);
    await act(async () => screen.getByRole('button', { name: '断开郊狼' }).click());
    expect(screen.getByRole('alert').textContent).toBe('蓝牙断开失败');
    expect(screen.getByRole('button', { name: '断开郊狼' })).not.toHaveProperty('disabled', true);
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
    expect(screen.queryByText('47L121000')).toBeNull();
    expect(screen.queryByText('负鼠 A')).toBeNull();
    expect(screen.getByText('郊狼')).toBeTruthy();
    expect(screen.getByText('负鼠')).toBeTruthy();
  });

  it('同一个模块的两台郊狼都要出现在栏里', () => {
    // The regression this guards: every Coyote used to report id 'coyote', so
    // both rows produced the same `sessionId:deviceId` key and React rendered
    // only one. The user then had a device attached to them with nothing on
    // screen saying so.
    connectFake('control', [
      { ...COYOTE, id: 'aa:01', name: '郊狼 #1' },
      { ...COYOTE, id: 'aa:02', name: '郊狼 #2', battery: 47 },
    ]);
    render(<DeviceBar />);
    expect(screen.getByText('郊狼 1')).toBeTruthy();
    expect(screen.getByText('郊狼 2')).toBeTruthy();
    expect(screen.queryByText('郊狼 #1')).toBeNull();
    expect(screen.queryByText('郊狼 #2')).toBeNull();
  });

  it('三台设备时每一行的电量跟着自己那台走', () => {
    connectFake('control', [
      { ...COYOTE, id: 'aa:01', name: '郊狼 #1', battery: 82 },
      { ...COYOTE, id: 'aa:02', name: '郊狼 #2', battery: 47 },
      { id: 'op', kind: 'opossum', name: '负鼠', connected: true, battery: 12 },
    ]);
    render(<DeviceBar />);
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getByText('47%')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('正在输出的设备标出「输出中」，空闲的标「待机」', () => {
    connectFake('control', [
      { ...COYOTE, id: 'aa:01', name: '郊狼 #1', active: true },
      { ...COYOTE, id: 'aa:02', name: '郊狼 #2', active: false },
    ]);
    render(<DeviceBar />);
    expect(screen.getByText('输出中')).toBeTruthy();
    expect(screen.getByText('待机')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
  });

  it('设备来自多个模块时标出各自属于哪个模块', () => {
    connectFake('agent', [COYOTE]);
    connectFake('chat', [{ id: 'c2', kind: 'coyote', name: '另一台', connected: true }]);
    render(<DeviceBar />);
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('chat')).toBeTruthy();
  });

  it('只有一个模块时不标模块名', () => {
    connectFake('control', [COYOTE]);
    render(<DeviceBar activeSessionId="control" />);
    expect(screen.queryByText('control')).toBeNull();
  });

  it('切走后仍显示设备，并标明它属于后台哪个模块', () => {
    connectFake('control', [COYOTE]);
    render(<DeviceBar activeSessionId="market" />);
    expect(screen.getByText('郊狼')).toBeTruthy();
    expect(screen.getByText('control')).toBeTruthy();
  });

  it('归零按钮的提示要数上同模块里的每一台', () => {
    connectFake('control', [
      { ...COYOTE, id: 'aa:01' },
      { ...COYOTE, id: 'aa:02' },
      { id: 'op', kind: 'opossum', name: '负鼠', connected: true },
    ]);
    render(<DeviceBar />);
    // If the count came from the number of *modules* rather than devices, a
    // user with three attached devices would read 「1 台设备」 and reasonably
    // conclude the button only covers one of them.
    expect(screen.getByRole('button', { name: /归零/ }).getAttribute('title')).toContain(
      '3 台设备',
    );
  });

  it('未连接的设备不列出', () => {
    connectFake('agent', [COYOTE, { id: 'x', kind: 'opossum', name: '已断开', connected: false }]);
    render(<DeviceBar />);
    expect(screen.queryByText('已断开')).toBeNull();
  });

  it('点归零会停掉全部模块，不只是当前那个', async () => {
    const stopAgent = connectFake('agent', [COYOTE]);
    const stopChat = connectFake('chat', [
      { id: 'c', kind: 'coyote', name: '另一台', connected: true },
    ]);
    render(<DeviceBar />);

    await act(async () => {
      screen.getByRole('button', { name: /归零/ }).click();
    });

    // 「停止」 stops every registered session. If it only stopped the current module,
    // devices belonging to background modules would still be running while the user
    // believes everything has stopped.
    expect(stopAgent).toHaveBeenCalled();
    expect(stopChat).toHaveBeenCalled();
  });

  it('某个模块归零时抛错不影响其余模块', async () => {
    const boom = vi.fn(() => {
      throw new Error('设备已断开');
    });
    connectFake('agent', [COYOTE], boom);
    const stopChat = connectFake('chat', [
      { id: 'c', kind: 'coyote', name: '另一台', connected: true },
    ]);
    render(<DeviceBar />);

    await act(async () => {
      screen.getByRole('button', { name: /归零/ }).click();
    });

    // This is the most dangerous case of all: one device throws because it dropped
    // its connection, and none of the others can be stopped.
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

    // Changes to battery, intensity and connection state do not go through
    // subscribeSafetySessions (it only fires when a module mounts/unmounts), so the
    // device bar has to poll — otherwise the user sees stale device state, and that
    // is exactly what they use to judge whether things are safe right now.
    devices.push(COYOTE);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByRole('button', { name: /归零/ })).toBeTruthy();
    vi.useRealTimers();
  });
});
