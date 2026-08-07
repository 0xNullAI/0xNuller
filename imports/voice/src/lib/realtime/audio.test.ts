import { describe, expect, it } from 'vitest';
import { base64ToInt16, float32ToInt16, int16ToBase64, int16ToFloat32, wrapPcm16AsWav } from './audio.js';

describe('float32ToInt16 / int16ToFloat32', () => {
  it('round-trips full-scale and mid-scale samples within int16 precision', () => {
    const original = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const int16 = float32ToInt16(original);
    const roundTripped = int16ToFloat32(int16);
    for (let i = 0; i < original.length; i++) {
      expect(roundTripped[i]).toBeCloseTo(original[i]!, 3);
    }
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const int16 = float32ToInt16(new Float32Array([2, -2]));
    expect(int16[0]).toBe(0x7fff);
    expect(int16[1]).toBe(-0x8000);
  });
});

describe('int16ToBase64 / base64ToInt16', () => {
  it('round-trips arbitrary pcm16 data through base64', () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345]);
    const decoded = base64ToInt16(int16ToBase64(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('handles a chunk large enough to cross the base64 chunking boundary', () => {
    const original = new Int16Array(50_000).map((_, i) => (i % 2 === 0 ? i % 1000 : -(i % 1000)));
    const decoded = base64ToInt16(int16ToBase64(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});

describe('wrapPcm16AsWav', () => {
  it('produces a valid RIFF/WAVE header sized for the payload', () => {
    const pcm = new Int16Array([100, -100, 200, -200]);
    const wav = wrapPcm16AsWav(pcm, 24000);
    const view = new DataView(wav);

    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe(
      'RIFF',
    );
    expect(
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)),
    ).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(pcm.byteLength); // data chunk size
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
  });
});
