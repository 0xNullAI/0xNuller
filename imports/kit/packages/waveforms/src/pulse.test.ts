import { describe, expect, it } from 'vitest';
import { encodeFreq, parsePulseText } from './pulse.js';

describe('encodeFreq', () => {
  it('passes through 10..100 unchanged', () => {
    expect(encodeFreq(10)).toBe(10);
    expect(encodeFreq(50)).toBe(50);
    expect(encodeFreq(100)).toBe(100);
  });

  it('compresses 100..600 by /5', () => {
    expect(encodeFreq(200)).toBe(120);
    expect(encodeFreq(600)).toBe(200);
  });

  it('compresses 600..1000 by /10', () => {
    expect(encodeFreq(800)).toBe(220);
    expect(encodeFreq(1000)).toBe(240);
  });

  it('clamps out-of-range values', () => {
    expect(encodeFreq(0)).toBe(10);
    expect(encodeFreq(2000)).toBe(240);
  });
});

describe('parsePulseText', () => {
  it('rejects payloads without the magic prefix', () => {
    expect(() => parsePulseText('not a pulse file')).toThrow(/Dungeonlab\+pulse/);
  });

  it('parses a minimal single-section file', () => {
    // header: freq1=0 (10Hz), freq2=0 (10Hz), duration=0 (1), mode=1 (constant), enabled=1
    // shape: two points 0 and 100
    const text = 'Dungeonlab+pulse:测试=0,0,0,1,1/0,100';
    const result = parsePulseText(text);
    expect(result.name).toBe('测试');
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.frames[0]?.[1]).toBe(0);
    expect(result.frames.some((f) => f[1] === 100)).toBe(true);
  });

  it('skips disabled sections', () => {
    const text = 'Dungeonlab+pulse:测试=0,0,0,1,0/0,100+section+1,1,0,1,1/50,50';
    const result = parsePulseText(text);
    // Only the second (enabled) section produces frames; both points at 50.
    expect(result.frames.every((f) => f[1] === 50)).toBe(true);
  });
});
