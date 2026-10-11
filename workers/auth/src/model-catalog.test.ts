import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleModelCatalog, resetModelCatalogCache } from './model-catalog';

const upstream = {
  anthropic: {
    models: {
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        family: 'claude-opus',
        reasoning: true,
        temperature: false,
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
        release_date: '2026-09-01',
        cost: { input: 4, output: 20 },
      },
      broken: { name: 'no id' },
    },
  },
  deepseek: {
    models: {
      'deepseek-chat': {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        tool_call: true,
        modalities: { input: ['text'] },
        limit: { context: 128000, output: 8000 },
      },
    },
  },
  unrelated: { models: { x: { id: 'x' } } },
};

const request = (query: string, method = 'GET') =>
  new Request(`https://test/api/auth/model-catalog${query}`, { method });

beforeEach(() => resetModelCatalogCache());

describe('model catalog', () => {
  it('returns only the requested providers with the fields the picker needs', async () => {
    const fetcher = vi.fn(async () => Response.json(upstream));
    const response = (await handleModelCatalog(
      request('?providers=anthropic,deepseek'),
      {},
      fetcher,
    ))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = (await response.json()) as { providers: Record<string, unknown[]> };
    expect(Object.keys(body.providers)).toEqual(['anthropic', 'deepseek']);
    expect(body.providers.anthropic).toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        family: 'claude-opus',
        image: true,
        reasoning: true,
        temperature: false,
        toolCall: true,
        context: 1000000,
        output: 128000,
        releaseDate: '2026-09-01',
      },
    ]);
    expect(body.providers.deepseek).toMatchObject([
      { id: 'deepseek-chat', image: false, temperature: true },
    ]);
  });

  it('parses the upstream file once per refresh interval', async () => {
    const fetcher = vi.fn(async () => Response.json(upstream));
    await handleModelCatalog(request('?providers=anthropic'), {}, fetcher, 1_000);
    await handleModelCatalog(request('?providers=deepseek'), {}, fetcher, 2_000);
    expect(fetcher).toHaveBeenCalledOnce();
    await handleModelCatalog(request('?providers=deepseek'), {}, fetcher, 1_000 + 3_600_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed queries and reports an unavailable source', async () => {
    const fetcher = vi.fn(async () => new Response('down', { status: 502 }));
    expect((await handleModelCatalog(request(''), {}, fetcher))!.status).toBe(400);
    expect((await handleModelCatalog(request('?providers=../x'), {}, fetcher))!.status).toBe(400);
    expect(
      (await handleModelCatalog(request('?providers=anthropic', 'POST'), {}, fetcher))!.status,
    ).toBe(405);
    expect((await handleModelCatalog(request('?providers=anthropic'), {}, fetcher))!.status).toBe(
      503,
    );
    expect(
      await handleModelCatalog(new Request('https://test/api/auth/me'), {}, fetcher),
    ).toBeNull();
  });
});
