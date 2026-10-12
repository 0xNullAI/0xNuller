import { describe, expect, it } from 'vitest';
import {
  measureOggOpus,
  oggOpusClip,
  OpusContainerError,
  opusPacketSamples,
  webmOpusToOgg,
} from './opus-container';
import { webmOpus } from './test-opus';

/** Ogg CRC per RFC 3533 (polynomial 0x04c11db7, unreflected), recomputed independently. */
function pageCrcOk(page: Uint8Array): boolean {
  const copy = page.slice();
  const stored = new DataView(copy.buffer).getUint32(22, true);
  copy.fill(0, 22, 26);
  let crc = 0;
  for (const byte of copy) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc === stored;
}

function pages(ogg: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < ogg.length) {
    const count = ogg[offset + 26]!;
    let size = 0;
    for (let index = 0; index < count; index++) size += ogg[offset + 27 + index]!;
    out.push(ogg.subarray(offset, offset + 27 + count + size));
    offset += 27 + count + size;
  }
  return out;
}

describe('recorded clip container', () => {
  it('counts Opus samples from the TOC byte', () => {
    expect(opusPacketSamples(new Uint8Array([0x08]))).toBe(960); // SILK 20 ms
    expect(opusPacketSamples(new Uint8Array([0xfc]))).toBe(960); // CELT 20 ms
    expect(opusPacketSamples(new Uint8Array([0x09]))).toBe(1920); // two frames
    expect(opusPacketSamples(new Uint8Array([0x0b, 0x03]))).toBe(2880); // code 3, three frames
    expect(() => opusPacketSamples(new Uint8Array())).toThrow(OpusContainerError);
    expect(() => opusPacketSamples(new Uint8Array([0x0b, 0x00]))).toThrow(OpusContainerError);
  });

  it('rewraps MediaRecorder-style WebM into valid Ogg pages with the same packets', () => {
    for (const unknownClusters of [true, false]) {
      const clip = webmOpusToOgg(webmOpus(3, { unknownClusters }));
      // 150 packets × 960 samples, minus the 312-sample pre-skip, at 48 kHz.
      expect(clip.durationMs).toBe(Math.ceil(((150 * 960 - 312) * 1000) / 48_000));
      const all = pages(clip.ogg);
      expect(all.every(pageCrcOk)).toBe(true);
      expect(new TextDecoder().decode(all[0]!.subarray(28, 36))).toBe('OpusHead');
      expect(all[0]![5]).toBe(0x02); // beginning of stream
      expect(all.at(-1)![5]).toBe(0x04); // end of stream
      expect(measureOggOpus(clip.ogg)).toBe(clip.durationMs);
      expect(oggOpusClip(clip.ogg, 'audio/ogg').durationMs).toBe(clip.durationMs);
    }
  });

  it('rejects non-Opus tracks, damaged files and unsupported types', () => {
    expect(() => webmOpusToOgg(webmOpus(1, { codec: 'A_VORBIS' }))).toThrow(OpusContainerError);
    const truncated = webmOpus(1).subarray(0, 60);
    expect(() => webmOpusToOgg(truncated)).toThrow(OpusContainerError);
    expect(() => measureOggOpus(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]))).toThrow(
      OpusContainerError,
    );
    expect(() => oggOpusClip(new Uint8Array([1]), 'audio/mp4')).toThrow(OpusContainerError);
  });
});
