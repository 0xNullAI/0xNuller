import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { DEFAULT_PLAY_INTERVAL_SEC, toggleQueueEntry, type PlayMode } from '@dg-kit/core';

export { startWaveformId, toggleQueueEntry } from '@dg-kit/core';

/**
 * The per-channel playlist: which waveforms are queued, how they advance, and
 * which one a play press should start with.
 *
 * In Chat the same state lives on the controlled side and is mirrored to the
 * room; here there is no room, so it is plain local state. The two decisions
 * that are easy to get subtly wrong — queue toggling has to keep insertion
 * order, and the start index has to survive a queue that shrank under it — are
 * pure functions so they can be tested without a device.
 */

export const PLAY_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: '10秒' },
  { value: 20, label: '20秒' },
  { value: 30, label: '30秒' },
  { value: 60, label: '1分钟' },
  { value: 120, label: '2分钟' },
  { value: 300, label: '5分钟' },
  { value: 600, label: '10分钟' },
];

const DEFAULT_INTERVAL_SEC = DEFAULT_PLAY_INTERVAL_SEC;

export interface ChannelPlayback {
  queue: string[];
  mode: PlayMode;
  intervalSec: number;
  index: number;
  setMode: (mode: PlayMode) => void;
  setIntervalSec: (seconds: number) => void;
  setIndex: Dispatch<SetStateAction<number>>;
  /** Toggle membership; returns the queue as it will be, for the caller's follow-up command. */
  toggle: (id: string) => string[];
}

export function useChannelPlayback(): ChannelPlayback {
  const [queue, setQueue] = useState<string[]>([]);
  const [mode, setMode] = useState<PlayMode>('single');
  const [intervalSec, setIntervalSec] = useState(DEFAULT_INTERVAL_SEC);
  const [index, setIndex] = useState(0);

  const toggle = useCallback(
    (id: string) => {
      const next = toggleQueueEntry(queue, id);
      setQueue(next);
      return next;
    },
    [queue],
  );

  return { queue, mode, intervalSec, index, setMode, setIntervalSec, setIndex, toggle };
}
