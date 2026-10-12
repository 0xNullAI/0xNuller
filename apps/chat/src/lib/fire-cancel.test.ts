import { describe, expect, it } from 'vitest';
import { CancelledFireHolds } from './fire-cancel';

describe('停止后的开火', () => {
  it('仍按住开火的人继续发心跳，也不会把输出重新拉起', () => {
    const holds = new CancelledFireHolds();
    holds.cancel('A', ['bob'], 0);
    expect(holds.swallow('A', 'bob', 300)).toBe(true);
    expect(holds.swallow('A', 'bob', 600)).toBe(true);
    // Only the cancelled channel and controller are affected.
    expect(holds.swallow('B', 'bob', 600)).toBe(false);
    expect(holds.swallow('A', 'carol', 600)).toBe(false);
  });

  it('松开后重新按下才算新的开火', () => {
    const holds = new CancelledFireHolds();
    holds.cancel('A', ['bob'], 0);
    holds.release('A', 'bob');
    expect(holds.swallow('A', 'bob', 100)).toBe(false);
  });

  it('心跳停止超过时限后自动解除，持续的心跳会续期', () => {
    const holds = new CancelledFireHolds();
    holds.cancel('A', ['bob', 'carol'], 0);
    holds.swallow('A', 'bob', 700);
    holds.expire(1000, 800);
    expect(holds.swallow('A', 'carol', 1000)).toBe(false);
    expect(holds.swallow('A', 'bob', 1000)).toBe(true);
  });
});
