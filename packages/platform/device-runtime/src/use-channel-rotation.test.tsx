import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useChannelRotation } from './use-channel-rotation';
import type { ChannelRotationDevice, ChannelRotationWaveforms } from './use-channel-rotation';
import type { PlayMode } from '@dg-kit/core';

function makeDevice(connected = true) {
  const setWave = vi.fn();
  const ref: RefObject<ChannelRotationDevice> = { current: { connected, setWave } };
  return { ref, setWave };
}

function makeWaveforms(ids: string[]): RefObject<ChannelRotationWaveforms> {
  return {
    current: {
      getWaveform: (id: string) =>
        ids.includes(id) ? { id, name: id, frames: [[10, 20] as [number, number]] } : undefined,
    },
  };
}

interface Options {
  waveId?: string | null;
  queue?: string[];
  mode?: PlayMode;
  intervalSec?: number;
  connected?: boolean;
}

function setup(options: Options = {}) {
  const {
    waveId = 'w1',
    queue = ['w1', 'w2', 'w3'],
    mode = 'list',
    intervalSec = 30,
    connected = true,
  } = options;
  const device = makeDevice(connected);
  const waveforms = makeWaveforms(queue);
  const setIndex = vi.fn();
  // The real caller keeps the index in state; mirror that so the functional
  // updater is exercised the same way it is in the app.
  let index = 0;
  setIndex.mockImplementation((updater: (prev: number) => number) => {
    index = updater(index);
  });

  const view = renderHook(() =>
    useChannelRotation('A', waveId, queue, mode, intervalSec, setIndex, device.ref, waveforms),
  );
  return { ...view, setWave: device.setWave, deviceRef: device.ref, indexOf: () => index };
}

describe('useChannelRotation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('列表模式按间隔依次切到下一条波形', () => {
    const { setWave, indexOf } = setup({ mode: 'list', intervalSec: 30 });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(indexOf()).toBe(1);
    expect(setWave).toHaveBeenCalledWith('A', [[10, 20]], 'w2', true);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(indexOf()).toBe(2);
    expect(setWave).toHaveBeenLastCalledWith('A', [[10, 20]], 'w3', true);
  });

  it('列表模式走到队尾后回到第一条', () => {
    const { setWave, indexOf } = setup({ mode: 'list', queue: ['w1', 'w2'], intervalSec: 10 });

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(indexOf()).toBe(0);
    expect(setWave).toHaveBeenLastCalledWith('A', [[10, 20]], 'w1', true);
  });

  it('间隔未到之前不切换', () => {
    const { setWave } = setup({ intervalSec: 60 });

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(setWave).not.toHaveBeenCalled();
  });

  it('单曲循环不启动定时器', () => {
    const { setWave } = setup({ mode: 'single' });

    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(setWave).not.toHaveBeenCalled();
  });

  it('队列只有一条时不启动定时器', () => {
    const { setWave } = setup({ mode: 'list', queue: ['w1'] });

    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(setWave).not.toHaveBeenCalled();
  });

  it('通道没有在播放时不启动定时器', () => {
    // waveId 为 null 表示这个通道当前没在放，轮换不该把它叫醒。
    const { setWave } = setup({ waveId: null });

    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(setWave).not.toHaveBeenCalled();
  });

  it('设备断开时推进下标但不下发指令', () => {
    const { setWave, indexOf } = setup({ connected: false, intervalSec: 10 });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(indexOf()).toBe(1);
    expect(setWave).not.toHaveBeenCalled();
  });

  it('随机模式仍然只落在队列内', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { setWave } = setup({ mode: 'random', queue: ['w1', 'w2', 'w3'], intervalSec: 10 });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // 0.99 * 3 向下取整是 2，即队列最后一条，不会越界。
    expect(setWave).toHaveBeenCalledWith('A', [[10, 20]], 'w3', true);
    random.mockRestore();
  });

  it('卸载后不再继续切换', () => {
    const { setWave, unmount } = setup({ intervalSec: 10 });
    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(setWave).not.toHaveBeenCalled();
  });
});
