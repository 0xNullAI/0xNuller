import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  BackendCapability,
  BackendDevice,
  BackendEvent,
  DeviceBackend,
  DeviceBackendSession,
} from '@0xnullai/device-runtime';

const SCHEMA_VERSION = 1 as const;
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

type UnknownRecord = Record<string, unknown>;

interface NativeFence {
  sessionId: string;
  topologyGeneration: number;
  safetyGeneration: number;
}

interface NativeInitialize extends NativeFence {
  schemaVersion: typeof SCHEMA_VERSION;
  scanning: boolean;
}

interface NativeAck extends NativeFence {
  schemaVersion: typeof SCHEMA_VERSION;
  acknowledged?: boolean;
  hardwareState?: 'unknown';
  scanning?: boolean;
  appliedIntensity?: number;
}

interface NativeTopology extends NativeFence {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'topology';
  devices: BackendDevice[];
}

interface NativeSessionEnded extends NativeFence {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'sessionEnded';
  reason: string;
}

type NativeEvent = NativeTopology | NativeSessionEnded;

interface NativeGlobalAck {
  schemaVersion: typeof SCHEMA_VERSION;
  acknowledged: boolean;
  hardwareState: 'unknown';
  sessionId: string | null;
  topologyGeneration: number | null;
  safetyGeneration: number | null;
}

export interface ButtplugNativeBridge {
  invoke(command: string, arguments_: Record<string, unknown>): Promise<unknown>;
  createChannel<T>(onMessage: (message: T) => void): unknown;
}

const tauriBridge: ButtplugNativeBridge = {
  invoke: (command, arguments_) => invoke<unknown>(command, arguments_),
  createChannel: (onMessage) => new Channel(onMessage),
};

/**
 * Default-off Android adapter for the native embedded Buttplug backend.
 *
 * Constructing this class does not initialize BLE. A product composition must
 * explicitly inject it into DeviceRuntimeManager, and the APK must be compiled
 * with the matching Cargo feature.
 */
export class ButtplugDeviceBackend implements DeviceBackend {
  private opened = false;

  constructor(private readonly bridge: ButtplugNativeBridge = tauriBridge) {}

  async openSession(onEvent: (event: unknown) => void): Promise<DeviceBackendSession> {
    if (this.opened) throw new Error('buttplug-native-session-already-open');
    this.opened = true;
    const buffered: unknown[] = [];
    let session: ButtplugDeviceBackendSession | null = null;
    const channel = this.bridge.createChannel<unknown>((message) => {
      if (session) session.acceptNativeEvent(message);
      else buffered.push(message);
    });

    try {
      const response = parseInitialize(
        await this.bridge.invoke('experimental_buttplug_initialize', {
          request: { schemaVersion: SCHEMA_VERSION },
          onEvent: channel,
        }),
      );
      session = new ButtplugDeviceBackendSession(this.bridge, response, onEvent);
      for (const message of buffered) session.acceptNativeEvent(message);
      return session;
    } catch (error) {
      this.opened = false;
      throw error;
    }
  }
}

