import { useCallback, useState } from 'react';
import { DEFAULT_PLAY_INTERVAL_SEC, toggleQueueEntry, type PlayMode } from '@dg-kit/core';

export interface DevicePlayback {
  queue: string[];
  mode: PlayMode;
  intervalSec: number;
  index: number;
  setMode: (mode: PlayMode) => void;
  setIntervalSec: (seconds: number) => void;
  setIndex: (index: number | ((current: number) => number)) => void;
  toggle: (id: string) => string[];
}

type Stored = Omit<DevicePlayback, 'setMode' | 'setIntervalSec' | 'setIndex' | 'toggle'>;
const blank = (): Stored => ({
  queue: [],
  mode: 'single',
  intervalSec: DEFAULT_PLAY_INTERVAL_SEC,
  index: 0,
});

/** Independent playlist state for each physical output and channel. */
export function useDevicePlayback() {
  const [stored, setStored] = useState<Record<string, { A: Stored; B: Stored }>>({});

  const get = useCallback(
    (targetId: string | null, channel: 'A' | 'B'): DevicePlayback => {
      const id = targetId ?? '__none__';
      const current = stored[id]?.[channel] ?? blank();
      const update = (fn: (value: Stored) => Stored) =>
        setStored((all) => {
          const pair = all[id] ?? { A: blank(), B: blank() };
          return { ...all, [id]: { ...pair, [channel]: fn(pair[channel]) } };
        });
      return {
        ...current,
        setMode: (mode) => update((value) => ({ ...value, mode })),
        setIntervalSec: (intervalSec) => update((value) => ({ ...value, intervalSec })),
        setIndex: (index) =>
          update((value) => ({
            ...value,
            index: typeof index === 'function' ? index(value.index) : index,
          })),
        toggle: (waveformId) => {
          const next = toggleQueueEntry(current.queue, waveformId);
          update((value) => ({ ...value, queue: next }));
          return next;
        },
      };
    },
    [stored],
  );

  return { get };
}
