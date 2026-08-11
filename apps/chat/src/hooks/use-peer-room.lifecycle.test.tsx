import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectRoom, type RoomConnectOptions } from '../lib/room-transport';
import { usePeerRoom } from './use-peer-room';

vi.mock('../lib/room-transport', () => ({
  connectRoom: vi.fn(),
}));

let connection: RoomConnectOptions | null;
const send = vi.fn();
const close = vi.fn();

describe('房间 Hook 生命周期', () => {
  beforeEach(() => {
    connection = null;
    send.mockReset();
    close.mockReset();
    vi.mocked(connectRoom).mockImplementation((options) => {
      connection = options;
      return { send, close };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('房间状态更新不会改变 App 依赖的稳定能力', () => {
    const view = renderHook(({ name }) => usePeerRoom(name), {
      initialProps: { name: '甲' },
    });
    const first = {
      notifyLocal: view.result.current.notifyLocal,
      setCommandHandler: view.result.current.setCommandHandler,
      setWaveformHandler: view.result.current.setWaveformHandler,
      sendMessage: view.result.current.sendMessage,
      sendCommand: view.result.current.sendCommand,
      broadcastStateFast: view.result.current.broadcastStateFast,
      broadcastStateSlow: view.result.current.broadcastStateSlow,
    };

    view.rerender({ name: '乙' });
    act(() => view.result.current.notifyLocal('状态更新'));

    expect(view.result.current).toMatchObject(first);
  });

  it('连接状态变化后仍由最近注册的命令处理器接收消息', () => {
    const firstHandler = vi.fn();
    const latestHandler = vi.fn();
    const view = renderHook(() => usePeerRoom('测试者'));

    act(() => {
      view.result.current.setCommandHandler(firstHandler);
      view.result.current.join('room-1');
    });
    act(() => {
      connection?.onStatus('connected');
      view.result.current.setCommandHandler(latestHandler);
      connection?.onMessage({ t: 'cmd', _from: 'peer-1', a: 'stop' });
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(latestHandler).toHaveBeenCalledWith({ action: 'stop' }, 'peer-1');

    view.unmount();
  });
});
