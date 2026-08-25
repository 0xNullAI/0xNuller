import { describe, expect, it, vi } from 'vitest';
import {
  POLICY_NOT_CONVERGED_REASON,
  resolvePolicyDecision,
  type PolicyLoopDecision,
} from './runtime-policy-resolution.js';

interface Command {
  strength: number;
}

describe('resolvePolicyDecision', () => {
  it('returns an unchanged command after an immediate allow', () => {
    const evaluate = vi.fn<(_: Command) => PolicyLoopDecision<Command>>(() => ({ type: 'allow' }));

    expect(resolvePolicyDecision({ strength: 8 }, 4, evaluate)).toEqual({
      command: { strength: 8 },
      clampedFrom: undefined,
      clampReasons: [],
      denyReason: undefined,
      needsConfirm: false,
      confirmReason: '',
      exhausted: false,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('applies every clamp before reaching the confirmation gate', () => {
    const decisions: PolicyLoopDecision<Command>[] = [
      { type: 'clamp', command: { strength: 7 }, reason: 'burst cap' },
      { type: 'clamp', command: { strength: 5 }, reason: 'user cap' },
      { type: 'require-confirm', reason: 'ask every time' },
    ];
    const evaluate = vi.fn(() => decisions.shift()!);

    expect(resolvePolicyDecision({ strength: 10 }, 4, evaluate)).toEqual({
      command: { strength: 5 },
      clampedFrom: { command: { strength: 10 }, reason: 'burst cap; user cap' },
      clampReasons: ['burst cap', 'user cap'],
      denyReason: undefined,
      needsConfirm: true,
      confirmReason: 'ask every time',
      exhausted: false,
    });
  });

  it('preserves clamp audit information when a later rule denies', () => {
    const decisions: PolicyLoopDecision<Command>[] = [
      { type: 'clamp', command: { strength: 4 }, reason: 'channel cap' },
      { type: 'deny', reason: 'not permitted' },
    ];

    expect(resolvePolicyDecision({ strength: 9 }, 4, () => decisions.shift()!)).toMatchObject({
      command: { strength: 4 },
      clampedFrom: { command: { strength: 9 }, reason: 'channel cap' },
      denyReason: 'not permitted',
      exhausted: false,
    });
  });

  it('fails closed when clamp decisions do not converge within the bound', () => {
    const evaluate = vi.fn((command: Command) => ({
      type: 'clamp' as const,
      command: { strength: command.strength - 1 },
      reason: 'custom clamp',
    }));

    const result = resolvePolicyDecision({ strength: 10 }, 4, evaluate);

    expect(result).toMatchObject({
      command: { strength: 6 },
      denyReason: POLICY_NOT_CONVERGED_REASON,
      needsConfirm: false,
      exhausted: true,
    });
    expect(result.clampReasons).toHaveLength(4);
    expect(evaluate).toHaveBeenCalledTimes(4);
  });
});
