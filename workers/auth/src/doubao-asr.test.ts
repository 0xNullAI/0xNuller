import { describe, expect, it } from 'vitest';
import {
  AsrProviderError,
  asrClientFrame,
  parseAsrServerFrame,
  recognizeDoubaoClip,
} from './doubao-asr';
import { fakeAsrFetch, type AsrScript } from './test-opus';

const request = { key: 'k', resourceId: 'example-asr', ogg: new Uint8Array(40_000).fill(7) };

async function run(script: AsrScript) {
  const fake = fakeAsrFetch(script);
  const fetcher = fake.fetcher as unknown as typeof fetch;
  return { fake, outcome: await recognizeDoubaoClip(request, fetcher).catch((e) => e) };
}

describe('Doubao streaming ASR frames', () => {
  it('encodes client frames with a big-endian payload size', () => {
    expect([...asrClientFrame(0b0010, 0b0010, new Uint8Array([9, 8]))]).toEqual([
      0x11, 0x22, 0x00, 0x00, 0, 0, 0, 2, 9, 8,
    ]);
  });

  it('parses sequenced responses and error frames', () => {
    const body = new TextEncoder().encode('{"x":1}');
    const response = new Uint8Array([
      0x11,
      0x93,
      0x10,
      0,
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      body.length,
      ...body,
    ]);
    expect(parseAsrServerFrame(response)).toEqual({ type: 9, flags: 3, payload: '{"x":1}' });
    const error = new Uint8Array([0x11, 0xf0, 0x10, 0, 0x02, 0xae, 0xa5, 0x97, 0, 0, 0, 1, 0x7b]);
    expect(parseAsrServerFrame(error)).toMatchObject({ type: 15, code: 45000087 });
    expect(() => parseAsrServerFrame(new Uint8Array([0x11, 0x91, 0x11, 0]))).toThrow();
  });

  it('streams the clip in chunks, flags the last packet and returns the final result', async () => {
    const { fake, outcome } = await run({ text: ' 你好 ', durationMs: 2272 });
    expect(outcome).toEqual({ text: '你好', durationMs: 2272 });
    expect(fake.sent).toHaveLength(1 + 3);
    expect(fake.sent.slice(1, -1).every((frame) => frame[1] === 0x20)).toBe(true);
    expect(fake.sent.at(-1)![1]).toBe(0x22);
  });

  it('treats rejections as definite and lost or malformed results as uncertain', async () => {
    const rejected = (await run({ errorCode: 45000151 })).outcome;
    expect(rejected).toBeInstanceOf(AsrProviderError);
    expect(rejected.uncertain).toBe(false);
    for (const script of [
      { errorCode: 55000031 },
      'drop',
      { text: '你好', omitDuration: true },
    ] as AsrScript[]) {
      const outcome = (await run(script)).outcome;
      expect(outcome).toBeInstanceOf(AsrProviderError);
      expect(outcome.uncertain).toBe(true);
    }
  });
});