class ButtplugDeviceBackendSession implements DeviceBackendSession {
  private fence: NativeFence;
  private ended = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly bridge: ButtplugNativeBridge,
    initial: NativeInitialize,
    private readonly onEvent: (event: unknown) => void,
  ) {
    this.fence = nativeFence(initial);
  }

  acceptNativeEvent(input: unknown): void {
    if (this.ended) return;
    try {
      const event = parseNativeEvent(input);
      this.acceptFence(event);
      if (event.type === 'sessionEnded') {
        this.ended = true;
        this.onEvent({
          version: SCHEMA_VERSION,
          type: 'session-ended',
          reason: event.reason,
        } satisfies BackendEvent);
        return;
      }
      this.onEvent({
        version: SCHEMA_VERSION,
        type: 'topology',
        devices: event.devices,
      } satisfies BackendEvent);
    } catch {
      this.ended = true;
      this.onEvent({
        version: SCHEMA_VERSION,
        type: 'session-ended',
        reason: 'invalid-native-event',
      } satisfies BackendEvent);
      // A malformed or regressing native event fails closed. Stop remains
      // reachable because stopAll deliberately does not call requireOpen().
      void this.stopAll().catch(() => undefined);
    }
  }

  async scan(): Promise<void> {
    this.requireOpen();
    const ack = parseScanAck(
      await this.bridge.invoke('experimental_buttplug_start_scan', {
        request: this.fencedRequest(),
      }),
    );
    this.acceptFence(ack);
  }

  async disconnect(nativeDeviceId: string): Promise<void> {
    this.requireOpen();
    const ack = parseOperationAck(
      await this.bridge.invoke('experimental_buttplug_disconnect', {
        request: { ...this.fencedRequest(), deviceId: nativeDeviceId },
      }),
    );
    this.acceptFence(ack);
  }

  async writeVibrate(
    nativeDeviceId: string,
    nativeFeatureId: string,
    normalizedIntensity: number,
  ): Promise<void> {
    this.requireOpen();
    const ack = parseOperationAck(
      await this.bridge.invoke('experimental_buttplug_vibrate', {
        request: {
          ...this.fencedRequest(),
          deviceId: nativeDeviceId,
          featureId: nativeFeatureId,
          intensity: normalizedIntensity,
        },
      }),
    );
    this.acceptFence(ack);
  }

  async stopFeature(nativeDeviceId: string, nativeFeatureId: string): Promise<void> {
    const ack = parseOperationAck(
      await this.bridge.invoke('experimental_buttplug_stop_feature', {
        request: {
          schemaVersion: SCHEMA_VERSION,
          deviceId: nativeDeviceId,
          featureId: nativeFeatureId,
        },
      }),
    );
    this.acceptFence(ack);
  }

  async stopAll(): Promise<void> {
    const ack = parseGlobalAck(
      await this.bridge.invoke('experimental_buttplug_stop_all', {
        request: { schemaVersion: SCHEMA_VERSION },
      }),
    );
    if (ack.sessionId !== null) {
      this.acceptFence({
        sessionId: ack.sessionId,
        topologyGeneration: ack.topologyGeneration as number,
        safetyGeneration: ack.safetyGeneration as number,
      });
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.bridge
      .invoke('experimental_buttplug_close', {
        request: { schemaVersion: SCHEMA_VERSION },
      })
      .then((response) => {
        parseGlobalAck(response);
        this.ended = true;
      })
      .catch((error: unknown) => {
        // Preserve native stop/disconnect failure for DeviceRuntimeManager.
        this.closePromise = null;
        throw error;
      });
    return this.closePromise;
  }

  private fencedRequest(): UnknownRecord {
    return { schemaVersion: SCHEMA_VERSION, ...this.fence };
  }

  private acceptFence(next: NativeFence): void {
    if (next.sessionId !== this.fence.sessionId) throw new Error('native-session-regressed');
    if (
      next.topologyGeneration < this.fence.topologyGeneration ||
      next.safetyGeneration < this.fence.safetyGeneration
    ) {
      throw new Error('native-generation-regressed');
    }
    this.fence = nativeFence(next);
  }

  private requireOpen(): void {
    if (this.ended) throw new Error('buttplug-native-session-ended');
  }
}

function parseInitialize(input: unknown): NativeInitialize {
  const value = record(input, 'initialize');
  exactKeys(
    value,
    ['schemaVersion', 'sessionId', 'topologyGeneration', 'safetyGeneration', 'scanning'],
    'initialize',
  );
  validateSchema(value.schemaVersion, 'initialize.schemaVersion');
  validateFence(value, 'initialize');
  booleanValue(value.scanning, 'initialize.scanning');
  return value as unknown as NativeInitialize;
}

function parseScanAck(input: unknown): NativeAck {
  const value = record(input, 'scanAck');
  exactKeys(
    value,
    ['schemaVersion', 'sessionId', 'topologyGeneration', 'safetyGeneration', 'scanning'],
    'scanAck',
  );
  validateSchema(value.schemaVersion, 'scanAck.schemaVersion');
  validateFence(value, 'scanAck');
  booleanValue(value.scanning, 'scanAck.scanning');
  return value as unknown as NativeAck;
}

function parseOperationAck(input: unknown): NativeAck {
  const value = record(input, 'operationAck');
  exactKeys(
    value,
    [
      'schemaVersion',
      'sessionId',
      'topologyGeneration',
      'safetyGeneration',
      'acknowledged',
      'hardwareState',
    ],
    'operationAck',
    ['appliedIntensity'],
  );
  validateSchema(value.schemaVersion, 'operationAck.schemaVersion');
  validateFence(value, 'operationAck');
  if (value.acknowledged !== true) fail('operationAck.acknowledged', 'expected true');
  if (value.hardwareState !== 'unknown') {
    fail('operationAck.hardwareState', 'expected "unknown"');
  }
  if (Object.hasOwn(value, 'appliedIntensity')) {
    finiteRange(value.appliedIntensity, 0, 1, 'operationAck.appliedIntensity');
  }
  return value as unknown as NativeAck;
}

function parseGlobalAck(input: unknown): NativeGlobalAck {
  const value = record(input, 'globalAck');
  exactKeys(
    value,
    [
      'schemaVersion',
      'acknowledged',
      'hardwareState',
      'sessionId',
      'topologyGeneration',
      'safetyGeneration',
    ],
    'globalAck',
  );
  validateSchema(value.schemaVersion, 'globalAck.schemaVersion');
  if (value.acknowledged !== true) fail('globalAck.acknowledged', 'expected true');
  if (value.hardwareState !== 'unknown') fail('globalAck.hardwareState', 'expected "unknown"');
  const allNull =
    value.sessionId === null &&
    value.topologyGeneration === null &&
    value.safetyGeneration === null;
  if (!allNull) validateFence(value, 'globalAck');
  return value as unknown as NativeGlobalAck;
}

