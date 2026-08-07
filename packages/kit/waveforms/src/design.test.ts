import { describe, expect, it } from 'vitest';
import { compileWaveformDesign } from './design.js';

describe('compileWaveformDesign', () => {
  it('expands a hold segment to count = duration / 25 ms frames', () => {
    const result = compileWaveformDesign([{ type: 'hold', intensity: 50, durationMs: 100 }]);
    expect(result.frames).toHaveLength(4);
    expect(result.totalDurationMs).toBe(100);
    expect(result.frames.every((f) => f[1] === 50)).toBe(true);
  });

  it('linearly interpolates ramp from start to end intensity', () => {
    const result = compileWaveformDesign([{ type: 'ramp', from: 0, to: 100, durationMs: 100 }]);
    expect(result.frames).toHaveLength(4);
    expect(result.frames[0]?.[1]).toBe(0);
    expect(result.frames[3]?.[1]).toBe(100);
  });

  it('alternates pulse on/off cycles', () => {
    const result = compileWaveformDesign([
      { type: 'pulse', intensity: 80, onMs: 50, offMs: 50, count: 2 },
    ]);
    // 2 cycles * (2 on + 2 off) = 8 frames
    expect(result.frames).toHaveLength(8);
    expect(result.frames[0]?.[1]).toBe(80);
    expect(result.frames[2]?.[1]).toBe(0);
  });

  it('emits zero-intensity frames for silence', () => {
    const result = compileWaveformDesign([{ type: 'silence', durationMs: 100 }]);
    expect(result.frames.every((f) => f[1] === 0)).toBe(true);
  });

  it('rejects an empty segment list', () => {
    expect(() => compileWaveformDesign([])).toThrow();
  });

  it('rejects a total duration over 30 seconds', () => {
    expect(() =>
      compileWaveformDesign([{ type: 'hold', intensity: 50, durationMs: 31_000 }]),
    ).toThrow(/上限/);
  });
});
