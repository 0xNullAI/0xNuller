import { describe, expect, it, vi } from 'vitest';
import {
  isMp3Audio,
  splitJsonObjects,
  synthesizeDoubaoSpeech,
  TtsProviderError,
} from './doubao-tts';

const MP3 = [0xff, 0xfb, 0x90, 0x64, 0, 0];
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const request = {
  key: 'k',
  resourceId: 'example-tts',
  voice: 'zh_female_vv_uranus_bigtts',
  text: '你好',
  maxCharacters: 4,
};
const respond = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(TtsProviderError);
  return (error as TtsProviderError).uncertain;
}

describe('Doubao chunked TTS stream', () => {
  it('splits objects with or without separators and refuses truncated JSON', () => {
    expect(splitJsonObjects('{"a":"}{"}\n{"b":1}{"c":{"d":2}}')).toEqual([
      '{"a":"}{"}',
      '{"b":1}',
      '{"c":{"d":2}}',
    ]);
    expect(() => splitJsonObjects('{"a":1')).toThrow();
    expect(() => splitJsonObjects('oops{"a":1}')).toThrow();
  });

  it('concatenates base64 audio until the final usage object', async () => {
    const body = [
      { code: 0, data: b64(MP3.slice(0, 2)) },
      { code: 0, data: null, sentence: { text: '你好' } },
      { code: 0, data: b64(MP3.slice(2)) },
      { code: 20000000, message: 'OK', data: null, usage: { text_words: 2 } },
    ]
      .map((object) => JSON.stringify(object))
      .join('\n');
    const result = await synthesizeDoubaoSpeech(request, respond(body));
    expect([...result.audio]).toEqual(MP3);
    expect(result.characters).toBe(2);
  });

  it('never invents usage and distrusts counts above the accepted bound', async () => {
    const audio = JSON.stringify({ code: 0, data: b64(MP3) });
    expect(
      await failure(
        synthesizeDoubaoSpeech(request, respond(`${audio}\n{"code":20000000,"data":null}`)),
      ),
    ).toBe(true);
    expect(
      await failure(
        synthesizeDoubaoSpeech(
          request,
          respond(`${audio}\n{"code":20000000,"usage":{"text_words":5}}`),
        ),
      ),
    ).toBe(true);
    expect(await failure(synthesizeDoubaoSpeech(request, respond(audio)))).toBe(true);
  });

  it('classifies a rejection before audio as definite and later or server errors as uncertain', async () => {
    expect(
      await failure(synthesizeDoubaoSpeech(request, respond('{"code":40402003,"message":"long"}'))),
    ).toBe(false);
    expect(
      await failure(
        synthesizeDoubaoSpeech(
          request,
          respond(`${JSON.stringify({ code: 0, data: b64(MP3) })}{"code":45000000}`),
        ),
      ),
    ).toBe(true);
    expect(await failure(synthesizeDoubaoSpeech(request, respond('{"code":55000000}')))).toBe(true);
    expect(await failure(synthesizeDoubaoSpeech(request, respond('bad', 400)))).toBe(false);
    expect(await failure(synthesizeDoubaoSpeech(request, respond('busy', 503)))).toBe(true);
  });

  it('recognises MP3 frames behind an ID3 tag only', () => {
    expect(isMp3Audio(new Uint8Array(MP3))).toBe(true);
    expect(
      isMp3Audio(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])),
    ).toBe(true);
    expect(isMp3Audio(new TextEncoder().encode('{"error":1}'))).toBe(false);
  });
});
