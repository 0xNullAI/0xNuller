import { expect, it, vi } from 'vitest';
import { subscribeMediaQuery } from './media-query';
it('supports legacy MediaQueryList and detaches the same callback', () => {
  const legacy = { addListener: vi.fn(), removeListener: vi.fn() };
  const callback = vi.fn();
  const off = subscribeMediaQuery(legacy as unknown as MediaQueryList, callback);
  legacy.addListener.mock.calls[0]![0]();
  expect(callback).toHaveBeenCalledOnce();
  off();
  expect(legacy.removeListener).toHaveBeenCalledWith(callback);
});
