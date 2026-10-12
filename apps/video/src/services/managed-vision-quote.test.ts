import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadManagedVisionQuote } from './managed-vision-quote.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('managed visual quote', () => {
  it('loads the authenticated server quote without treating other models as vision', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'balanced', maxReservationCredits: 2, imageInput: false },
            { id: 'vision', maxReservationCredits: 59, imageInput: true, priceVersion: 'v1' },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetch;
    expect(await loadManagedVisionQuote()).toEqual({
      maxReservationCredits: 59,
      priceVersion: 'v1',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://llm.0xnullai.com/v1/models',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('rejects missing or unpriced vision results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'vision', imageInput: true }] }), {
        status: 200,
      }),
    );
    await expect(loadManagedVisionQuote()).rejects.toThrow('不可用');
  });
});
