import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROXY, saveProxy } from '@0xnullai/settings';
import { fetchXaiVoices } from './voice-catalog.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  saveProxy(DEFAULT_PROXY);
  vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('fetchXaiVoices', () => {
  it('extracts voice ids from a top-level array of strings', async () => {
    mockFetchOnce(['ara', 'eve', 'leo']);
    await expect(fetchXaiVoices('key')).resolves.toEqual(['ara', 'eve', 'leo']);
  });

  it('extracts voice ids from a { voices: [...] } wrapper with object entries', async () => {
    mockFetchOnce({ voices: [{ voice_id: 'nova' }, { id: 'quartz' }, { name: 'ember' }] });
    await expect(fetchXaiVoices('key')).resolves.toEqual(['nova', 'quartz', 'ember']);
  });

  it('extracts voice ids from a { data: [...] } wrapper', async () => {
    mockFetchOnce({ data: [{ voice_id: 'nova' }] });
    await expect(fetchXaiVoices('key')).resolves.toEqual(['nova']);
  });

  it('throws with the HTTP status on a non-ok response', async () => {
    mockFetchOnce({}, false, 401);
    await expect(fetchXaiVoices('bad-key')).rejects.toThrow('401');
  });

  it('throws when the response has no recognizable voice list', async () => {
    mockFetchOnce({ unexpected: 'shape' });
    await expect(fetchXaiVoices('key')).rejects.toThrow('格式无法识别');
  });

  it('sends the API key as a Bearer token', async () => {
    mockFetchOnce(['ara']);
    await fetchXaiVoices('my-key');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/tts/voices',
      expect.objectContaining({ headers: { Authorization: 'Bearer my-key' } }),
    );
  });

  it('uses the global proxy for voice API requests', async () => {
    saveProxy({ enabled: true, httpBaseUrl: 'https://proxy.example/ai' });
    mockFetchOnce(['ara']);

    await fetchXaiVoices('my-key');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://proxy.example/ai/api.x.ai/v1/tts/voices',
      expect.any(Object),
    );
  });
});
