import { expect, it, vi } from 'vitest';
import { InMemoryEventBus } from './event-bus.js';

it('isolates a failing UI listener so later listeners and the command owner keep running', () => {
  const bus = new InMemoryEventBus();
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const second = vi.fn();
  try {
    bus.subscribe(() => {
      throw new Error('render failed');
    });
    bus.subscribe(second);
    expect(() =>
      bus.emit({ type: 'runtime-warning', sessionId: 's', message: 'status' }),
    ).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Agent runtime event listener failed', expect.any(Error));
  } finally {
    log.mockRestore();
  }
});
