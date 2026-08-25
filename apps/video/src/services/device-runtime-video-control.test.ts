import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SharedDeviceRuntimeProvider,
  type BackendDevice,
  type DeviceBackend,
  type DeviceBackendSession,
  type DeviceId,
  type FeatureId,
} from '@0xnullai/device-runtime';
import type { LlmClient, LlmImageInput, LlmTurnInput } from '@dg-agent/core';
import { DeviceRuntimeVideoControlService } from './device-runtime-video-control.js';

const FRAME: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'ephemeral-image',
  width: 2,
  height: 2,
  byteLength: 15,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function backendHarness(devices: BackendDevice[] = [vibrateDevice('native-one')]) {
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
  const provider = new SharedDeviceRuntimeProvider({
    backendFactory: () => backend,
    executorOptions: {
      permissionPolicy: { authorize: async () => 'allow' },
      safetyPolicy: () => ({
        intensityCap: 1,
        maxIncrease: 1,
        coldStartCap: 1,
        maxOutputLeaseMs: 5_000,
      }),
      leaseSnapshot: () => ({ holder: 'video', epoch: 1 }),
    },
  });
  return {
    provider,
    session,
    emitTopology: (nextDevices: BackendDevice[]) =>
      emit({ version: 1, type: 'topology', devices: nextDevices }),
    async start() {
      const runtime = await provider.start();
      this.emitTopology(devices);
      await flush();
      vi.mocked(session.stopAll).mockClear();
      return runtime;
    },
  };
}

function vibrateDevice(nativeDeviceId: string, name = 'Embedded device'): BackendDevice {
  return {
    nativeDeviceId,
    name,
    capabilities: [
      { kind: 'vibrate', nativeFeatureId: 'vibrate', stepCount: 100 },
      { kind: 'battery', nativeFeatureId: 'battery', value: 0.5 },
    ],
  };
}

function textOnlyDevice(nativeDeviceId: string): BackendDevice {
  return {
    nativeDeviceId,
    name: 'Telemetry only',
    capabilities: [{ kind: 'battery', nativeFeatureId: 'battery', value: 0.5 }],
  };
}

function target(provider: SharedDeviceRuntimeProvider) {
  const device = provider.current()!.snapshot().devices[0]!;
  const feature = device.capabilities.find((capability) => capability.kind === 'vibrate')!;
  return { deviceId: device.deviceId, featureId: feature.featureId };
}

function grantInput(deviceId: DeviceId, featureId: FeatureId, overrides = {}) {
  return {
    deviceId,
    featureId,
    intensityCap: 0.4,
    allowEnhanced: true,
    durationMs: 60_000,
    cadenceMs: 10_000,
    captureIntervalMs: 1_000,
    ...overrides,
  };
}

function llmWithCalls(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  inputs: LlmTurnInput[] = [],
): LlmClient {
  return {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async (input) => {
      inputs.push(input);
      return { assistantMessage: 'ok', toolCalls: calls };
    }),
  };
}

