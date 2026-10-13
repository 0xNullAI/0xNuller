import { useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { PlayMode, WaveFrame } from '@dg-kit/core';

/**
 * Playlist rotation for one channel.
 *
 * Lifted out of Chat's App.tsx, where it was a private function, because
 * Control needs the identical behavior: rotation is a property of "a channel
 * playing a queue", not of "a room". Whoever owns the device is the one that
 * rotates on a timer — Chat rotates on the controlled side because that is
 * where the source of truth lives, and in Control that side is simply the
 * only side.
 *
 * The device and the waveform library arrive as refs on purpose. Both objects
 * get a new identity on every render of the owner; putting them in the deps
 * would tear down and restart the interval constantly, so a 5-minute rotation
 * would never actually fire.
 */

export interface ChannelRotationDevice {
  connected: boolean;
  setWave: (channel: 'A' | 'B', frames: WaveFrame[], id: string, loop: boolean) => void;
}

export interface ChannelRotationWaveforms {
  getWaveform: (id: string) => { id: string; name: string; frames: WaveFrame[] } | undefined;
}

/** The playlist position after `current`. Random mode may repeat; sequential wraps. */
export function nextRotationIndex(
  current: number,
  length: number,
  mode: PlayMode,
  random: () => number = Math.random,
): number {
  return mode === 'random' ? Math.floor(random() * length) : (current + 1) % length;
}

/**
 * `index` is the channel's current playlist position. Pass it: the next wave is then
 * chosen once, outside any state updater, and the device command goes out exactly once
 * per tick. Without it the hook falls back to choosing inside the `setIndex` updater,
 * which React may run more than once (StrictMode, or a rebased concurrent update) —
 * each run sends a command, and in random mode a replay can play a different wave than
 * the one the UI ends up showing.
 */
export function useChannelRotation(
  channel: 'A' | 'B',
  waveId: string | null,
  queue: string[],
  mode: PlayMode,
  intervalSec: number,
  setIndex: Dispatch<SetStateAction<number>>,
  deviceRef: RefObject<ChannelRotationDevice>,
  waveformsRef: RefObject<ChannelRotationWaveforms>,
  index?: number,
) {
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    if (waveId == null || queue.length <= 1 || mode === 'single') return;
    const play = (next: number) => {
      const wf = waveformsRef.current.getWaveform(queue[next]!);
      const dev = deviceRef.current;
      if (wf && dev.connected) dev.setWave(channel, wf.frames, wf.id, true);
    };
    const t = window.setInterval(() => {
      const current = indexRef.current;
      if (current === undefined) {
        // Legacy callers that do not pass `index`; see the note above.
        setIndex((prev) => {
          const next = nextRotationIndex(prev, queue.length, mode);
          play(next);
          return next;
        });
        return;
      }
      const next = nextRotationIndex(current, queue.length, mode);
      // Remember it now so a second tick before the re-render advances from here.
      indexRef.current = next;
      play(next);
      setIndex(next);
    }, intervalSec * 1000);
    return () => clearInterval(t);
  }, [channel, waveId, queue, mode, intervalSec, setIndex, deviceRef, waveformsRef]);
}
