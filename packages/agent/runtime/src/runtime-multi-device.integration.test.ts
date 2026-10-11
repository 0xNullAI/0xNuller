import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '@dg-agent/core';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import { AgentRuntime } from './agent-runtime.js';
import {
  OpossumVibrateAdjustLlm,
  OpossumVibrateStartLlm,
  RepeatedVibrateAdjustLlm,
  SetIndicatorColorLlm,
  TestCivetEdgingClient,
  TestOpossumClient,
  TestPawPrintsClient,
} from './runtime-multi-device.test-support.js';
import { TestDevice, TestLlm, TestPermission } from './runtime.test-support.js';

describe('AgentRuntime multi-device Opossum and sensor summaries', () => {
  it('clamps opossum cold-start intensity to the default cap and dispatches through the opossum plan', async () => {
    const opossum = new TestOpossumClient();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      opossum,
      llm: new OpossumVibrateStartLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-cold-start',
      text: '启动负鼠 A 通道',
      context: { sessionId: 'opossum-cold-start', sourceType: 'cli', traceId: 'trace-opossum-1' },
    });

    const state = await opossum.getState();
    expect(state.intensityA).toBe(10); // DEFAULT_MAX_OPOSSUM_COLD_START_INTENSITY
  });

  it('applies the opossum step-adjust cap', async () => {
    const opossum = new TestOpossumClient({ intensityA: 10 });
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      opossum,
      llm: new OpossumVibrateAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-step-cap',
      text: '调高负鼠振动',
      context: { sessionId: 'opossum-step-cap', sourceType: 'cli', traceId: 'trace-opossum-2' },
    });

    const state = await opossum.getState();
    // current 10 + clamped delta (10, the default step cap) = 20, not 35.
    expect(state.intensityA).toBe(20);
  });

  it('clamps vibrate_burst intensity to the opossum per-channel cap', async () => {
    class OpossumBurstLlm implements LlmClient {
      async runTurn() {
        return {
          assistantMessage: '来一段短促强振',
          toolCalls: [
            {
              id: 'tool-vibrate-burst-1',
              name: 'vibrate_burst',
              args: { channel: 'A', intensity: 200, durationMs: 800 },
            },
          ],
        };
      }
    }

    const opossum = new TestOpossumClient({ intensityA: 20 });
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      opossum,
      llm: new OpossumBurstLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-burst-cap',
      text: '猛一下',
      context: {
        sessionId: 'opossum-burst-cap',
        sourceType: 'cli',
        traceId: 'trace-opossum-burst',
      },
    });

    const state = await opossum.getState();
    // 200 requested, clamped to DEFAULT_USER_MAX_OPOSSUM_INTENSITY (50).
    expect(state.intensityA).toBe(50);
  });

  it('executes vibrate_change_pattern as an opossum plan', async () => {
    class OpossumPatternLlm implements LlmClient {
      async runTurn() {
        return {
          assistantMessage: '切换节奏',
          toolCalls: [
            {
              id: 'tool-vibrate-pattern-1',
              name: 'vibrate_change_pattern',
              args: { channel: 'A', pattern: 'heartbeat' },
            },
          ],
        };
      }
    }

    const opossum = new TestOpossumClient({ intensityA: 20 });
    const executed: OpossumCommand[] = [];
    const originalExecute = opossum.execute.bind(opossum);
    opossum.execute = async (command) => {
      executed.push(command);
      return originalExecute(command);
    };

    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      opossum,
      llm: new OpossumPatternLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-pattern',
      text: '换成心跳节奏',
      context: {
        sessionId: 'opossum-pattern',
        sourceType: 'cli',
        traceId: 'trace-opossum-pattern',
      },
    });

    expect(executed).toEqual([{ type: 'vibrateSetPattern', channel: 'A', pattern: 'heartbeat' }]);
  });

  it('denies vibrate_start with a device-specific message when opossum is not connected, without touching coyote', async () => {
    const llm = new OpossumVibrateStartLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: true }),
      // No opossum client registered at all.
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-disconnected',
      text: '启动负鼠',
      context: {
        sessionId: 'opossum-disconnected',
        sourceType: 'cli',
        traceId: 'trace-opossum-disconnected',
      },
    });

    const session = await runtime.getSessionSnapshot('opossum-disconnected');
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接负鼠。',
    );
  });

  it('dispatches set_indicator_color to the paw-prints client', async () => {
    const pawPrints = new TestPawPrintsClient();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      pawPrints,
      llm: new SetIndicatorColorLlm('paw-prints'),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'indicator-paw-prints',
      text: '把爪印灯光换成紫色',
      context: {
        sessionId: 'indicator-paw-prints',
        sourceType: 'cli',
        traceId: 'trace-indicator-1',
      },
    });

    expect(pawPrints.ledCalls).toEqual([3]);
  });

  it('denies set_indicator_color when the client is connected but has no LED support', async () => {
    const civetEdging = new TestCivetEdgingClient(); // no setIndicatorColor override
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: true }),
      civetEdging,
      llm: new SetIndicatorColorLlm('civet-edging'),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'indicator-civet-no-led',
      text: '把灵猫灯光换成紫色',
      context: {
        sessionId: 'indicator-civet-no-led',
        sourceType: 'cli',
        traceId: 'trace-indicator-3',
      },
    });

    const session = await runtime.getSessionSnapshot('indicator-civet-no-led');
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接灵猫。',
    );
  });

  it('denies set_indicator_color when the targeted device kind is not connected, naming that device', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: true }),
      // civet-edging not registered.
      llm: new SetIndicatorColorLlm('civet-edging'),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'indicator-civet-missing',
      text: '把灵猫灯光换成紫色',
      context: {
        sessionId: 'indicator-civet-missing',
        sourceType: 'cli',
        traceId: 'trace-indicator-2',
      },
    });

    const session = await runtime.getSessionSnapshot('indicator-civet-missing');
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接灵猫。',
    );
  });

  it('buffers paw-prints trigger and civet-edging pressure readings into rolling summaries, independent of the sensor-trigger opt-in toggle', async () => {
    class PlainReplyLlm implements LlmClient {
      async runTurn() {
        return { assistantMessage: '好的' };
      }
    }

    const pawPrints = new TestPawPrintsClient();
    const civetEdging = new TestCivetEdgingClient();
    let capturedPawPrintsSummary: string | undefined;
    let capturedCivetSummary: string | undefined;

    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      pawPrints,
      civetEdging,
      llm: new PlainReplyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      buildInstructions: (input) => {
        capturedPawPrintsSummary = input.pawPrintsSummary;
        capturedCivetSummary = input.civetSummary;
        return '';
      },
    });

    // Deliberately never called setSensorTriggersEnabled — the buffer must
    // still accumulate, unlike SensorTriggerEngine's own opt-in prompts.
    pawPrints.pushReading({ type: 'trigger', eventId: 1, parameterValue: 5 });
    // physical readings are posture/acceleration noise, not trigger events —
    // must not count toward the buffered trigger total.
    pawPrints.pushReading({
      type: 'physical',
      sequence: 1,
      pressState: 0,
      acceleration: 0,
      angleX: 0,
      angleY: 0,
      angleZ: 0,
      extVoltage: 0,
    });
    civetEdging.pushReading({ type: 'pressure', kPa: 12 });

    await runtime.sendUserMessage({
      sessionId: 'buffer-session',
      text: '你好',
      context: { sessionId: 'buffer-session', sourceType: 'cli', traceId: 'trace-buffer-1' },
    });

    expect(capturedPawPrintsSummary).toBe('60s 内触发 1 次，最近事件1');
    expect(capturedCivetSummary).toContain('当前 12.0kPa');
  });

  it('enforces configurable per-turn vibrate_adjust quotas', async () => {
    const opossum = new TestOpossumClient({ intensityA: 10 });
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      opossum,
      llm: new RepeatedVibrateAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxVibrateAdjustCallsPerTurn: 1,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '负鼠继续加一点',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-vibrate-quota',
      },
    });

    const denied = events.filter((event) => event.type === 'tool-call-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0] && 'reason' in denied[0] ? denied[0].reason : '').toContain('vibrate_adjust');
  });

  it('emergency stop silences Opossum even when the Coyote stop fails', async () => {
    const device = new TestDevice();
    device.emergencyStop = async () => {
      throw new Error('Coyote transport failed');
    };
    const opossum = new TestOpossumClient({ intensityA: 40, intensityB: 20 });
    const runtime = new AgentRuntime({
      device,
      opossum,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await expect(runtime.emergencyStop('best-effort-stop')).resolves.toBeUndefined();
    expect((await opossum.getState()).intensityA).toBe(0);
  });

  it('emergency stop also silences a connected opossum device', async () => {
    const opossum = new TestOpossumClient({ intensityA: 40, intensityB: 20 });
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      opossum,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.emergencyStop('any-session');

    const state = await opossum.getState();
    expect(state.intensityA).toBe(0);
    expect(state.intensityB).toBe(0);
  });
});
