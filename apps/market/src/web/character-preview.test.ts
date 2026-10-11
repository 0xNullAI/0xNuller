// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { emptyCharacterCard } from '@0xnullai/scenes/character-card';
import { previewCatalog, previewTurn } from './character-preview';
const state = vi.hoisted(() => ({ owner: 'a', listeners: new Set<() => void>() }));
vi.mock('@0xnullai/auth', () => ({
  authRequestHeaders: () => ({ Authorization: 'Bearer test' }),
  currentAuthUserId: () => state.owner,
  subscribeAuthChanges: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.owner = 'a';
});
const snapshot = { name: '草稿名字', prompt: '未发布的人设', card: emptyCharacterCard() };
it('sends bounded text-only draft context to the real gateway protocol with fresh idempotency', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ choices: [{ message: { content: '真实模型回复' } }], credit_charged: 0.01 }),
  );
  vi.stubGlobal('fetch', fetch);
  const result = await previewTurn(
    snapshot,
    [{ role: 'user', content: '你好' }],
    'basic',
    'a',
    new AbortController().signal,
  );
  expect(result).toEqual({ text: '真实模型回复', charged: 0.01 });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://llm.0xnullai.com/v1/chat/completions');
  const body = JSON.parse(init.body as string);
  expect(body).toEqual({
    model: 'basic',
    stream: false,
    max_tokens: 512,
    messages: [
      { role: 'system', content: expect.stringContaining('未发布的人设') },
      { role: 'user', content: '你好' },
    ],
  });
  expect(init.credentials).toBe('include');
  expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  expect(body.tools).toBeUndefined();
  expect(body.conversationId).toBeUndefined();
});
it('drops responses after A to B to A and aborts upstream request', async () => {
  let passed!: AbortSignal;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      passed = init.signal;
      state.owner = 'b';
      state.listeners.forEach((listener) => listener());
      state.owner = 'a';
      state.listeners.forEach((listener) => listener());
      return Response.json({ data: [], credit: { available: 20 } });
    }),
  );
  await expect(previewCatalog('a', new AbortController().signal)).rejects.toThrow('账户已切换');
  expect(passed.aborted).toBe(true);
  expect(state.listeners.size).toBe(0);
});
it('requires live prices and balance, rejects oversized prompts before any charge', async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      data: [
        {
          id: 'basic',
          name: '基础',
          inputCreditsPerMillion: 1,
          outputCreditsPerMillion: 2,
          priceVersion: 'live',
        },
      ],
      credit: { total: 20, available: 19, reserved: 1 },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  expect((await previewCatalog('a', new AbortController().signal)).credit.available).toBe(19);
  await expect(
    previewTurn(
      { ...snapshot, prompt: 'x'.repeat(32001) },
      [],
      'basic',
      'a',
      new AbortController().signal,
    ),
  ).rejects.toThrow('32000');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects an invalid full character card before any paid request instead of dropping its background', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    previewTurn(
      { ...snapshot, card: { ...snapshot.card, description: 'x'.repeat(100000) } },
      [{ role: 'user', content: '你好' }],
      'basic',
      'a',
      new AbortController().signal,
    ),
  ).rejects.toThrow('详细设定无效');
  expect(fetch).not.toHaveBeenCalled();
});
