import { expect, it, vi } from 'vitest';
import { recoverPreloadFailure } from './preload-recovery';
it.each(['read', 'write'])(
  'does not reload or suppress the error when storage %s fails',
  (failure) => {
    const event = new Event('vite:preloadError', { cancelable: true });
    const reload = vi.fn();
    recoverPreloadFailure(event, {
      storage: () => ({
        getItem: () => {
          if (failure === 'read') throw new Error();
          return null;
        },
        setItem: () => {
          throw new Error();
        },
      }),
      reload,
      now: () => 100_000,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  },
);
it('allows one persisted recovery then exposes repeated failures for manual retry', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const reload = vi.fn();
  const first = new Event('vite:preloadError', { cancelable: true });
  expect(recoverPreloadFailure(first, { storage: () => storage, reload, now: () => 100_000 })).toBe(
    true,
  );
  const second = new Event('vite:preloadError', { cancelable: true });
  expect(
    recoverPreloadFailure(second, { storage: () => storage, reload, now: () => 101_000 }),
  ).toBe(false);
  expect(second.defaultPrevented).toBe(false);
  expect(reload).toHaveBeenCalledOnce();
});
