import { describe, expect, it, vi } from 'vitest';
import { transcribeQwenAudio, ASR_MAX_AUDIO_BYTES } from './qwen-asr';

const result = () =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '你好，今天怎么样？' } }],
      usage: { seconds: 3, prompt_tokens: 75, completion_tokens: 12 },
    }),
  );

describe('Qwen recorded ASR adapter', () => {
  it('sends private audio inline to a fixed endpoint, never as a public URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => result());
    const value = await transcribeQwenAudio(
      'server-secret',
      new Uint8Array([1, 2, 3]),
      'audio/webm',
      fetcher as typeof fetch,
    );
    expect(value).toEqual({
      text: '你好，今天怎么样？',
      seconds: 3,
      inputTokens: 75,
      outputTokens: 12,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    const request = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body)).messages[0].content[0].input_audio.data).toBe(
      'data:audio/webm;base64,AQID',
    );
    expect(request?.redirect).toBe('error');
  });

  it('rejects unsupported or oversized input before a provider call', async () => {
    const fetcher = vi.fn();
    await expect(
      transcribeQwenAudio('key', new Uint8Array(1), 'audio/wav', fetcher as typeof fetch),
    ).rejects.toThrow('输入无效');
    await expect(
      transcribeQwenAudio(
        'key',
        new Uint8Array(ASR_MAX_AUDIO_BYTES + 1),
        'audio/webm',
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow('输入无效');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects partial, malformed or unmetered output', async () => {
    const base = {
      choices: [{ finish_reason: 'stop', message: { content: '你好' } }],
      usage: { seconds: 2, prompt_tokens: 50, completion_tokens: 2 },
    };
    for (const body of [
      { ...base, choices: [{ finish_reason: 'length', message: { content: '你好' } }] },
      { ...base, usage: { seconds: 301, prompt_tokens: 50, completion_tokens: 2 } },
      { ...base, usage: undefined },
      { ...base, choices: [{ finish_reason: 'stop', message: { content: ' ' } }] },
    ]) {
      await expect(
        transcribeQwenAudio(
          'key',
          new Uint8Array([1]),
          'audio/ogg',
          async () => new Response(JSON.stringify(body)),
        ),
      ).rejects.toThrow('结果无效');
    }
  });
});
