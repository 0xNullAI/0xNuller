import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkError, arkChat, arkConfig, arkImage, jsonContent } from './ark-client';
import { TEST_PRICE_TABLE, testPriceTable } from './test-helpers';

const route = { ...testPriceTable.background, fallbackModel: 'example-fallback-model' };
const request = { feature: 'memory' as const, system: 'sys', user: 'hi', maxTokens: 64 };
const completed = (content = '你好', usage: object = {}) =>
  Response.json({ choices: [{ finish_reason: 'stop', message: { content } }], usage });
const body = (call: number) =>
  JSON.parse(String(vi.mocked(fetch).mock.calls[call]?.[1]?.body)) as Record<string, unknown>;

beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ark configuration', () => {
  it('requires both the key and a valid price table', () => {
    expect(arkConfig({ AI_PRICE_TABLE: TEST_PRICE_TABLE })).toBeNull();
    expect(arkConfig({ VOLC_ARK_API_KEY: ' ', AI_PRICE_TABLE: TEST_PRICE_TABLE })).toBeNull();
    expect(arkConfig({ VOLC_ARK_API_KEY: 'k' })).toBeNull();
    expect(arkConfig({ VOLC_ARK_API_KEY: 'k', AI_PRICE_TABLE: '{}' })).toBeNull();
    expect(arkConfig({ VOLC_ARK_API_KEY: 'k', AI_PRICE_TABLE: TEST_PRICE_TABLE })).toMatchObject({
      key: 'k',
      table: { version: testPriceTable.version },
    });
  });
});

describe('Ark chat', () => {
  it('always disables thinking and sends no tools, then logs usage without content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completed('你好', { prompt_tokens: 10, completion_tokens: 5 })),
    );
    const result = await arkChat('secret', route, request);
    expect(result).toMatchObject({ content: '你好', model: route.model });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret');
    expect(body(0)).toMatchObject({
      model: route.model,
      stream: false,
      max_tokens: 64,
      thinking: { type: 'disabled' },
    });
    expect(body(0)).not.toHaveProperty('tools');
    const logged = String(vi.mocked(console.info).mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      event: 'ark_usage',
      feature: 'memory',
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(logged).not.toContain('你好');
    expect(logged).not.toContain('secret');
  });

  it('uses the fallback model only after the primary fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(completed('备用')),
    );
    expect(await arkChat('k', route, request)).toMatchObject({
      content: '备用',
      model: 'example-fallback-model',
    });
    expect(body(1)).toMatchObject({
      model: 'example-fallback-model',
      thinking: { type: 'disabled' },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completed()),
    );
    await arkChat('k', route, request);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('treats empty or unfinished output as a failure and has no fallback when none is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completed('<think>only reasoning</think>')),
    );
    await expect(arkChat('k', testPriceTable.background, request)).rejects.toBeInstanceOf(ArkError);
    expect(fetch).toHaveBeenCalledOnce();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ choices: [{ finish_reason: 'length', message: { content: '半句' } }] }),
      ),
    );
    await expect(arkChat('k', route, request)).rejects.toBeInstanceOf(ArkError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('classifies transport errors as uncertain and explicit rejections as certain', async () => {
    const solo = testPriceTable.background;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));
    await expect(arkChat('k', solo, request)).rejects.toMatchObject({ uncertain: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 400 })),
    );
    await expect(arkChat('k', solo, request)).rejects.toMatchObject({ uncertain: false });
  });

  it('unwraps a fenced JSON reply', () => {
    expect(jsonContent('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(jsonContent(' {"a":1} ')).toBe('{"a":1}');
  });
});

describe('Seedream images', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  it('requests base64 output without a watermark and passes the reference image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [{ b64_json: btoa(String.fromCharCode(...png)) }],
          usage: { generated_images: 1 },
        }),
      ),
    );
    const result = await arkImage('k', testPriceTable.image, '海边', 'data:image/png;base64,AA==');
    expect(result).toEqual({ bytes: png, mime: 'image/png' });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    );
    expect(body(0)).toEqual({
      model: testPriceTable.image.model,
      prompt: '海边',
      image: 'data:image/png;base64,AA==',
      size: '2K',
      response_format: 'b64_json',
      output_format: 'jpeg',
      watermark: false,
    });
  });

  it('rejects a malformed result, uncertain only when an image was generated', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: [], error: { code: 'x' } }))
        .mockResolvedValueOnce(
          Response.json({ data: [{ url: 'https://x' }], usage: { generated_images: 1 } }),
        ),
    );
    await expect(arkImage('k', testPriceTable.image, 'p', null)).rejects.toMatchObject({
      uncertain: false,
    });
    await expect(arkImage('k', testPriceTable.image, 'p', null)).rejects.toMatchObject({
      uncertain: true,
    });
  });
});
