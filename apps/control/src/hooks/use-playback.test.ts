import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { startWaveformId, toggleQueueEntry, useChannelPlayback } from './use-playback';

describe('toggleQueueEntry', () => {
  it('不在队列里就加到末尾', () => {
    expect(toggleQueueEntry(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('已经在队列里就移除', () => {
    expect(toggleQueueEntry(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('保持加入顺序——序号角标和列表循环都按这个顺序走', () => {
    let queue: string[] = [];
    for (const id of ['c', 'a', 'b']) queue = toggleQueueEntry(queue, id);
    expect(queue).toEqual(['c', 'a', 'b']);
  });

  it('不修改传入的队列', () => {
    const queue = ['a'];
    toggleQueueEntry(queue, 'b');
    expect(queue).toEqual(['a']);
  });
});

describe('startWaveformId', () => {
  it('空队列没有可播放的波形', () => {
    expect(startWaveformId([], 0)).toBeNull();
  });

  it('从当前下标开始播放', () => {
    expect(startWaveformId(['a', 'b', 'c'], 1)).toBe('b');
  });

  it('下标越界时绕回队列内，而不是什么都不播', () => {
    // 队列被删短之后下标会留在原地，这时候必须仍然能启动。
    expect(startWaveformId(['a', 'b'], 4)).toBe('a');
    expect(startWaveformId(['a', 'b'], 5)).toBe('b');
  });

  it('负数下标也能落回队列内', () => {
    expect(startWaveformId(['a', 'b', 'c'], -1)).toBe('c');
  });
});

describe('useChannelPlayback', () => {
  it('初始是空队列、单曲循环、30 秒', () => {
    const { result } = renderHook(() => useChannelPlayback());
    expect(result.current.queue).toEqual([]);
    expect(result.current.mode).toBe('single');
    expect(result.current.intervalSec).toBe(30);
    expect(result.current.index).toBe(0);
  });

  it('toggle 同时更新状态并把新队列返回给调用方', () => {
    const { result } = renderHook(() => useChannelPlayback());
    let returned: string[] = [];
    act(() => {
      returned = result.current.toggle('w1');
    });
    // 调用方要立刻拿到新队列来决定要不要马上切过去，等下一次渲染就晚了。
    expect(returned).toEqual(['w1']);
    expect(result.current.queue).toEqual(['w1']);
  });

  it('再次 toggle 会把波形移出队列', () => {
    const { result } = renderHook(() => useChannelPlayback());
    act(() => {
      result.current.toggle('w1');
    });
    act(() => {
      result.current.toggle('w1');
    });
    expect(result.current.queue).toEqual([]);
  });

  it('播放模式与间隔可以分别设置', () => {
    const { result } = renderHook(() => useChannelPlayback());
    act(() => {
      result.current.setMode('random');
      result.current.setIntervalSec(600);
    });
    expect(result.current.mode).toBe('random');
    expect(result.current.intervalSec).toBe(600);
  });
});
