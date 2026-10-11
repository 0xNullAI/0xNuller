import { describe, expect, it } from 'vitest';
import { admitUnderLease, checkLeaseFence } from './lease-fence.js';

describe('lease fence', () => {
  it('admits only the current holder and captures holder plus epoch', () => {
    expect(admitUnderLease('agent', { holder: 'agent', epoch: 4 })).toEqual({
      ok: true,
      fence: { holder: 'agent', epoch: 4 },
    });
    expect(admitUnderLease('agent', { holder: 'chat', epoch: 4 })).toEqual({
      ok: false,
      reason: 'lease-not-held',
    });
    expect(admitUnderLease('agent', { holder: null, epoch: 4 })).toEqual({
      ok: false,
      reason: 'lease-not-held',
    });
  });

  it('rejects at write time when the epoch moved, even if the holder name came back (ABA)', () => {
    const fence = { holder: 'agent', epoch: 4 };
    expect(checkLeaseFence(fence, { holder: 'agent', epoch: 4 })).toEqual({ ok: true });
    expect(checkLeaseFence(fence, { holder: 'agent', epoch: 6 })).toEqual({
      ok: false,
      reason: 'lease-changed',
    });
    expect(checkLeaseFence(fence, { holder: null, epoch: 5 })).toEqual({
      ok: false,
      reason: 'lease-changed',
    });
  });
});
