import { afterEach, describe, it, expect, vi } from 'vitest';
import { downloadVideo, submitMedia, MediaProviderError } from './minimax-media';
afterEach(() => vi.unstubAllGlobals());
describe('MiniMax adapter boundaries', () => {
  it('does not fetch untrusted video locations or follow redirects', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const url of [
      'http://cdn.hailuoai.com/a',
      'https://127.0.0.1/a',
      'https://cdn.hailuoai.com.evil.test/a',
      'https://cdn.hailuoai.com:8443/a',
      'https://user@cdn.hailuoai.com/a',
    ])
      await expect(downloadVideo(url)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('classifies ambiguous transport errors separately from explicit rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(new Response('', { status: 400 })),
    );
    await expect(submitMedia('test', 'video', 'scene')).rejects.toMatchObject({ uncertain: true });
    await expect(submitMedia('test', 'video', 'scene')).rejects.toMatchObject({ uncertain: false });
  });
  it('rejects incomplete or malformed successful responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(Response.json({ data: { image_base64: ['!'] } })),
    );
    await expect(submitMedia('test', 'video', 'scene')).rejects.toBeInstanceOf(MediaProviderError);
    await expect(submitMedia('test', 'image', 'scene')).rejects.toMatchObject({ uncertain: true });
  });
});
