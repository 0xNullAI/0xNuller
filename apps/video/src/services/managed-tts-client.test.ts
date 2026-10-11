import { beforeEach, expect, it, vi } from 'vitest';
import {
  createManagedTts,
  loadManagedTtsAudio,
  managedTtsMaxCredits,
  managedTtsOffer,
} from './managed-tts-client';

const auth = vi.hoisted(() => ({ account: 'alice' }));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({ Authorization: 'Bearer secret' }),
}));
vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => 'https://api.test' }));

beforeEach(() => {
  auth.account = 'alice';
  vi.unstubAllGlobals();
});

it('uses the same code-point upper bound as the server and sends consent only after a quote', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'POST'
      ? Response.json({
          job: { id: 'speech001', state: 'succeeded', credits: 4, audioAvailable: true },
        })
      : Response.json({
          enabled: true,
          offer: { perTenThousandChars: 20_000, maxTextCharacters: 500, priceVersion: 'v1' },
        }),
  );
  vi.stubGlobal('fetch', fetcher);
  const offer = await managedTtsOffer('alice');
  expect(managedTtsMaxCredits('😀', offer)).toBe(4);
  await createManagedTts('alice', 'speech001', '😀', offer);
  const [url, init] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.test/api/auth/managed-tts');
  expect(init.credentials).toBe('include');
  expect(init.headers).toMatchObject({ 'X-Account-Id': 'alice', Authorization: 'Bearer secret' });
  expect(JSON.parse(String(init.body))).toMatchObject({
    consent: true,
    acceptedMaxCredits: 4,
    priceVersion: 'v1',
  });
});

it('rejects account changes, non-audio responses and oversized files', async () => {
  const fetcher = vi.fn(async () => {
    auth.account = 'bob';
    return Response.json({
      enabled: true,
      offer: { perTenThousandChars: 20_000, maxTextCharacters: 500, priceVersion: 'v1' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(managedTtsOffer('alice')).rejects.toThrow('账户已切换');
  auth.account = 'alice';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'wrong format' })),
  );
  await expect(loadManagedTtsAudio('alice', 'speech001')).rejects.toThrow('音频不可用');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array(4_000_001), { headers: { 'Content-Type': 'audio/mpeg' } }),
    ),
  );
  await expect(loadManagedTtsAudio('alice', 'speech001')).rejects.toThrow('音频无效');
});
