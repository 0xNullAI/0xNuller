import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, createElement, useRef, useState } from 'react';
import type { PlayMode, WaveFrame } from '@dg-kit/core';
import {
  nextRotationIndex,
  useChannelRotation,
  type ChannelRotationDevice,
  type ChannelRotationWaveforms,
} from './use-channel-rotation';

const frames: WaveFrame[] = [];
const queue = ['w0', 'w1', 'w2', 'w3'];

function Rotating({
  mode,
  setWave,
  onIndex,
}: {
  mode: PlayMode;
  setWave: ChannelRotationDevice['setWave'];
  onIndex: (index: number) => void;
}) {
  const [index, setIndex] = useState(0);
  onIndex(index);
  const deviceRef = useRef<ChannelRotationDevice>({ connected: true, setWave });
  const waveformsRef = useRef<ChannelRotationWaveforms>({
    getWaveform: (id) => ({ id, name: id, frames }),
  });
  useChannelRotation('A', 'w0', queue, mode, 1, setIndex, deviceRef, waveformsRef, index);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('sends exactly one device command per tick, even under StrictMode', async () => {
  const setWave = vi.fn();
  let shown = -1;
  render(
    createElement(
      StrictMode,
      null,
      createElement(Rotating, { mode: 'list', setWave, onIndex: (i) => (shown = i) }),
    ),
  );
  for (let tick = 1; tick <= 5; tick++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(setWave).toHaveBeenCalledTimes(tick);
    expect(shown).toBe(tick % queue.length);
    expect(setWave).toHaveBeenLastCalledWith('A', frames, queue[shown], true);
  }
});

it('plays the same random wave the playlist then shows', async () => {
  const picks = [0.9, 0.1, 0.6, 0.3];
  let call = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => picks[call++ % picks.length]!);
  const setWave = vi.fn();
  let shown = -1;
  render(
    createElement(
      StrictMode,
      null,
      createElement(Rotating, { mode: 'random', setWave, onIndex: (i) => (shown = i) }),
    ),
  );
  for (let tick = 1; tick <= 4; tick++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(setWave).toHaveBeenCalledTimes(tick);
    expect(setWave).toHaveBeenLastCalledWith('A', frames, queue[shown], true);
  }
});

it('computes the next position without touching React state', () => {
  expect(nextRotationIndex(0, 3, 'list')).toBe(1);
  expect(nextRotationIndex(2, 3, 'list')).toBe(0);
  expect(nextRotationIndex(0, 4, 'random', () => 0.75)).toBe(3);
});
