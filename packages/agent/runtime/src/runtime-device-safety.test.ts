import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, RuntimeEvent } from '@dg-agent/core';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import { createDefaultPolicyRules, PolicyEngine } from '@dg-kit/safety';
import { AgentRuntime } from './agent-runtime.js';
import {
  BurstOnlyLlm,
  CountingPermission,
  DenyingPermission,
  LargeAdjustLlm,
  LargeStartLlm,
  LongBurstLlm,
  RepeatedAdjustLlm,
  TestDevice,
  TestLlm,
  TestPermission,
  TimerFollowUpLlm,
} from './runtime.test-support.js';

describe('AgentRuntime Coyote safety policy and burst execution', () => {
  it('enforces configurable per-turn shock_adjust quotas', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new RepeatedAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxAdjustStrengthCallsPerTurn: 1,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '继续加一点',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-quota',
      },
    });

    const denied = events.filter((event) => event.type === 'tool-call-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0] && 'reason' in denied[0] ? denied[0].reason : '').toContain('shock_adjust');
  });

  it('still executes a pre-1.9.0 tool name (adjust_strength) via the registry alias, counting toward the same quota', async () => {
    class LegacyNameAdjustLlm implements LlmClient {
      async runTurn() {
        return {
          assistantMessage: '按旧名调整',
          toolCalls: [
            { id: 'legacy-1', name: 'adjust_strength', args: { channel: 'A', delta: 5 } },
            { id: 'legacy-2', name: 'adjust_strength', args: { channel: 'A', delta: 5 } },
          ],
        };
      }
    }

    const device = new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' });
    const runtime = new AgentRuntime({
      device,
      llm: new LegacyNameAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxAdjustStrengthCallsPerTurn: 1,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'legacy-alias',
      text: '继续加一点',
      context: { sessionId: 'legacy-alias', sourceType: 'cli', traceId: 'trace-legacy-alias' },
    });

    // First legacy-name call executed via the alias; the second hit the same
    // shared per-turn quota rather than slipping past it under the old name.
    const executed = events.filter((event) => event.type === 'device-command-executed');
    expect(executed).toHaveLength(1);
    const denied = events.filter((event) => event.type === 'tool-call-denied');
    expect(denied).toHaveLength(1);
  });

  it('applies a configurable single-step adjust_strength cap', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LargeAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxAdjustStep: 15,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '鍔犲ぇ涓€鐐?',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-adjust-step-cap',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(25);
  });

  it('applies a configurable cold-start strength cap to start', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new LargeStartLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxColdStartStrength: 12,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '鍚姩 A',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-cold-start-cap',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(12);
  });

  it('still asks for permission after a clamp instead of silently executing the clamped command', async () => {
    // Issue #65: a clamp rule (here step-adjust, max ±10) used to short-
    // circuit the policy engine and skip past permission-gate. So an
    // "+12" adjust in "每次询问" mode would clamp to +10 and execute
    // without ever asking the user — and PR #76's clamp visibility was
    // only half the story.
    const permission = new CountingPermission();
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LargeAdjustLlm(),
      permission,
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxAdjustStep: 10,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'clamp-then-confirm',
      text: '调高一点',
      context: {
        sessionId: 'clamp-then-confirm',
        sourceType: 'cli',
        traceId: 'trace-clamp-confirm',
      },
    });

    // Permission was asked exactly once, even though step-adjust clamped.
    expect(permission.callCount).toBe(1);
    // Clamp event still fires with the original (+25) and adjusted (+10).
    const clamped = events.find((event) => event.type === 'tool-call-clamped');
    expect(clamped).toBeDefined();
    if (!clamped || clamped.type !== 'tool-call-clamped') throw new Error('expected clamp event');
    if (
      clamped.originalCommand.type === 'adjustStrength' &&
      clamped.adjustedCommand.type === 'adjustStrength'
    ) {
      expect(clamped.originalCommand.delta).toBe(25);
      expect(clamped.adjustedCommand.delta).toBe(10);
    }
    // And the device only moved by the clamped delta.
    const session = await runtime.getSessionSnapshot('clamp-then-confirm');
    expect(session.deviceState.strengthA).toBe(20);
  });

  it('rejects the call when permission is denied even after a clamp', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LargeAdjustLlm(),
      permission: new DenyingPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxAdjustStep: 10,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'clamp-then-deny',
      text: '调高一点',
      context: {
        sessionId: 'clamp-then-deny',
        sourceType: 'cli',
        traceId: 'trace-clamp-deny',
      },
    });

    expect(
      events.some(
        (event) =>
          event.type === 'device-command-executed' && event.command.type === 'adjustStrength',
      ),
    ).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('拒绝');
    const session = await runtime.getSessionSnapshot('clamp-then-deny');
    expect(session.deviceState.strengthA).toBe(10);
  });

  it('emits tool-call-clamped with original and adjusted commands when policy clamps', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new LargeStartLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxColdStartStrength: 12,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'clamp-event',
      text: '启动 A',
      context: {
        sessionId: 'clamp-event',
        sourceType: 'cli',
        traceId: 'trace-clamp-event',
      },
    });

    const clamped = events.find((event) => event.type === 'tool-call-clamped');
    expect(clamped).toBeDefined();
    if (!clamped || clamped.type !== 'tool-call-clamped') throw new Error('expected clamp event');
    expect(clamped.originalCommand.type).toBe('start');
    expect(clamped.adjustedCommand.type).toBe('start');
    if (clamped.originalCommand.type !== 'start' || clamped.adjustedCommand.type !== 'start') {
      throw new Error('expected start commands');
    }
    expect(clamped.originalCommand.strength).toBe(30);
    expect(clamped.adjustedCommand.strength).toBe(12);
    expect(clamped.reason).toContain('冷启动');

    const executing = events.find(
      (event) =>
        event.type === 'tool-call-executing' &&
        event.command?.type === 'start' &&
        event.clampedFrom !== undefined,
    );
    expect(executing).toBeDefined();
  });

  it('feeds clamp details back to the LLM so it cannot ignore the adjustment', async () => {
    class CapturingLlm implements LlmClient {
      capturedToolOutput: string | null = null;
      private callCount = 0;
      async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
        this.callCount += 1;
        if (this.callCount === 1) {
          return {
            assistantMessage: '尝试启动',
            toolCalls: [
              {
                id: 'tool-clamp-feedback',
                name: 'shock_start',
                args: { channel: 'A', strength: 30, waveformId: 'pulse_mid', loop: true },
              },
            ],
          };
        }
        const lastOutput = input.conversation
          ?.filter((item) => item.kind === 'function_call_output')
          .pop();
        if (lastOutput && 'output' in lastOutput && typeof lastOutput.output === 'string') {
          this.capturedToolOutput = lastOutput.output;
        }
        return { assistantMessage: '已按策略调整后启动。' };
      }
    }

    const llm = new CapturingLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(createDefaultPolicyRules({ maxColdStartStrength: 12 })),
      toolCallConfig: { maxToolIterations: 2 },
    });

    await runtime.sendUserMessage({
      sessionId: 'clamp-feedback',
      text: '启动 A',
      context: {
        sessionId: 'clamp-feedback',
        sourceType: 'cli',
        traceId: 'trace-clamp-feedback',
      },
    });

    expect(llm.capturedToolOutput).not.toBeNull();
    const parsed = JSON.parse(llm.capturedToolOutput ?? '{}');
    expect(parsed.ok).toBe('clamped');
    expect(parsed.clampedFrom).toBeDefined();
    expect(parsed.clampedFrom.strength).toBe(30);
    expect(parsed.command.strength).toBe(12);
    expect(parsed._warning).toContain('策略限制');
    expect(parsed.notes.some((note: string) => note.startsWith('policy-clamped:'))).toBe(true);
  });

  it('cancels scheduled timer continuations during emergency stop', async () => {
    vi.useFakeTimers();
    try {
      const llm = new TimerFollowUpLlm();
      const runtime = new AgentRuntime({
        device: new TestDevice(),
        llm,
        permission: new TestPermission(),
        waveformLibrary: createBasicWaveformLibrary(),
      });
      await runtime.sendUserMessage({
        sessionId: 'cancel-timer-stop',
        text: '等一秒',
        context: {
          sessionId: 'cancel-timer-stop',
          sourceType: 'cli',
          traceId: 'cancel-timer-stop',
        },
      });

      await runtime.emergencyStop('cancel-timer-stop');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(llm.toolCountsBySource.filter((call) => call.sourceType === 'system')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases its device-state listener and safely stops output on dispose', async () => {
    const device = new TestDevice({ strengthA: 20, waveActiveA: true });
    expect(device.listenerCount).toBe(0);

    const first = new AgentRuntime({
      device,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    expect(device.listenerCount).toBe(1);

    const second = new AgentRuntime({
      device,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    expect(device.listenerCount).toBe(2);

    first.dispose();
    await Promise.resolve();
    expect(device.listenerCount).toBe(1);
    expect((await device.getState()).strengthA).toBe(0);

    second.dispose();
    expect(device.listenerCount).toBe(0);

    // Calling dispose twice is a no-op.
    first.dispose();
    expect(device.listenerCount).toBe(0);
  });

  it('blocks burst on inactive channels when configured', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: true,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'burst',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-burst-block',
      },
    });

    expect(
      events.some(
        (event) => event.type === 'device-command-executed' && event.command.type === 'burst',
      ),
    ).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('还没有运行');
  });

  it('rejects every burst call when maxBurstCallsPerTurn is 0 ("disable bursts" opt-out)', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 20, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxBurstCallsPerTurn: 0,
        burstRequiresActiveChannel: false,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'burst-off',
      text: 'burst',
      context: {
        sessionId: 'burst-off',
        sourceType: 'cli',
        traceId: 'trace-burst-disabled',
      },
    });

    expect(
      events.some(
        (event) => event.type === 'device-command-executed' && event.command.type === 'burst',
      ),
    ).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('已被用户在设置中关闭');
    // Strength must not have moved.
    const session = await runtime.getSessionSnapshot('burst-off');
    expect(session.deviceState.strengthA).toBe(20);
  });

  it('allows burst on inactive channels when the tool-call config disables that guard', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'burst',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-burst-allow',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(40);
  });

  it('clamps burst to the absolute strength cap when configured', async () => {
    // Issue #68: a burst-only absolute cap (here 30) must clamp burst.strength
    // even when the per-channel max (default 50) would allow more.
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(), // tries burst at strength 40
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxBurstStrengthAbsolute: 30,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'burst-abs-cap',
      text: 'burst',
      context: {
        sessionId: 'burst-abs-cap',
        sourceType: 'cli',
        traceId: 'trace-burst-abs',
      },
    });

    const session = await runtime.getSessionSnapshot('burst-abs-cap');
    expect(session.deviceState.strengthA).toBe(30);
  });

  it('clamps burst to current strength + relative cap', async () => {
    // current = 25, relative cap = 10 → burst can't exceed 35.
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 25, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(), // tries burst at strength 40
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxBurstStrengthRelative: 10,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'burst-rel-cap',
      text: 'burst',
      context: {
        sessionId: 'burst-rel-cap',
        sourceType: 'cli',
        traceId: 'trace-burst-rel',
      },
    });

    const session = await runtime.getSessionSnapshot('burst-rel-cap');
    expect(session.deviceState.strengthA).toBe(35);
  });

  it('takes the tighter of absolute and per-channel caps when both apply to a burst', async () => {
    // Channel cap 30, burst absolute cap 80, current strength 5.
    // The channel cap wins — burst can't exceed 30. Verifies that the
    // policy loop introduced by #65 lets channel-cap and burst-cap stack
    // instead of racing for "first clamp wins".
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 5, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxStrengthA: 30,
          maxStrengthB: 30,
          maxBurstStrengthAbsolute: 80,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'burst-stacked-caps',
      text: 'burst',
      context: {
        sessionId: 'burst-stacked-caps',
        sourceType: 'cli',
        traceId: 'trace-burst-stack',
      },
    });

    const session = await runtime.getSessionSnapshot('burst-stacked-caps');
    expect(session.deviceState.strengthA).toBe(30);
  });

  it('applies a configurable burst duration cap', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LongBurstLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxBurstDurationMs: 1200,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'burst 久一点',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-burst-duration-cap',
      },
    });

    const executed = events.find(
      (
        event,
      ): event is Extract<RuntimeEvent, { type: 'device-command-executed' }> & {
        command: Extract<DeviceCommand, { type: 'burst' }>;
      } => event.type === 'device-command-executed' && event.command.type === 'burst',
    );
    expect(executed?.command.durationMs ?? null).toBe(1200);
  });

  it('accepts legacy "waveform" arg name on the start tool', async () => {
    class LegacyStartArgsLlm implements LlmClient {
      async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
        const hasToolOutput = input.conversation?.some(
          (item) => item.kind === 'function_call_output',
        );
        return hasToolOutput
          ? { assistantMessage: '老参数启动完成。' }
          : {
              assistantMessage: '使用老参数启动',
              toolCalls: [
                {
                  id: 'tool-legacy-start',
                  name: 'shock_start',
                  args: { channel: 'A', strength: 8, waveform: 'pulse_mid', loop: true },
                },
              ],
            };
      }
    }

    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new LegacyStartArgsLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    await runtime.sendUserMessage({
      sessionId: 'legacy-start',
      text: '用老参数启动',
      context: { sessionId: 'legacy-start', sourceType: 'cli', traceId: 'trace-legacy-start' },
    });
    const session = await runtime.getSessionSnapshot('legacy-start');
    expect(session.deviceState.currentWaveA).toBe('pulse_mid');
    expect(session.deviceState.strengthA).toBe(8);
  });

  it('accepts legacy "duration_ms" arg name on the burst tool', async () => {
    class LegacyBurstArgsLlm implements LlmClient {
      async runTurn() {
        return {
          assistantMessage: '使用老参数 burst',
          toolCalls: [
            {
              id: 'tool-legacy-burst',
              name: 'shock_burst',
              args: { channel: 'A', strength: 35, duration_ms: 800 },
            },
          ],
        };
      }
    }

    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 12, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LegacyBurstArgsLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1, burstRequiresActiveChannel: false },
    });
    await runtime.sendUserMessage({
      sessionId: 'legacy-burst',
      text: '用老参数 burst',
      context: { sessionId: 'legacy-burst', sourceType: 'cli', traceId: 'trace-legacy-burst' },
    });
    const session = await runtime.getSessionSnapshot('legacy-burst');
    expect(session.deviceState.strengthA).toBe(35);
  });
});
