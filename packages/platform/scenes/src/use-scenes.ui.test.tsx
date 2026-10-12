import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePublicMarketPortrait } from './use-scenes';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@0xnullai/market-client', async (original) => ({
  ...(await original<typeof import('@0xnullai/market-client')>()),
  fetchPublicMarketPortrait: api.fetch,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('decodes public images, aborts and revokes on card changes, rejects late results and broken images', async () => {
  const images: { src: string; onload: (() => void) | null; onerror: (() => void) | null }[] = [];
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      onload = null;
      onerror = null;
      constructor() {
        images.push(this);
      }
    },
  );
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValueOnce('blob:first')
    .mockReturnValueOnce('blob:broken');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  api.fetch.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  const view = renderHook(({ id }) => usePublicMarketPortrait(id), {
    initialProps: { id: 'first' },
  });
  await waitFor(() => expect(images).toHaveLength(1));
  expect(view.result.current).toBeNull();
  act(() => images[0]!.onload?.());
  expect(view.result.current).toBe('blob:first');
  const oldSignal = api.fetch.mock.calls[0]![1] as AbortSignal;
  view.rerender({ id: 'second' });
  expect(view.result.current).toBeNull();
  expect(oldSignal.aborted).toBe(true);
  expect(revoke).toHaveBeenCalledWith('blob:first');
  await waitFor(() => expect(images).toHaveLength(2));
  act(() => images[1]!.onerror?.());
  expect(view.result.current).toBeNull();
  expect(revoke).toHaveBeenCalledWith('blob:broken');
  let complete!: (value: Blob) => void;
  api.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  view.rerender({ id: 'late' });
  view.unmount();
  await act(async () => complete(new Blob(['png'])));
  expect(create).toHaveBeenCalledTimes(2);
});
it('falls back for missing public images without creating an object URL', async () => {
  api.fetch.mockResolvedValue(null);
  const view = renderHook(() => usePublicMarketPortrait('missing'));
  await act(async () => {});
  expect(view.result.current).toBeNull();
});
it('returns fallback immediately when a legacy scene has no public portrait', () => {
  const view = renderHook(() => usePublicMarketPortrait(undefined));
  expect(view.result.current).toBeNull();
  expect(api.fetch).not.toHaveBeenCalled();
});
