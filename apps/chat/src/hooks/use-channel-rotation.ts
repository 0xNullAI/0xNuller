import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { PlayMode } from '../lib/protocol';
import type { WaveFrame } from '../lib/waveforms';

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

export function useChannelRotation(
  channel: 'A' | 'B',
  waveId: string | null,
  queue: string[],
  mode: PlayMode,
  intervalSec: number,
  setIndex: Dispatch<SetStateAction<number>>,
  deviceRef: RefObject<ChannelRotationDevice>,
  waveformsRef: RefObject<ChannelRotationWaveforms>,
) {
  useEffect(() => {
    if (waveId == null || queue.length <= 1 || mode === 'single') return;
    const t = window.setInterval(() => {
      setIndex((prev) => {
        const next =
          mode === 'random' ? Math.floor(Math.random() * queue.length) : (prev + 1) % queue.length;
        const wf = waveformsRef.current.getWaveform(queue[next]!);
        const dev = deviceRef.current;
        if (wf && dev.connected) dev.setWave(channel, wf.frames, wf.id, true);
        return next;
      });
    }, intervalSec * 1000);
    return () => clearInterval(t);
  }, [channel, waveId, queue, mode, intervalSec, setIndex, deviceRef, waveformsRef]);
}
