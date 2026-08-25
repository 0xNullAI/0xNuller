import { describe, expect, it, vi } from 'vitest';
import type { BackendDevice } from './contracts.js';
import { DeviceRuntimeManager } from './manager.js';
import {
  EmbeddedButtplugUnsupportedError,
  WebEmbeddedButtplugBackend,
} from './web-buttplug-backend.js';

const VIBRATE = 'Vibrate';
const BATTERY = 'Battery';
const RSSI = 'RSSI';
const READ = 'Read';

class FakeFeature {
  readonly runOutput = vi.fn(async (_command: unknown) => undefined);
  readonly runInput = vi.fn(async (inputType: unknown) => {
    const value = inputType === BATTERY ? 75 : -48;
    return { Reading: { [String(inputType)]: { Value: value } } };
  });

  constructor(
    readonly _feature: {
      FeatureIndex: number;
      Output: Record<string, { Value: number[] }>;
      Input: Record<string, { Value: number[]; Command: string[] }>;
    },
  ) {}

  hasOutput(type: unknown): boolean {
    return Object.hasOwn(this._feature.Output, String(type));
  }

  hasInput(type: unknown): boolean {
    return Object.hasOwn(this._feature.Input, String(type));
  }
}

class FakeDevice {
  readonly stop = vi.fn(async () => undefined);

  constructor(
    readonly index: number,
    readonly features: Map<number, FakeFeature>,
  ) {}
}

class FakeClient {
  connected = false;
  isScanning = false;
  readonly devices = new Map<number, FakeDevice>();
  readonly connect = vi.fn(async () => {
    this.connected = true;
  });
  readonly startScanning = vi.fn(async () => {
    this.isScanning = true;
  });
  readonly stopAllDevices = vi.fn(async () => undefined);
  private readonly listeners = new Map<string, Set<(value?: unknown) => void>>();

