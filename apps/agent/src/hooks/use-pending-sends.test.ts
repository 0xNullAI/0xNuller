import { describe, expect, it, vi } from 'vitest';
import { PendingSends, throwIfSendAborted } from './use-pending-sends';

describe('PendingSends', () => {
  it('tracks sends per conversation so one running reply never marks another busy', () => {
    const sends = new PendingSends();
    const listener = vi.fn();
    sends.subscribe(listener);
    const a = sends.begin('a');
    expect(sends.has('a')).toBe(true);
    expect(sends.has('b')).toBe(false);
    expect([...sends.getSnapshot()]).toEqual(['a']);
    sends.end('a', a);
    expect(sends.has('a')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('aborts only the named conversation, or every send for a global stop', () => {
    const sends = new PendingSends();
    const a = sends.begin('a');
    const b = sends.begin('b');
    sends.abort('a');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    sends.abort();
    expect(b.signal.aborted).toBe(true);
  });

  it('a stop latched before the runtime saw the send surfaces as the reply-aborted error', () => {
    const sends = new PendingSends();
    const send = sends.begin('a');
    expect(() => throwIfSendAborted(send.signal)).not.toThrow();
    sends.abort('a');
    expect(() => throwIfSendAborted(send.signal)).toThrow('已停止当前回复');
  });
});