function parseNativeEvent(input: unknown): NativeEvent {
  const value = record(input, 'nativeEvent');
  validateSchema(value.schemaVersion, 'nativeEvent.schemaVersion');
  validateFence(value, 'nativeEvent');
  if (value.type === 'sessionEnded') {
    exactKeys(
      value,
      ['type', 'schemaVersion', 'sessionId', 'topologyGeneration', 'safetyGeneration', 'reason'],
      'nativeEvent',
    );
    stringValue(value.reason, 'nativeEvent.reason', 512);
    return value as unknown as NativeSessionEnded;
  }
  if (value.type !== 'topology') fail('nativeEvent.type', 'unknown event type');
  exactKeys(
    value,
    ['type', 'schemaVersion', 'sessionId', 'topologyGeneration', 'safetyGeneration', 'devices'],
    'nativeEvent',
  );
  value.devices = parseDevices(value.devices);
  return value as unknown as NativeTopology;
}

function parseDevices(input: unknown): BackendDevice[] {
  if (!Array.isArray(input)) fail('nativeEvent.devices', 'expected array');
  return input.map((item, deviceIndex) => {
    const path = `nativeEvent.devices[${deviceIndex}]`;
    const device = record(item, path);
    exactKeys(device, ['nativeDeviceId', 'name', 'capabilities'], path);
    stringValue(device.nativeDeviceId, `${path}.nativeDeviceId`, 160);
    stringValue(device.name, `${path}.name`, 256);
    if (!Array.isArray(device.capabilities)) fail(`${path}.capabilities`, 'expected array');
    const capabilities = device.capabilities.map((capability, featureIndex) =>
      parseCapability(capability, `${path}.capabilities[${featureIndex}]`),
    );
    return {
      nativeDeviceId: device.nativeDeviceId,
      name: device.name,
      capabilities,
    };
  });
}

function parseCapability(input: unknown, path: string): BackendCapability {
  const value = record(input, path);
  switch (value.kind) {
    case 'vibrate':
      exactKeys(value, ['kind', 'nativeFeatureId', 'stepCount'], path);
      stringValue(value.nativeFeatureId, `${path}.nativeFeatureId`, 160);
      integerRange(value.stepCount, 1, 10_000, `${path}.stepCount`);
      return value as unknown as BackendCapability;
    case 'battery':
      exactKeys(value, ['kind', 'nativeFeatureId', 'value'], path);
      stringValue(value.nativeFeatureId, `${path}.nativeFeatureId`, 160);
      if (value.value !== null) finiteRange(value.value, 0, 1, `${path}.value`);
      return value as unknown as BackendCapability;
    case 'rssi':
      exactKeys(value, ['kind', 'nativeFeatureId', 'value'], path);
      stringValue(value.nativeFeatureId, `${path}.nativeFeatureId`, 160);
      if (value.value !== null) integerRange(value.value, -127, 20, `${path}.value`);
      return value as unknown as BackendCapability;
    default:
      fail(`${path}.kind`, 'unknown capability kind');
  }
}

function nativeFence(value: NativeFence): NativeFence {
  return {
    sessionId: value.sessionId,
    topologyGeneration: value.topologyGeneration,
    safetyGeneration: value.safetyGeneration,
  };
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected plain object');
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(path, `missing field ${JSON.stringify(key)}`);
  }
}

function validateSchema(value: unknown, path: string): void {
  if (value !== SCHEMA_VERSION) fail(path, `expected ${SCHEMA_VERSION}`);
}

function validateFence(value: UnknownRecord, path: string): void {
  stringValue(value.sessionId, `${path}.sessionId`, 160);
  integerRange(value.topologyGeneration, 0, MAX_SAFE_GENERATION, `${path}.topologyGeneration`);
  integerRange(value.safetyGeneration, 0, MAX_SAFE_GENERATION, `${path}.safetyGeneration`);
}

function stringValue(value: unknown, path: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    fail(path, `expected non-empty string of at most ${max} characters`);
  }
}

function booleanValue(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'expected boolean');
}

function finiteRange(
  value: unknown,
  min: number,
  max: number,
  path: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `expected finite number in ${min}..${max}`);
  }
}

function integerRange(
  value: unknown,
  min: number,
  max: number,
  path: string,
): asserts value is number {
  finiteRange(value, min, max, path);
  if (!Number.isSafeInteger(value)) fail(path, 'expected safe integer');
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
