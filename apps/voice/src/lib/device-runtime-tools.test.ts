import { describe, expect, it, vi } from 'vitest';
import { AiDeviceToolAdapter, type BoundDeviceTools } from '@0xnullai/device-runtime';
import { ToolRegistry } from '@dg-kit/tools';
import { listVoiceToolDefinitions, VoiceCompositeToolExecutor } from './device-runtime-tools.js';

const context = { sessionId: 'voice', sourceType: 'web' as const, traceId: 'voice-trace' };

function runtimeHarness() {
  const invoke = vi.fn(async (_name: string, input: unknown) => ({ input }));
  const tools = { invoke } as unknown as BoundDeviceTools;
  return { adapter: new AiDeviceToolAdapter({ tools: () => tools }), invoke };
}

describe('Voice generic device tools', () => {
  it('converts the allowlist to Voice definitions without replacing legacy DG tools', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'shock_stop',
      definition: {
        name: 'shock_stop',
        description: 'legacy',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: () => ({ type: 'inline', output: 'legacy' }),
    });
    const { adapter } = runtimeHarness();
    expect((await listVoiceToolDefinitions(registry, adapter)).map((tool) => tool.name)).toEqual([
      'shock_stop',
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);
  });

  it('routes runtime names with the provider call id and leaves legacy names unchanged', async () => {
    const legacy = { execute: vi.fn(async () => ({ toolCallId: 'legacy', output: 'legacy' })) };
    const permission = { request: vi.fn(async () => ({ type: 'approve-once' as const })) };
    const onRuntimeToolComplete = vi.fn(async () => undefined);
    const { adapter, invoke } = runtimeHarness();
    const executor = new VoiceCompositeToolExecutor({
      legacy,
      runtime: adapter,
      permission,
      context,
      onRuntimeToolComplete,
    });

    await executor.execute({
      id: 'voice-tool-call',
      name: 'device_vibrate',
      args: {
        deviceId: 'opaque-device',
        featureId: 'opaque-feature',
        intensity: 0.2,
        outputLeaseMs: 300,
      },
    });
    expect(permission.request).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('device_vibrate', {
      interactionId: 'voice-tool-call',
      deviceId: 'opaque-device',
      featureId: 'opaque-feature',
      intensity: 0.2,
      outputLeaseMs: 300,
    });
    expect(onRuntimeToolComplete).toHaveBeenCalledTimes(1);

    const legacyCall = { id: 'old', name: 'shock_stop', args: { channel: 'A' } };
    await executor.execute(legacyCall);
    expect(legacy.execute).toHaveBeenCalledWith(legacyCall);
  });

  it('keeps runtime vibration behind Voice permission while stop remains reachable', async () => {
    const legacy = { execute: vi.fn() };
    const permission = {
      request: vi.fn(async () => ({ type: 'deny' as const, reason: 'denied locally' })),
    };
    const { adapter, invoke } = runtimeHarness();
    const executor = new VoiceCompositeToolExecutor({
      legacy,
      runtime: adapter,
      permission,
      context,
    });

    const denied = await executor.execute({
      id: 'deny-vibrate',
      name: 'device_vibrate',
      args: {
        deviceId: 'device',
        featureId: 'feature',
        intensity: 0.2,
        outputLeaseMs: 300,
      },
    });
    expect(JSON.parse(denied.output)).toMatchObject({ error: 'denied locally' });
    expect(invoke).not.toHaveBeenCalled();

    await executor.execute({
      id: 'stop-now',
      name: 'device_emergency_stop',
      args: {},
    });
    expect(permission.request).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('device_emergency_stop', {
      interactionId: 'stop-now',
    });
  });
});
