import { describe, expect, it } from 'vitest';
import type { DeviceCommand, DeviceState } from '@dg-kit/core';
import type { ActionContext } from '@dg-kit/safety';
import { createDefaultPolicyRules } from '@dg-kit/safety';
import { PolicyEngine } from '@dg-kit/safety';

const context: ActionContext = { sessionId: 's1', sourceType: 'web', traceId: 't1' };

function coyoteState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    battery: 100,
    strengthA: 0,
    strengthB: 0,
    limitA: 200,
    limitB: 200,
    waveActiveA: false,
    waveActiveB: false,
    ...overrides,
  };
}

describe('createDefaultPolicyRules (Coyote)', () => {
  it('denies every command when the device is disconnected', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules());
    const command: DeviceCommand = {
      type: 'start',
      channel: 'A',
      strength: 5,
      waveform: { id: 'breath', name: '呼吸', frames: [[100, 50]] },
      loop: true,
    };

    const decision = engine.evaluate({
      context,
      command,
      deviceState: coyoteState({ connected: false }),
    });

    expect(decision).toEqual({ type: 'deny', reason: '设备未连接' });
  });

  it('clamps a cold-start strength above the default cap', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules());
    const command: DeviceCommand = {
      type: 'start',
      channel: 'A',
      strength: 50,
      waveform: { id: 'breath', name: '呼吸', frames: [[100, 50]] },
      loop: true,
    };

    const decision = engine.evaluate({ context, command, deviceState: coyoteState() });

    expect(decision.type).toBe('clamp');
    if (decision.type !== 'clamp') throw new Error('expected clamp');
    expect(decision.command).toMatchObject({ strength: 10 });
  });

  it('does not treat a start on an already-running channel as a cold start', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules());
    const command: DeviceCommand = {
      type: 'start',
      channel: 'A',
      strength: 50,
      waveform: { id: 'breath', name: '呼吸', frames: [[100, 50]] },
      loop: true,
    };

    const decision = engine.evaluate({
      context,
      command,
      deviceState: coyoteState({ strengthA: 20 }),
    });

    // Cold-start rule doesn't apply once current > 0; falls through to permission-gate.
    expect(decision.type).toBe('require-confirm');
  });

  it('clamps strength to the user cap independent of the hardware limit', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules({ maxStrengthA: 40 }));
    const command: DeviceCommand = {
      type: 'start',
      channel: 'A',
      strength: 80,
      waveform: { id: 'breath', name: '呼吸', frames: [[100, 50]] },
      loop: true,
    };

    const decision = engine.evaluate({
      context,
      command,
      // Already running, so cold-start doesn't apply — isolates the user cap.
      deviceState: coyoteState({ strengthA: 1, limitA: 200 }),
    });

    expect(decision.type).toBe('clamp');
    if (decision.type !== 'clamp') throw new Error('expected clamp');
    expect(decision.command).toMatchObject({ strength: 40 });
  });

  it('clamps an adjustStrength step above the default cap, preserving sign', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules());
    const positive: DeviceCommand = { type: 'adjustStrength', channel: 'A', delta: 25 };
    const negative: DeviceCommand = { type: 'adjustStrength', channel: 'A', delta: -25 };

    const positiveDecision = engine.evaluate({
      context,
      command: positive,
      deviceState: coyoteState({ strengthA: 25 }),
    });
    const negativeDecision = engine.evaluate({
      context,
      command: negative,
      deviceState: coyoteState({ strengthA: 25 }),
    });

    expect(positiveDecision.type).toBe('clamp');
    expect(negativeDecision.type).toBe('clamp');
    if (positiveDecision.type !== 'clamp' || negativeDecision.type !== 'clamp') {
      throw new Error('expected clamps');
    }
    expect(positiveDecision.command).toMatchObject({ delta: 10 });
    expect(negativeDecision.command).toMatchObject({ delta: -10 });
  });

  it('clamps burst duration to the default cap', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules());
    const command: DeviceCommand = {
      type: 'burst',
      channel: 'A',
      strength: 20,
      durationMs: 15_000,
    };

    const decision = engine.evaluate({
      context,
      command,
      deviceState: coyoteState({ strengthA: 20 }),
    });

    expect(decision.type).toBe('clamp');
    if (decision.type !== 'clamp') throw new Error('expected clamp');
    expect(decision.command).toMatchObject({ durationMs: 5000 });
  });

  it('clamps burst strength to an absolute cap when configured', () => {
    // maxStrengthA raised above the absolute cap so user-strength-cap (which
    // runs first) doesn't clamp before burst-strength-cap gets a chance to.
    const engine = new PolicyEngine(
      createDefaultPolicyRules({ maxStrengthA: 100, maxBurstStrengthAbsolute: 60 }),
    );
    const command: DeviceCommand = { type: 'burst', channel: 'A', strength: 90, durationMs: 500 };

    const decision = engine.evaluate({
      context,
      command,
      deviceState: coyoteState({ strengthA: 10 }),
    });

    expect(decision.type).toBe('clamp');
    if (decision.type !== 'clamp') throw new Error('expected clamp');
    expect(decision.command).toMatchObject({ strength: 60 });
  });

  it('requires confirmation for start/adjustStrength but not stop/emergencyStop', () => {
    const engine = new PolicyEngine(createDefaultPolicyRules());

    const stop = engine.evaluate({
      context,
      command: { type: 'stop', channel: 'A' },
      deviceState: coyoteState({ strengthA: 20 }),
    });
    const emergencyStop = engine.evaluate({
      context,
      command: { type: 'emergencyStop' },
      deviceState: coyoteState({ strengthA: 20 }),
    });
    const start = engine.evaluate({
      context,
      command: {
        type: 'start',
        channel: 'A',
        strength: 5,
        waveform: { id: 'breath', name: '呼吸', frames: [[100, 50]] },
        loop: true,
      },
      deviceState: coyoteState(),
    });

    expect(stop.type).toBe('allow');
    expect(emergencyStop.type).toBe('allow');
    expect(start.type).toBe('require-confirm');
  });
});
