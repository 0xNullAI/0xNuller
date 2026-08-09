import { describe, expect, it } from 'vitest';
import { PolicyEngine, createDefaultPolicyRules } from '@dg-kit/safety';

/**
 * Chat's AI-to-device path had no policy engine at all — the only module with
 * one that didn't, while Agent and Voice both do. Its AI could move a channel
 * by ±50 in a single call against Agent's ±10, with no cold-start clamp, so a
 * device resting at 0 under a cap of 50 could be taken straight to 50.
 *
 * These pin the rule set App.tsx builds for AI commands: the default rules
 * minus permission-gate, because Chat's consent for the AI is `allowAi`,
 * granted once by the device's owner, and there is no per-command confirm UI
 * on the remote path to answer it.
 */

function aiRules(safety: Parameters<typeof createDefaultPolicyRules>[0] = {}) {
  return new PolicyEngine(
    createDefaultPolicyRules(safety).filter((r) => r.name !== 'permission-gate'),
  );
}

const context = { sessionId: 'chat-room', sourceType: 'api' as const, traceId: 'ai:room' };

function state(over: Partial<Record<string, number | boolean>> = {}) {
  return {
    connected: true,
    strengthA: 0,
    strengthB: 0,
    limitA: 50,
    limitB: 50,
    waveActiveA: false,
    waveActiveB: false,
    ...over,
  } as Parameters<PolicyEngine['evaluate']>[0]['deviceState'];
}

describe('房间 AI 的设备指令策略', () => {
  it('单次 +50 会被钳制——这正是修复前 AI 能做到的', () => {
    const decision = aiRules().evaluate({
      context,
      command: { type: 'adjustStrength', channel: 'A', delta: 50 },
      deviceState: state(),
    });

    expect(decision.type).toBe('clamp');
    if (decision.type === 'clamp' && decision.command.type === 'adjustStrength') {
      expect(decision.command.delta).toBeLessThan(50);
    }
  });

  it('冷启动时从 0 一步拉满不再可能', () => {
    const decision = aiRules({ maxColdStartStrength: 10 }).evaluate({
      context,
      command: { type: 'adjustStrength', channel: 'A', delta: 50 },
      deviceState: state({ strengthA: 0 }),
    });

    expect(decision.type).not.toBe('allow');
  });

  it('设备没连上时直接拒绝', () => {
    const decision = aiRules().evaluate({
      context,
      command: { type: 'adjustStrength', channel: 'A', delta: 5 },
      deviceState: state({ connected: false }),
    });

    expect(decision.type).toBe('deny');
  });

  it('小幅度调整照常放行——策略不是把 AI 变成摆设', () => {
    const decision = aiRules().evaluate({
      context,
      command: { type: 'adjustStrength', channel: 'A', delta: 5 },
      deviceState: state({ strengthA: 20 }),
    });

    expect(decision.type).toBe('allow');
  });

  it('用户把上限调低，AI 立刻受同一个上限约束', () => {
    const decision = aiRules({ maxStrengthA: 20 }).evaluate({
      context,
      command: { type: 'adjustStrength', channel: 'A', delta: 10 },
      deviceState: state({ strengthA: 18, limitA: 50 }),
    });

    // 18 + 10 = 28, above the user's cap of 20.
    expect(decision.type).not.toBe('allow');
  });

  it('去掉的只有 permission-gate，钳制类规则一条不少', () => {
    const names = createDefaultPolicyRules({})
      .filter((r) => r.name !== 'permission-gate')
      .map((r) => r.name);

    expect(names).toContain('require-device-connection');
    expect(names).toContain('soft-start');
    expect(names).toContain('user-strength-cap');
    expect(names).toContain('step-adjust');
    expect(names).not.toContain('permission-gate');
  });
});
