/**
 * Shared per-channel frame-queue stepping mechanics: index/loop/deactivate
 * bookkeeping for a queue that gets consumed one 25ms slot at a time.
 *
 * Extracted from `BaseCoyoteProtocolAdapter.advanceWaveStep` (the logic was
 * originally inline there, operating directly on `ChannelWaveState`) so
 * `OpossumVibrateAdapter`'s vibration-pattern cursor can reuse the identical
 * indexing/looping/deactivation mechanics — both device families step a
 * per-channel frame queue at the same 25ms grid, they just clamp/transform
 * each raw frame differently (Coyote: `[freq,int]` tuple → clamped
 * `WaveStep`; Opossum: a plain 0-100 number, transform is just clamping).
 *
 * Deliberately does NOT own quad-assembly (bundling 4 steps into one 100ms
 * B0 write) — Coyote's `advanceWavePacket` has protocol-specific "channel
 * disable" sentinel behavior on a short/empty queue that doesn't generalize,
 * so quad-assembly stays in each caller.
 */
export interface WaveCursorState<TFrame> {
  frames: TFrame[] | null;
  index: number;
  loop: boolean;
  active: boolean;
}

export function createEmptyWaveCursorState<TFrame>(): WaveCursorState<TFrame> {
  return { frames: null, index: 0, loop: false, active: false };
}

export class WaveCursor<TFrame, TStep = TFrame> {
  constructor(private readonly transform: (frame: TFrame) => TStep) {}

  /**
   * Returns the current frame (transformed) and advances the index, or
   * `null` once the queue is exhausted (marking `state.active = false` for
   * a non-looping queue, or immediately for an empty/inactive one).
   */
  advanceStep(state: WaveCursorState<TFrame>): TStep | null {
    if (!state.active || !state.frames || state.frames.length === 0) {
      return null;
    }

    const length = state.frames.length;
    if (state.index >= length) {
      if (state.loop) {
        state.index = 0;
      } else {
        state.active = false;
        return null;
      }
    }

    const frame = state.frames[state.index];
    if (!frame) {
      state.active = false;
      return null;
    }

    state.index += 1;
    if (state.index >= length && !state.loop) {
      state.active = false;
    }

    return this.transform(frame);
  }
}
