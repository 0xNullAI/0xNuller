import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from './ai-config';
import { callLlm, type LlmMessage, type LlmTool } from './llm-client';

const TOOL: LlmTool = {
  type: 'function',
  function: {
    name: 'stop',
    description: 'stop output',
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
  },
};

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    providerId: 'qwen',
    apiKey: 'sk-test',
    model: 'qwen3.5-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    endpoint: 'chat/completions',
    useStrict: false,
    rememberApiKey: false,
    ...overrides,
  };
}

function successfulChatResponse() {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '完成', tool_calls: [] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('room agent shared browser LLM adapter', () => {
  it('preserves instructions, assistant tool calls, tool outputs and the per-turn token ceiling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulChatResponse());
    vi.stubGlobal('fetch', fetchMock);
    const messages: LlmMessage[] = [
      { role: 'system', content: '房间规则' },
      { role: 'user', content: '请停止' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'stop', arguments: { target: 'peer-1' } }],
      },
      { role: 'tool', content: '已停止', tool_call_id: 'call-1', name: 'stop' },
    ];

    await callLlm(config(), messages, { tools: [TOOL], maxTokens: 800 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(body.max_tokens).toBe(800);
    expect(body.messages).toEqual([
      { role: 'system', content: '房间规则' },
      { role: 'user', content: '请停止' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'stop', arguments: '{"target":"peer-1"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '已停止' },
    ]);
  });

  it('uses the shared free-proxy URL, account bearer header and cookie credentials', async () => {
    localStorage.setItem('0xnullai.auth-token', 'native-token');
    const fetchMock = vi.fn().mockResolvedValue(successfulChatResponse());
    vi.stubGlobal('fetch', fetchMock);

    await callLlm(
      config({
        providerId: 'free',
        apiKey: '',
        model: '',
        baseUrl: 'https://stale.invalid',
      }),
      [{ role: 'user', content: '你好' }],
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.0xnullai.com/v1/chat/completions');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer native-token' });
  });

  it('passes AbortSignal through unchanged and preserves AbortError', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(aborted);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callLlm(config(), [{ role: 'user', content: '停止' }], { signal: controller.signal }),
    ).rejects.toBe(aborted);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
  });

  it('uses the shared Responses transport with conversation items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output_text: '完成', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlm(
      config({
        providerId: 'custom',
        baseUrl: 'https://models.example/v1',
        model: 'custom-model',
        endpoint: 'responses',
      }),
      [
        { role: 'system', content: '系统规则' },
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'stop', arguments: { target: 'peer-2' } }],
        },
        { role: 'tool', content: '已停止', tool_call_id: 'call-2' },
      ],
      { maxTokens: 512 },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(result).toEqual({ text: '完成', toolCalls: [] });
    expect(url).toBe('https://models.example/v1/responses');
    expect(body.instructions).toBe('系统规则');
    expect(body.max_output_tokens).toBe(512);
    expect(body.input).toEqual(
      expect.arrayContaining([
        { type: 'function_call_output', call_id: 'call-2', output: '已停止' },
      ]),
    );
  });
});