  on(event: string, listener: (value?: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (value?: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  addDevice(device: FakeDevice): void {
    this.devices.set(device.index, device);
    this.emit('deviceadded', device);
  }

  removeDevice(device: FakeDevice): void {
    if (this.devices.get(device.index) === device) this.devices.delete(device.index);
    this.emit('deviceremoved', device);
  }
}

function feature(
  index: number,
  options: {
    vibrateSteps?: number;
    battery?: boolean;
    rssi?: boolean;
    extraOutput?: string;
    read?: boolean;
  } = {},
): FakeFeature {
  const output: Record<string, { Value: number[] }> = {};
  if (options.vibrateSteps) output[VIBRATE] = { Value: [0, options.vibrateSteps] };
  if (options.extraOutput) output[options.extraOutput] = { Value: [0, 255] };
  const input: Record<string, { Value: number[]; Command: string[] }> = {};
  const commands = options.read === false ? ['Subscribe'] : [READ];
  if (options.battery) input[BATTERY] = { Value: [0, 100], Command: commands };
  if (options.rssi) input[RSSI] = { Value: [-127, 20], Command: commands };
  return new FakeFeature({ FeatureIndex: index, Output: output, Input: input });
}

function supportedEnvironment() {
  return { browser: true, secureContext: true, webBluetooth: true };
}

function harness(initialDevices: readonly FakeDevice[] = []) {
  const client = new FakeClient();
  for (const device of initialDevices) client.devices.set(device.index, device);
  const connector = {
    disconnect: vi.fn(async () => {
      client.connected = false;
    }),
  };
  const vibrateSteps = vi.fn((steps: number) => ({ type: 'vibrate-steps', steps }));
  const loadApi = vi.fn(async () => ({
    client,
    connector,
    outputVibrate: VIBRATE,
    inputBattery: BATTERY,
    inputRssi: RSSI,
    inputRead: READ,
    vibrateSteps,
  }));
  const backend = new WebEmbeddedButtplugBackend({
    environment: supportedEnvironment,
    loadApi,
  });
  return { backend, client, connector, vibrateSteps, loadApi };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('WebEmbeddedButtplugBackend', () => {
  it.each([
    [
      'non-browser',
      { browser: false, secureContext: false, webBluetooth: false },
      'browser-environment-required',
    ],
    [
      'insecure context',
      { browser: true, secureContext: false, webBluetooth: true },
      'secure-context-required',
    ],
    [
      'missing Web Bluetooth',
      { browser: true, secureContext: true, webBluetooth: false },
      'web-bluetooth-required',
    ],
  ])('rejects unsupported environment: %s', async (_label, environment, code) => {
    const loadApi = vi.fn();
    const backend = new WebEmbeddedButtplugBackend({ environment: () => environment, loadApi });
    const error = await backend.openSession(() => undefined).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(EmbeddedButtplugUnsupportedError);
    expect(error).toMatchObject({ code });
    expect(loadApi).not.toHaveBeenCalled();
  });

  it('maps only Vibrate, readable Battery, and readable RSSI with generic identity', async () => {
    const capabilities = new Map([
      [0, feature(0, { vibrateSteps: 20, extraOutput: 'Raw' })],
      [1, feature(1, { battery: true, rssi: true })],
      [2, feature(2, { battery: true, read: false, extraOutput: 'Rotate' })],
    ]);
    const runtime = harness([new FakeDevice(42, capabilities)]);
    const manager = new DeviceRuntimeManager(runtime.backend, { idFactory: () => 'web-map' });
    await manager.start();
    await flush();

    const snapshot = manager.snapshot();
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]?.name).toBe('Embedded device');
    expect(snapshot.devices[0]?.capabilities).toEqual([
      expect.objectContaining({ kind: 'vibrate', stepCount: 20 }),
      expect.objectContaining({ kind: 'battery', value: 0.75 }),
      expect.objectContaining({ kind: 'rssi', value: -48 }),
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/Raw|Rotate|native|42/);
  });

  it('routes writes and stops to the exact device feature', async () => {
    const first = feature(1, { vibrateSteps: 10 });
    const second = feature(2, { vibrateSteps: 20 });
    const runtime = harness([
      new FakeDevice(
        7,
        new Map([
          [1, first],
          [2, second],
        ]),
      ),
    ]);
    let topology: BackendDevice[] = [];
    const session = await runtime.backend.openSession((event) => {
      const candidate = event as { type?: string; devices?: BackendDevice[] };
      if (candidate.type === 'topology') topology = candidate.devices ?? [];
    });
    const secondCapability = topology[0]?.capabilities[1];
    expect(secondCapability?.kind).toBe('vibrate');

    await session.writeVibrate('7', secondCapability!.nativeFeatureId, 0.55);
    expect(first.runOutput).not.toHaveBeenCalled();
    expect(second.runOutput).toHaveBeenLastCalledWith({ type: 'vibrate-steps', steps: 11 });

    await session.stopFeature('7', secondCapability!.nativeFeatureId);
    expect(second.runOutput).toHaveBeenLastCalledWith({ type: 'vibrate-steps', steps: 0 });
    await expect(session.writeVibrate('8', secondCapability!.nativeFeatureId, 0.5)).rejects.toThrow(
      'unknown-vibration-feature',
    );
  });

  it('issues new opaque identities when the same native index reconnects', async () => {
    const oldDevice = new FakeDevice(9, new Map([[0, feature(0, { vibrateSteps: 10 })]]));
    const runtime = harness([oldDevice]);
    const manager = new DeviceRuntimeManager(runtime.backend, { idFactory: () => 'reconnect' });
    await manager.start();
    const old = manager.snapshot().devices[0]!;

    runtime.client.removeDevice(oldDevice);
    const freshDevice = new FakeDevice(9, new Map([[0, feature(0, { vibrateSteps: 10 })]]));
    runtime.client.addDevice(freshDevice);
    const fresh = manager.snapshot().devices[0]!;

    expect(fresh.deviceId).not.toBe(old.deviceId);
    expect(fresh.capabilities[0]?.featureId).not.toBe(old.capabilities[0]?.featureId);
    expect(manager.resolveDevice(old.deviceId)).toBeNull();

    // A late removal from the old connection cannot remove the fresh one.
    runtime.client.emit('deviceremoved', oldDevice);
    expect(manager.snapshot().devices[0]?.deviceId).toBe(fresh.deviceId);
  });

  it('maps stop-all and disconnect failures while still releasing the connector on close', async () => {
    const runtime = harness([new FakeDevice(1, new Map([[0, feature(0, { vibrateSteps: 10 })]]))]);
    const session = await runtime.backend.openSession(() => undefined);
    const stopFailure = new Error('native stop failed');
    runtime.client.stopAllDevices.mockRejectedValue(stopFailure);

    await expect(session.stopAll()).rejects.toBe(stopFailure);
    await expect(session.close()).rejects.toBe(stopFailure);
    expect(runtime.client.stopAllDevices).toHaveBeenCalledTimes(2);
    expect(runtime.connector.disconnect).toHaveBeenCalledTimes(1);
    await expect(session.scan()).rejects.toThrow('embedded-session-unavailable');
  });

  it('stops all output and ends the embedded session for per-device disconnect', async () => {
    const device = new FakeDevice(3, new Map([[0, feature(0, { vibrateSteps: 10 })]]));
    const runtime = harness([device]);
    const events: unknown[] = [];
    const session = await runtime.backend.openSession((event) => events.push(event));

    await session.disconnect('3');

    expect(device.stop).toHaveBeenCalledTimes(1);
    expect(runtime.client.stopAllDevices).toHaveBeenCalledTimes(1);
    expect(runtime.connector.disconnect).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session-ended',
        reason: 'device-disconnect-closes-embedded-session',
      }),
    );
  });
});
