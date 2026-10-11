import { expect, it, vi } from 'vitest';
import {
  fetchTrustedAudio,
  synthesizeCosyvoice,
  trustedAudioUrl,
  TtsProviderError,
} from './cosyvoice-tts';

const url = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a/clip.mp3?signature=test';

it('uses the documented HTTP request, trusted result host and provider characters', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      output: {
        finish_reason: 'stop',
        audio: { url, expires_at: Math.floor(Date.now() / 1000) + 3600 },
      },
      usage: { characters: 7 },
    }),
  );
  const result = await synthesizeCosyvoice(
    'private-key',
    'workspace123',
    '你好世界',
    8,
    fetcher as typeof fetch,
  );
  expect(result).toMatchObject({ url: url.replace('http:', 'https:'), characters: 7 });
  expect(fetcher.mock.calls).toHaveLength(1);
  const [endpoint, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(endpoint).toBe(
    'https://workspace123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  );
  expect(JSON.parse(String(init.body))).toEqual({
    model: 'cosyvoice-v3-flash',
    input: { text: '你好世界', voice: 'longanyang', format: 'mp3' },
  });
});

it('rejects forged result URLs, redirect targets and unknown or excessive usage', async () => {
  for (const malicious of [
    'http://127.0.0.1/a.mp3?x=1',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.test/a.mp3?x=1',
    'https://user@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.mp3?x=1',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?x=1',
  ])
    expect(trustedAudioUrl(malicious)).toBeNull();
  const invalid = vi.fn(async () =>
    Response.json({
      output: {
        finish_reason: 'stop',
        audio: { url, expires_at: Math.floor(Date.now() / 1000) + 3600 },
      },
      usage: { characters: 99 },
    }),
  );
  await expect(
    synthesizeCosyvoice('k', 'workspace123', 'hello', 10, invalid as typeof fetch),
  ).rejects.toMatchObject({ uncertain: true });
});

it('bounds downloaded audio and refuses provider redirects', async () => {
  const secure = url.replace('http:', 'https:');
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
  expect(
    await fetchTrustedAudio(secure, vi.fn(async () => new Response(id3)) as typeof fetch),
  ).toEqual(id3);
  const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  expect(
    await fetchTrustedAudio(secure, vi.fn(async () => new Response(frame)) as typeof fetch),
  ).toEqual(frame);
  for (const garbage of [
    new Uint8Array([0x49, 0x6e, 0x76, 0x61]),
    new Uint8Array([0xff, 0x00, 0x00, 0x00]),
    new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]),
  ]) {
    await expect(
      fetchTrustedAudio(secure, vi.fn(async () => new Response(garbage)) as typeof fetch),
    ).rejects.toMatchObject({ uncertain: true });
  }
  await expect(
    fetchTrustedAudio(
      secure,
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }),
      ) as typeof fetch,
    ),
  ).rejects.toBeInstanceOf(TtsProviderError);
  await expect(
    fetchTrustedAudio(
      secure,
      vi.fn(async () => new Response(new Uint8Array(4_000_001))) as typeof fetch,
    ),
  ).rejects.toThrow();
});