function createService(
  provider: SharedDeviceRuntimeProvider,
  llm: LlmClient | null,
  options: {
    maxOutputLeaseMs?: number;
    safetyIntensityCap?: number;
    onEffectSettled?: (output: string | null) => void;
  } = {},
) {
  return new DeviceRuntimeVideoControlService({
    provider,
    llm,
    scene: { name: 'Video scene', prompt: '独立的 Video 场景提示。' },
    hasLease: () => true,
    getMaxOutputLeaseMs: () => options.maxOutputLeaseMs ?? 5_000,
    getSafetyIntensityCap: () => options.safetyIntensityCap ?? 1,
    interactionIdFactory: (action) => `local-${action}`,
    onEffectSettled: (_call, output) => options.onEffectSettled?.(output),
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DeviceRuntime Video grant and model boundary', () => {
  it('requires an exact grant and an existing vibration feature', async () => {
    const harness = backendHarness();
    await harness.start();
    const service = createService(harness.provider, null);
    const ids = target(harness.provider);

    await expect(
      service.authorize({ ...grantInput(ids.deviceId, ids.featureId), allowBurst: true }),
    ).rejects.toThrow('未知字段');
    await expect(
      service.authorize(grantInput(ids.deviceId, 'missing' as FeatureId)),
    ).rejects.toThrow('不是振动功能');

    harness.emitTopology([textOnlyDevice('telemetry')]);
    const telemetry = harness.provider.current()!.snapshot().devices[0]!;
    await expect(
      service.authorize(grantInput(telemetry.deviceId, telemetry.capabilities[0]!.featureId)),
    ).rejects.toThrow('不是振动功能');
  });

  it('exposes only snapshot/vibrate/stop/emergency with exact single-value IDs and local interactions', async () => {
    const harness = backendHarness();
    await harness.start();
    const ids = target(harness.provider);
    const inputs: LlmTurnInput[] = [];
    const llm = llmWithCalls(
      [
        {
          id: 'model-call-id',
          name: 'device_vibrate',
          args: { ...ids, intensity: 0.3, outputLeaseMs: 250 },
        },
      ],
      inputs,
    );
    const service = createService(harness.provider, llm, { maxOutputLeaseMs: 300 });
    await service.authorize(grantInput(ids.deviceId, ids.featureId));
    await service.beginRun();
    await service.observe(FRAME);
    await vi.waitFor(() => expect(harness.session.writeVibrate).toHaveBeenCalledTimes(1));

    expect(inputs[0]!.tools.map(({ name }) => name)).toEqual([
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);
    const vibrate = inputs[0]!.tools.find(({ name }) => name === 'device_vibrate')!;
    const schema = vibrate.parameters as {
      properties: Record<string, { enum?: string[]; maximum?: number }>;
      required: string[];
    };
    expect(schema.properties.deviceId!.enum).toEqual([ids.deviceId]);
    expect(schema.properties.featureId!.enum).toEqual([ids.featureId]);
    expect(schema.properties.intensity!.maximum).toBe(0.4);
    expect(schema.properties.outputLeaseMs!.maximum).toBe(300);
    expect(schema.properties).not.toHaveProperty('interactionId');
    expect(schema.required).not.toContain('interactionId');
    expect(JSON.stringify(inputs[0]!.session)).not.toContain('ephemeral-image');
    expect(harness.session.writeVibrate).toHaveBeenCalledWith('native-one', 'vibrate', 0.3);
  });

  it('rejects model-supplied IDs outside the exact grant before any write', async () => {
    const harness = backendHarness();
    await harness.start();
    const ids = target(harness.provider);
    const service = createService(
      harness.provider,
      llmWithCalls([
        {
          id: 'wrong-target',
          name: 'device_vibrate',
          args: {
            deviceId: 'other-device',
            featureId: 'other-feature',
            intensity: 0.2,
            outputLeaseMs: 200,
          },
        },
      ]),
    );
    await service.authorize(grantInput(ids.deviceId, ids.featureId));
    await service.beginRun();
    await service.observe(FRAME);
    await vi.waitFor(() => expect(harness.session.stopFeature).toHaveBeenCalledTimes(1));

    expect(harness.session.writeVibrate).not.toHaveBeenCalled();
    expect(service.getGrant()?.revoked).toBe(true);
  });

  it('caps intensity and output leases and blocks enhancement when the grant disallows it', async () => {
    const harness = backendHarness();
    await harness.start();
    const ids = target(harness.provider);
    let calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [
      {
        id: 'first',
        name: 'device_vibrate',
        args: { ...ids, intensity: 0.3, outputLeaseMs: 200 },
      },
    ];
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(async () => ({ assistantMessage: 'ok', toolCalls: calls })),
    };
    const service = createService(harness.provider, llm, {
      maxOutputLeaseMs: 250,
      safetyIntensityCap: 0.35,
    });
    const grant = await service.authorize(
      grantInput(ids.deviceId, ids.featureId, { intensityCap: 0.8, allowEnhanced: false }),
    );
    expect(grant.intensityCap).toBe(0.35);
    await service.beginRun();
    await service.observe(FRAME);
    await vi.waitFor(() => expect(harness.session.writeVibrate).toHaveBeenCalledTimes(1));

    calls = [{ id: 'stop-first', name: 'device_stop', args: ids }];
    await service.observe(FRAME);
    await vi.waitFor(() => expect(harness.session.stopFeature).toHaveBeenCalled());

    // Stopping does not reset the no-enhancement ceiling. A new start within
    // the same grant cannot use stop/restart to climb above the first output.
    calls = [
      {
        id: 'enhance-after-stop',
        name: 'device_vibrate',
        args: { ...ids, intensity: 0.31, outputLeaseMs: 200 },
      },
    ];
    await service.observe(FRAME);
    await vi.waitFor(() => expect(service.getGrant()?.revoked).toBe(true));

    expect(harness.session.writeVibrate).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceRuntime Video fail-safe lifecycle', () => {
  it('rejects a stale same-name reconnect and escalates stale identity to global stop', async () => {
    const harness = backendHarness();
    await harness.start();
    const original = target(harness.provider);
    const service = createService(harness.provider, llmWithCalls([]));
    await service.authorize(grantInput(original.deviceId, original.featureId));

    harness.emitTopology([]);
    harness.emitTopology([vibrateDevice('native-one')]);
    const replacement = target(harness.provider);
    expect(replacement.deviceId).not.toBe(original.deviceId);
    expect(replacement.featureId).not.toBe(original.featureId);

    await expect(service.beginRun()).rejects.toThrow('身份已失效');
    expect(harness.session.stopAll).toHaveBeenCalled();
    expect(service.isEmergencyLatched()).toBe(true);
    await expect(
      service.authorize(grantInput(original.deviceId, original.featureId)),
    ).rejects.toThrow('身份已失效');
  });

  it('expires the grant, stops the exact feature, and blocks later work', async () => {
    vi.useFakeTimers();
    const harness = backendHarness();
    await harness.start();
    const ids = target(harness.provider);
    const service = createService(
      harness.provider,
      llmWithCalls([
        {
          id: 'vibrate',
          name: 'device_vibrate',
          args: { ...ids, intensity: 0.2, outputLeaseMs: 5_000 },
        },
      ]),
    );
    await service.authorize(grantInput(ids.deviceId, ids.featureId, { durationMs: 1_000 }));
    await service.beginRun();
    await service.observe(FRAME);
    await flush();
    expect(harness.session.writeVibrate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.session.stopFeature).toHaveBeenCalled();
    expect(service.getGrant()?.revoked).toBe(true);
    await expect(service.beginRun()).rejects.toThrow('授权不存在或已过期');
  });

  it('preempts late model work and relies on the shared stop fence to compensate an in-flight write', async () => {
    const harness = backendHarness();
    await harness.start();
    const ids = target(harness.provider);
    const write = deferred<void>();
    harness.session.writeVibrate = vi.fn(() => write.promise);
    const settled = vi.fn();
    const service = createService(
      harness.provider,
      llmWithCalls([
        {
          id: 'late-write',
          name: 'device_vibrate',
          args: { ...ids, intensity: 0.2, outputLeaseMs: 500 },
        },
      ]),
      { onEffectSettled: settled },
    );
    await service.authorize(grantInput(ids.deviceId, ids.featureId));
    await service.beginRun();
    await service.observe(FRAME);
    await vi.waitFor(() => expect(harness.session.writeVibrate).toHaveBeenCalledTimes(1));

    await service.stop('pause');
    expect(harness.session.stopFeature).toHaveBeenCalledTimes(1);
    write.resolve();
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());

    expect(vi.mocked(harness.session.stopFeature).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(harness.session.writeVibrate).toHaveBeenCalledTimes(1);
  });

  it('keeps emergency stop global across every embedded device', async () => {
    const harness = backendHarness([
      vibrateDevice('native-one'),
      vibrateDevice('native-two', 'Second embedded device'),
    ]);
    await harness.start();
    const service = createService(harness.provider, llmWithCalls([]));

    await service.emergencyStop();

    expect(harness.session.stopAll).toHaveBeenCalledTimes(1);
    expect(harness.session.stopFeature).not.toHaveBeenCalled();
    expect(service.isEmergencyLatched()).toBe(true);
  });

  it('latches a failed global emergency stop', async () => {
    const harness = backendHarness();
    await harness.start();
    const service = createService(harness.provider, llmWithCalls([]));
    harness.session.stopAll = vi.fn(async () => {
      throw new Error('global stop failed');
    });

    await expect(service.emergencyStop()).rejects.toThrow('stop-failed');
    expect(service.isEmergencyLatched()).toBe(true);
  });

  it('latches a stop failure and refuses to run again even after global-stop escalation', async () => {
    const harness = backendHarness();
    await harness.start();
    const ids = target(harness.provider);
    const service = createService(harness.provider, llmWithCalls([]));
    await service.authorize(grantInput(ids.deviceId, ids.featureId));
    harness.session.stopFeature = vi.fn(async () => {
      throw new Error('native stop failed');
    });

    await expect(service.stop('pause')).rejects.toThrow();

    expect(harness.session.stopAll).toHaveBeenCalledTimes(1);
    expect(service.isEmergencyLatched()).toBe(true);
    expect(service.getGrant()?.revoked).toBe(true);
    await expect(service.beginRun()).rejects.toThrow('紧急停止已锁定');
  });
});
