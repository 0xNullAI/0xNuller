import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentDeviceLeaseSnapshot,
  grantDeviceLease,
  type DeviceLeaseSnapshot,
} from '@dg-kit/safety';
import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  type BackendCapability,
  type DeviceBackend,
  type DeviceBackendSession,
  type DeviceSafetyPolicy,
  type VibrateCommand,
} from './contracts.js';
import { DeviceRuntimeExecutor } from './executor.js';
import { DeviceRuntimeManager } from './manager.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function runtimeHarness(
  options: {
    capabilities?: BackendCapability[];
    leaseSnapshot?: () => DeviceLeaseSnapshot;
    authorize?: () => Promise<'allow' | 'deny'>;
  } = {},
) {
  let emit: (event: unknown) => void = () => undefined;
  const scan = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  const writeVibrate = vi.fn(async () => undefined);
  const stopFeature = vi.fn(async () => undefined);
  const stopAll = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const session: DeviceBackendSession = {
    scan,
    disconnect,
    writeVibrate,
    stopFeature,
    stopAll,
    close,
  };
  const backend: DeviceBackend = {
    openSession: vi.fn(async (listener) => {
      emit = listener;
      return session;
    }),
  };
  const manager = new DeviceRuntimeManager(backend, { idFactory: () => 'executor' });
  await manager.start();
  emit({
    version: 1,
    type: 'topology',
    devices: [
      {
        nativeDeviceId: 'native-device',
        name: 'Test device',
        capabilities: options.capabilities ?? [
          { kind: 'vibrate', nativeFeatureId: 'native-vibrate', stepCount: 10 },
        ],
      },
    ],
  });
  let lease: DeviceLeaseSnapshot = { holder: 'agent', epoch: 1 };
  let policy: DeviceSafetyPolicy = {
    intensityCap: 1,
    maxIncrease: 1,
    coldStartCap: 1,
    maxOutputLeaseMs: 5_000,
  };
  const authorize = vi.fn(options.authorize ?? (async () => 'allow' as const));
  const executor = new DeviceRuntimeExecutor(manager, {
    permissionPolicy: { authorize },
    safetyPolicy: () => policy,
    leaseSnapshot: options.leaseSnapshot ?? (() => lease),
  });
  const snapshot = manager.snapshot();
  const device = snapshot.devices[0]!;
  const vibrate = device.capabilities.find((item) => item.kind === 'vibrate')!;
  const command = (over: Partial<VibrateCommand> = {}): VibrateCommand => ({
    version: DEVICE_RUNTIME_SCHEMA_VERSION,
    type: 'vibrate',
    interactionId: 'turn-1',
    ...executor.captureFence('agent'),
    deviceId: device.deviceId,
    featureId: vibrate.featureId,
    intensity: 0.5,
    outputLeaseMs: 1_000,
    ...over,
  });
  return {
    backend,
    manager,
    executor,
    emit,
    device,
    vibrate,
    command,
    authorize,
    writeVibrate,
    stopFeature,
    stopAll,
    scan,
    disconnect,
    setLease: (next: DeviceLeaseSnapshot) => {
      lease = next;
    },
    setPolicy: (next: DeviceSafetyPolicy) => {
      policy = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await grantDeviceLease(null);
});

describe('DeviceRuntimeExecutor safety boundary', () => {
  it('quantizes downward, reports unknown hardware state, and watchdog-stops output', async () => {
    const runtime = await runtimeHarness();
    const ack = await runtime.executor.execute(
      runtime.command({ intensity: 0.59, outputLeaseMs: 250 }),
    );

    expect(runtime.writeVibrate).toHaveBeenCalledWith('native-device', 'native-vibrate', 0.5);
    expect(ack).toMatchObject({
      status: 'applied',
      appliedIntensity: 0.5,
      hardwareState: 'unknown',
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(runtime.stopFeature).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.stopFeature).toHaveBeenCalledWith('native-device', 'native-vibrate');
  });

  it('enforces cold-start, increase-step, cap, and output-lease limits', async () => {
    const runtime = await runtimeHarness();
    runtime.setPolicy({
      intensityCap: 0.8,
      maxIncrease: 0.2,
      coldStartCap: 0.2,
      maxOutputLeaseMs: 500,
    });

    await expect(
      runtime.executor.execute(runtime.command({ intensity: 0.4, outputLeaseMs: 500 })),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'cold-start-cap-exceeded',
    });
    await expect(
      runtime.executor.execute(
        runtime.command({ interactionId: 'start', intensity: 0.2, outputLeaseMs: 500 }),
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    await expect(
      runtime.executor.execute(
        runtime.command({ interactionId: 'step', intensity: 0.5, outputLeaseMs: 500 }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', code: 'intensity-step-exceeded' });

    runtime.setPolicy({
      intensityCap: 0.1,
      maxIncrease: 1,
      coldStartCap: 1,
      maxOutputLeaseMs: 500,
    });
    await expect(
      runtime.executor.execute(
        runtime.command({ interactionId: 'cap', intensity: 0.2, outputLeaseMs: 500 }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', code: 'intensity-cap-exceeded' });
    await expect(
      runtime.executor.execute(
        runtime.command({ interactionId: 'lease', intensity: 0.1, outputLeaseMs: 501 }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', code: 'output-lease-too-long' });
  });

  it('re-evaluates dynamic safety policy when a serialized write reaches native I/O', async () => {
    const runtime = await runtimeHarness();
    const firstWrite = deferred<undefined>();
    runtime.writeVibrate.mockImplementationOnce(() => firstWrite.promise);
    const first = runtime.executor.execute(
      runtime.command({ interactionId: 'first', intensity: 0.1 }),
    );
    await flush();
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);

    const second = runtime.executor.execute(
      runtime.command({ interactionId: 'second', intensity: 0.4 }),
    );
    await flush();
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);
    runtime.setPolicy({
      intensityCap: 0.2,
      maxIncrease: 1,
      coldStartCap: 1,
      maxOutputLeaseMs: 5_000,
    });
    firstWrite.resolve(undefined);

    await expect(first).resolves.toMatchObject({ status: 'applied' });
    await expect(second).resolves.toMatchObject({
      status: 'rejected',
      code: 'intensity-cap-exceeded',
    });
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['session', 'stale-session'],
    ['topology', 'stale-topology'],
    ['safety', 'stale-safety'],
    ['lease', 'stale-lease'],
  ])('rejects stale %s fences before native write', async (kind, expectedCode) => {
    const runtime = await runtimeHarness();
    const command = runtime.command();
    if (kind === 'session') command.sessionId = 'different-session' as typeof command.sessionId;
    if (kind === 'topology') {
      runtime.emit({
        version: 1,
        type: 'topology',
        devices: [
          {
            nativeDeviceId: 'native-device',
            name: 'Test device',
            capabilities: [
              { kind: 'vibrate', nativeFeatureId: 'native-vibrate', stepCount: 10 },
              { kind: 'battery', nativeFeatureId: 'battery', value: 0.5 },
            ],
          },
        ],
      });
    }
    if (kind === 'safety') runtime.manager.advanceSafetyGeneration();
    if (kind === 'lease') runtime.setLease({ holder: 'agent', epoch: 3 });

    await expect(runtime.executor.execute(command)).resolves.toMatchObject({
      status: 'rejected',
      code: expectedCode,
    });
    expect(runtime.writeVibrate).not.toHaveBeenCalled();
  });

  it('rejects lease ABA using the shared safety-bus epoch snapshot', async () => {
    await grantDeviceLease('agent');
    const runtime = await runtimeHarness({ leaseSnapshot: currentDeviceLeaseSnapshot });
    const command = runtime.command();
    const before = currentDeviceLeaseSnapshot();
    await grantDeviceLease('voice');
    await grantDeviceLease('agent');
    const after = currentDeviceLeaseSnapshot();
    expect(after.holder).toBe(before.holder);
    expect(after.epoch).toBeGreaterThan(before.epoch);

    await expect(runtime.executor.execute(command)).resolves.toMatchObject({
      status: 'rejected',
      code: 'stale-lease',
    });
    expect(runtime.writeVibrate).not.toHaveBeenCalled();
  });

  it('rechecks lease after an awaited permission is revoked', async () => {
    const permission = deferred<'allow' | 'deny'>();
    const runtime = await runtimeHarness({ authorize: () => permission.promise });
    const pending = runtime.executor.execute(runtime.command());
    await flush();
    expect(runtime.authorize).toHaveBeenCalledTimes(1);
    runtime.setLease({ holder: 'voice', epoch: 2 });
    permission.resolve('allow');

    await expect(pending).resolves.toMatchObject({ status: 'rejected', code: 'stale-lease' });
    expect(runtime.writeVibrate).not.toHaveBeenCalled();
  });

  it('holds a barrier for the full native stop and rejects freshly fenced output', async () => {
    const runtime = await runtimeHarness();
    const nativeStop = deferred<undefined>();
    runtime.stopFeature.mockImplementationOnce(() => nativeStop.promise);
    const stopping = runtime.executor.execute({
      version: 1,
      type: 'stop',
      interactionId: 'barrier-stop',
      deviceId: runtime.device.deviceId,
      featureId: runtime.vibrate.featureId,
    });
    await flush();
    expect(runtime.stopFeature).toHaveBeenCalledTimes(1);

    const freshCommand = runtime.command({
      ...runtime.executor.captureFence('agent'),
      interactionId: 'during-stop',
    });
    await expect(runtime.executor.execute(freshCommand)).resolves.toMatchObject({
      status: 'rejected',
      code: 'stop-barrier-active',
    });
    expect(runtime.writeVibrate).not.toHaveBeenCalled();
    nativeStop.resolve(undefined);
    await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
  });

  it('stop preempts queued work and compensates a late in-flight write', async () => {
    const runtime = await runtimeHarness();
    const nativeWrite = deferred<undefined>();
    runtime.writeVibrate.mockImplementationOnce(() => nativeWrite.promise);
    const first = runtime.executor.execute(runtime.command({ interactionId: 'in-flight' }));
    await flush();
    const queued = runtime.executor.execute(runtime.command({ interactionId: 'queued' }));
    await flush();
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);

    const stopped = await runtime.executor.execute({
      version: 1,
      type: 'stop',
      interactionId: 'stop-now',
      deviceId: runtime.device.deviceId,
      featureId: runtime.vibrate.featureId,
    });
    expect(stopped.status).toBe('stopped');
    expect(runtime.stopFeature).toHaveBeenCalledTimes(1);

    nativeWrite.resolve(undefined);
    await expect(first).resolves.toMatchObject({
      status: 'rejected',
      code: 'stale-after-write-stopped',
    });
    await expect(queued).resolves.toMatchObject({ status: 'rejected', code: 'stale-safety' });
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);
    expect(runtime.stopFeature).toHaveBeenCalledTimes(2);
  });

  it('escalates a stale feature stop to global emergency stop', async () => {
    const runtime = await runtimeHarness();

    await expect(
      runtime.executor.execute({
        version: 1,
        type: 'stop',
        interactionId: 'stale-stop',
        deviceId: 'missing-device' as typeof runtime.device.deviceId,
        featureId: 'missing-feature' as typeof runtime.vibrate.featureId,
      }),
    ).resolves.toMatchObject({
      status: 'stopped',
      code: 'stale-target-emergency-stopped',
    });
    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
  });

  it('preempts existing output when backend topology changes structurally', async () => {
    const runtime = await runtimeHarness();
    await runtime.executor.execute(runtime.command({ intensity: 0.2 }));
    runtime.stopAll.mockClear();

    runtime.emit({
      version: 1,
      type: 'topology',
      devices: [
        {
          nativeDeviceId: 'native-device',
          name: 'Test device',
          capabilities: [
            { kind: 'vibrate', nativeFeatureId: 'native-vibrate', stepCount: 10 },
            { kind: 'battery', nativeFeatureId: 'battery', value: 0.5 },
          ],
        },
      ],
    });
    await flush();

    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);
    await expect(
      runtime.executor.execute(
        runtime.command({
          ...runtime.executor.captureFence('agent'),
          interactionId: 'after-topology',
        }),
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(2);
  });

  it('stop and emergency stop bypass lease, permission, and feature queues', async () => {
    const runtime = await runtimeHarness({ authorize: async () => 'deny' });
    runtime.setLease({ holder: null, epoch: 2 });

    await expect(
      runtime.executor.execute({
        version: 1,
        type: 'stop',
        interactionId: 'stop',
        deviceId: runtime.device.deviceId,
        featureId: runtime.vibrate.featureId,
      }),
    ).resolves.toMatchObject({ status: 'stopped' });
    await expect(
      runtime.executor.execute({ version: 1, type: 'emergency-stop', interactionId: 'all-stop' }),
    ).resolves.toMatchObject({ status: 'stopped' });
    expect(runtime.authorize).not.toHaveBeenCalled();
    expect(runtime.stopFeature).toHaveBeenCalledTimes(1);
    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
  });

  it('latches every output feature when global emergency stop fails', async () => {
    const runtime = await runtimeHarness({
      capabilities: [
        { kind: 'vibrate', nativeFeatureId: 'left', stepCount: 10 },
        { kind: 'vibrate', nativeFeatureId: 'right', stepCount: 10 },
      ],
    });
    runtime.stopAll.mockRejectedValueOnce(new Error('global stop failed'));

    await expect(
      runtime.executor.execute({
        version: 1,
        type: 'emergency-stop',
        interactionId: 'global-failure',
      }),
    ).resolves.toMatchObject({ status: 'faulted', code: 'stop-failed' });
    const capabilities = runtime.manager.snapshot().devices[0]!.capabilities;
    expect(capabilities.filter((item) => item.kind === 'vibrate')).toEqual([
      expect.objectContaining({ faulted: true }),
      expect.objectContaining({ faulted: true }),
    ]);
  });

  it('latches a stop fault and blocks all later output even after a successful stop retry', async () => {
    const runtime = await runtimeHarness();
    runtime.stopFeature.mockRejectedValueOnce(new Error('native stop failed'));
    await expect(
      runtime.executor.execute({
        version: 1,
        type: 'stop',
        interactionId: 'failed-stop',
        deviceId: runtime.device.deviceId,
        featureId: runtime.vibrate.featureId,
      }),
    ).resolves.toMatchObject({ status: 'faulted', code: 'stop-failed' });
    expect(
      runtime.manager.snapshot().devices[0]?.capabilities.find((item) => item.kind === 'vibrate'),
    ).toMatchObject({ faulted: true });

    await expect(
      runtime.executor.execute(
        runtime.command({
          ...runtime.executor.captureFence('agent'),
          interactionId: 'blocked',
        }),
      ),
    ).resolves.toMatchObject({ status: 'faulted', code: 'fault-latched' });
    await runtime.executor.execute({
      version: 1,
      type: 'stop',
      interactionId: 'retry-stop',
      deviceId: runtime.device.deviceId,
      featureId: runtime.vibrate.featureId,
    });
    await expect(
      runtime.executor.execute(
        runtime.command({
          ...runtime.executor.captureFence('agent'),
          interactionId: 'still-blocked',
        }),
      ),
    ).resolves.toMatchObject({ status: 'faulted', code: 'fault-latched' });
    expect(runtime.writeVibrate).not.toHaveBeenCalled();

    runtime.emit({ version: 1, type: 'topology', devices: [] });
    runtime.emit({
      version: 1,
      type: 'topology',
      devices: [
        {
          nativeDeviceId: 'native-device',
          name: 'Replacement device',
          capabilities: [{ kind: 'vibrate', nativeFeatureId: 'replacement', stepCount: 10 }],
        },
      ],
    });
    await flush();
    const replacement = runtime.manager.snapshot().devices[0]!;
    const replacementFeature = replacement.capabilities.find((item) => item.kind === 'vibrate')!;
    await expect(
      runtime.executor.execute({
        version: 1,
        type: 'vibrate',
        interactionId: 'replacement-blocked',
        ...runtime.executor.captureFence('agent'),
        deviceId: replacement.deviceId,
        featureId: replacementFeature.featureId,
        intensity: 0.1,
        outputLeaseMs: 100,
      }),
    ).resolves.toMatchObject({ status: 'faulted', code: 'fault-latched' });
  });

  it('does not restore previous output when the same native device reappears', async () => {
    const runtime = await runtimeHarness();
    await runtime.executor.execute(runtime.command({ intensity: 0.2 }));
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);
    runtime.emit({ version: 1, type: 'topology', devices: [] });
    runtime.emit({
      version: 1,
      type: 'topology',
      devices: [
        {
          nativeDeviceId: 'native-device',
          name: 'Test device',
          capabilities: [{ kind: 'vibrate', nativeFeatureId: 'native-vibrate', stepCount: 10 }],
        },
      ],
    });
    await flush();
    expect(runtime.writeVibrate).toHaveBeenCalledTimes(1);
    expect(runtime.manager.snapshot().devices[0]?.deviceId).not.toBe(runtime.device.deviceId);
  });
});
