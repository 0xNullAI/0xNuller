import { describe, expect, it } from 'vitest';
import {
  createNoOpRateLimitPolicy,
  createSlidingWindowRateLimitPolicy,
  createTurnRateLimitPolicy,
} from './policy.js';

describe('createNoOpRateLimitPolicy', () => {
  it('always allows', () => {
    const policy = createNoOpRateLimitPolicy();
    expect(policy.shouldAllow('any')).toEqual({ allow: true });
    policy.recordCall('any');
    expect(policy.shouldAllow('any')).toEqual({ allow: true });
  });
});

describe('createTurnRateLimitPolicy', () => {
  it('rejects after the per-turn cap is hit', () => {
    const policy = createTurnRateLimitPolicy({ caps: { burst: 1 } });
    expect(policy.shouldAllow('burst').allow).toBe(true);
    policy.recordCall('burst');
    const denied = policy.shouldAllow('burst');
    expect(denied.allow).toBe(false);
  });

  it('allows again after resetTurn', () => {
    const policy = createTurnRateLimitPolicy({ caps: { burst: 1 } });
    policy.recordCall('burst');
    policy.resetTurn?.();
    expect(policy.shouldAllow('burst').allow).toBe(true);
  });

  it('does not restrict tools that lack a cap', () => {
    const policy = createTurnRateLimitPolicy({ caps: {} });
    for (let i = 0; i < 100; i++) {
      expect(policy.shouldAllow('start').allow).toBe(true);
      policy.recordCall('start');
    }
  });
});

describe('createSlidingWindowRateLimitPolicy', () => {
  it('admits up to N calls then rejects within the window', () => {
    let now = 1000;
    const policy = createSlidingWindowRateLimitPolicy({
      windowMs: 1000,
      caps: { burst: 2 },
      now: () => now,
    });

    policy.recordCall('burst');
    now += 100;
    policy.recordCall('burst');
    expect(policy.shouldAllow('burst').allow).toBe(false);
  });

  it('admits new calls once old ones fall outside the window', () => {
    let now = 1000;
    const policy = createSlidingWindowRateLimitPolicy({
      windowMs: 1000,
      caps: { burst: 1 },
      now: () => now,
    });

    policy.recordCall('burst');
    expect(policy.shouldAllow('burst').allow).toBe(false);
    now += 1500;
    expect(policy.shouldAllow('burst').allow).toBe(true);
  });
});
