import { describe, expect, it, vi } from 'vitest';
import {
  AiDeviceToolAdapter,
  AI_DEVICE_TOOL_CATALOG,
  AI_DEVICE_TOOL_DISPLAY_NAMES,
  aiDeviceToolRequiresPermission,
  appendAiDeviceRuntimeStatus,
  createAiDeviceToolAdapter,
  isAiDeviceToolName,
  sanitizeAiDeviceSnapshot,
} from './ai-adapter.js';
import type {
  BackendEvent,
  DeviceBackend,
  DeviceBackendSession,
  DeviceSnapshot,
} from './contracts.js';
import { DeviceRuntimeExecutor } from './executor.js';
import { DeviceRuntimeManager } from './manager.js';
import { SharedDeviceRuntimeProvider } from './runtime-provider.js';
import { DeviceToolProvider, type BoundDeviceTools } from './tool-provider.js';

function boundToolsHarness() {
  const invoke = vi.fn(async (_name: string, input: unknown) => input);
  const tools = { invoke } as unknown as BoundDeviceTools;
  const adapter = new AiDeviceToolAdapter({ tools: () => tools });
  return { adapter, invoke };
}

function backendHarness() {
  let emit: (event: unknown) => void = () => undefined;
  const session: DeviceBackendSession = {
    scan: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    writeVibrate: vi.fn(async () => undefined),
    stopFeature: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const backend: DeviceBackend = {
    openSession: vi.fn(async (listener) => {
      emit = listener;
      return session;
    }),
  };
  return { backend, session, emit: (event: BackendEvent) => emit(event) };
}

const safetyPolicy = () => ({
  intensityCap: 1,
  maxIncrease: 1,
  coldStartCap: 1,
  maxOutputLeaseMs: 5_000,
});

function publishVibrateDevice(emit: (event: BackendEvent) => void) {
  emit({
    version: 1,
    type: 'topology',
    devices: [
      {
        nativeDeviceId: 'native-secret',
        name: 'Do not put this label in prompts',
        capabilities: [{ kind: 'vibrate', nativeFeatureId: 'native-vibrate', stepCount: 10 }],
      },
    ],
  });
}

describe('AI device adapter allowlist', () => {
  it('exposes only the positive allowlist and removes interactionId from model schemas', () => {
    expect(AI_DEVICE_TOOL_CATALOG.map((tool) => tool.name)).toEqual([
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);
    expect(isAiDeviceToolName('device_scan')).toBe(false);
    expect(isAiDeviceToolName('device_disconnect')).toBe(false);
    expect(isAiDeviceToolName('device_raw')).toBe(false);
    expect(JSON.stringify(AI_DEVICE_TOOL_CATALOG)).not.toMatch(/scan|disconnect|raw/i);

    for (const tool of AI_DEVICE_TOOL_CATALOG) {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).not.toHaveProperty('interactionId');
      expect(schema.required).not.toContain('interactionId');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(
      (
        AI_DEVICE_TOOL_CATALOG.find((tool) => tool.name === 'device_vibrate')!.inputSchema as {
          required: string[];
        }
      ).required,
    ).toEqual(['deviceId', 'featureId', 'intensity', 'outputLeaseMs']);
  });

  it('shares display copy and classifies only output-increasing calls for upper consent', () => {
    expect(AI_DEVICE_TOOL_DISPLAY_NAMES.device_stop).toBe('停止通用设备功能');
    expect(aiDeviceToolRequiresPermission('device_vibrate')).toBe(true);
    expect(aiDeviceToolRequiresPermission('device_stop')).toBe(false);
    expect(aiDeviceToolRequiresPermission('device_scan')).toBe(false);
  });

  it('requires exact opaque IDs and injects the trusted tool-call ID', async () => {
    const { adapter, invoke } = boundToolsHarness();
    await adapter.invoke({
      id: 'voice-call-42',
      name: 'device_vibrate',
      args: {
        deviceId: 'opaque-device',
        featureId: 'opaque-feature',
        intensity: 0.4,
        outputLeaseMs: 500,
      },
    });
    expect(invoke).toHaveBeenCalledWith('device_vibrate', {
      interactionId: 'voice-call-42',
      deviceId: 'opaque-device',
      featureId: 'opaque-feature',
      intensity: 0.4,
      outputLeaseMs: 500,
    });

    await expect(
      adapter.invoke({
        id: 'guessed-name',
        name: 'device_vibrate',
        args: { deviceName: 'toy', featureName: 'motor', intensity: 0.4, outputLeaseMs: 500 },
      }),
    ).rejects.toThrow(/unknown field/);
    await expect(
      adapter.invoke({
        id: 'model-owned-id',
        name: 'device_stop',
        args: { interactionId: 'attacker', deviceId: 'device', featureId: 'feature' },
      }),
    ).rejects.toThrow(/unknown field/);
    await expect(
      adapter.invoke({ id: 'raw', name: 'device_raw' as never, args: {} }),
    ).rejects.toThrow(/not allowed/);
  });

  it('fails closed on module-lease mismatch without writing output', async () => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'opaque' });
    await manager.start();
    publishVibrateDevice(harness.emit);
    const snapshot = manager.snapshot();
    const device = snapshot.devices[0]!;
    const feature = device.capabilities[0]!;
    const executor = new DeviceRuntimeExecutor(manager, {
      permissionPolicy: { authorize: async () => 'allow' },
      safetyPolicy,
      leaseSnapshot: () => ({ holder: 'control', epoch: 7 }),
    });
    const adapter = new AiDeviceToolAdapter({
      tools: () => new DeviceToolProvider(manager, executor).forModule('agent'),
    });

    await expect(
      adapter.invoke({
        id: 'missing-exact-feature',
        name: 'device_vibrate',
        args: { deviceId: device.deviceId, intensity: 0.2, outputLeaseMs: 100 },
      }),
    ).rejects.toThrow(/missing field/);
    await expect(
      adapter.invoke({
        id: 'lease-mismatch',
        name: 'device_vibrate',
        args: {
          deviceId: device.deviceId,
          featureId: feature.featureId,
          intensity: 0.2,
          outputLeaseMs: 100,
        },
      }),
    ).resolves.toMatchObject({ status: 'rejected', code: 'stale-lease' });
    expect(harness.session.writeVibrate).not.toHaveBeenCalled();
  });

  it('reuses one shared provider for independent Agent and Voice adapters', async () => {
    const harness = backendHarness();
    const provider = new SharedDeviceRuntimeProvider({
      backendFactory: () => harness.backend,
      executorOptions: {
        permissionPolicy: { authorize: async () => 'allow' },
        safetyPolicy,
        leaseSnapshot: () => ({ holder: 'agent', epoch: 1 }),
      },
    });
    const agent = createAiDeviceToolAdapter(provider, 'agent');
    const voice = createAiDeviceToolAdapter(provider, 'voice');

    expect(agent.snapshot()).toBeNull();
    expect(harness.backend.openSession).not.toHaveBeenCalled();

    const [agentSnapshot, voiceSnapshot] = await Promise.all([
      agent.invoke({ id: 'agent-snapshot', name: 'device_snapshot', args: {} }),
      voice.invoke({ id: 'voice-snapshot', name: 'device_snapshot', args: {} }),
    ]);
    expect(harness.backend.openSession).toHaveBeenCalledTimes(1);
    expect((agentSnapshot as DeviceSnapshot).sessionId).toBe(
      (voiceSnapshot as DeviceSnapshot).sessionId,
    );
    // An empty runtime is deliberately absent from model context even after it has opened.
    expect(agent.snapshot()).toBeNull();
  });

  it('appends only opaque runtime IDs and capabilities to existing instructions', () => {
    const snapshot: DeviceSnapshot = {
      version: 1,
      sessionId: 'session-opaque' as DeviceSnapshot['sessionId'],
      sequence: 1,
      topologyGeneration: 1,
      safetyGeneration: 1,
      devices: [
        {
          deviceId: 'device-opaque' as DeviceSnapshot['devices'][number]['deviceId'],
          name: 'Private device label',
          capabilities: [
            {
              kind: 'vibrate',
              featureId: 'feature-opaque' as never,
              stepCount: 20,
              faulted: false,
            },
          ],
        },
      ],
    };
    const original = 'PERSONA\n\nUNCHANGED RULES';
    const result = appendAiDeviceRuntimeStatus(original, snapshot);
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain('device-opaque');
    expect(result).toContain('feature-opaque');
    expect(result).toContain('vibrate');
    expect(result).not.toContain('Private device label');
    const sanitized = sanitizeAiDeviceSnapshot(snapshot);
    expect(sanitized.devices[0]!.name).toBe('Connected device');
    expect(JSON.stringify(sanitized)).not.toContain('Private device label');
    expect(appendAiDeviceRuntimeStatus(original, null)).toBe(original);
    expect(appendAiDeviceRuntimeStatus(original, { ...snapshot, devices: [] })).toBe(original);
  });

  it('exposes no model tools while disabled, disconnected, or lacking a healthy vibration target', () => {
    let enabled = false;
    let snapshot: DeviceSnapshot | null = null;
    const adapter = new AiDeviceToolAdapter({
      tools: () => ({ invoke: vi.fn() }) as unknown as BoundDeviceTools,
      enabled: () => enabled,
      snapshot: () => snapshot,
    });

    expect(adapter.definitions()).toEqual([]);
    enabled = true;
    snapshot = {
      version: 1,
      sessionId: 'session' as DeviceSnapshot['sessionId'],
      sequence: 1,
      topologyGeneration: 1,
      safetyGeneration: 1,
      devices: [],
    };
    expect(adapter.definitions()).toEqual([]);

    snapshot = {
      ...snapshot,
      devices: [
        {
          deviceId: 'device' as DeviceSnapshot['devices'][number]['deviceId'],
          name: 'device',
          capabilities: [
            { kind: 'battery', featureId: 'battery' as never, value: 80 },
            { kind: 'vibrate', featureId: 'vibrate' as never, stepCount: 20, faulted: true },
          ],
        },
      ],
    };
    expect(adapter.definitions()).toEqual([]);

    snapshot = {
      ...snapshot,
      devices: [
        {
          ...snapshot.devices[0]!,
          capabilities: [
            snapshot.devices[0]!.capabilities[0]!,
            {
              kind: 'vibrate',
              featureId: 'vibrate' as never,
              stepCount: 20,
              faulted: false,
            },
          ],
        },
      ],
    };
    expect(adapter.definitions().map((definition) => definition.name)).toEqual([
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);
  });
});
