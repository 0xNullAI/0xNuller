import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  MAX_DEVICES,
  MAX_FEATURES_PER_DEVICE,
  MAX_OUTPUT_LEASE_MS,
  MAX_TOTAL_FEATURES,
  type BackendEvent,
  type DeviceCapability,
  type DeviceSnapshot,
  type RuntimeCommand,
  type RuntimeDevice,
  type RuntimeEvent,
} from './contracts.js';

export class DeviceSchemaError extends Error {
  override readonly name = 'DeviceSchemaError';
}

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new DeviceSchemaError(`${path}: ${message}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'expected object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, 'expected plain object');
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
  path = 'value',
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(path, `missing field ${JSON.stringify(key)}`);
  }
}

function literal(value: unknown, expected: string | number, path: string): void {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
}

function stringValue(value: unknown, path: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    fail(path, `expected non-empty string of at most ${max} characters`);
  }
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

function nullableRange(value: unknown, min: number, max: number, path: string): void {
  if (value !== null) finiteRange(value, min, max, path);
}

function validateFence(value: UnknownRecord, path: string): void {
  stringValue(value.sessionId, `${path}.sessionId`, 160);
  integerRange(value.topologyGeneration, 0, Number.MAX_SAFE_INTEGER, `${path}.topologyGeneration`);
  integerRange(value.safetyGeneration, 0, Number.MAX_SAFE_INTEGER, `${path}.safetyGeneration`);
  stringValue(value.moduleId, `${path}.moduleId`, 128);
  integerRange(value.leaseEpoch, 0, Number.MAX_SAFE_INTEGER, `${path}.leaseEpoch`);
}

function validateCommandBase(value: UnknownRecord, path: string): void {
  literal(value.version, DEVICE_RUNTIME_SCHEMA_VERSION, `${path}.version`);
  stringValue(value.interactionId, `${path}.interactionId`, 128);
}

const FENCE_KEYS = [
  'sessionId',
  'topologyGeneration',
  'safetyGeneration',
  'moduleId',
  'leaseEpoch',
] as const;

/** Strict wire validator: unknown command types and fields are rejected. */
export function parseRuntimeCommand(input: unknown): RuntimeCommand {
  const value = record(input, 'command');
  validateCommandBase(value, 'command');
  switch (value.type) {
    case 'scan':
      exactKeys(value, ['version', 'type', 'interactionId', ...FENCE_KEYS], [], 'command');
      validateFence(value, 'command');
      break;
    case 'disconnect':
      exactKeys(
        value,
        ['version', 'type', 'interactionId', ...FENCE_KEYS, 'deviceId'],
        [],
        'command',
      );
      validateFence(value, 'command');
      stringValue(value.deviceId, 'command.deviceId', 160);
      break;
    case 'vibrate':
      exactKeys(
        value,
        [
          'version',
          'type',
          'interactionId',
          ...FENCE_KEYS,
          'deviceId',
          'featureId',
          'intensity',
          'outputLeaseMs',
        ],
        [],
        'command',
      );
      validateFence(value, 'command');
      stringValue(value.deviceId, 'command.deviceId', 160);
      stringValue(value.featureId, 'command.featureId', 160);
      finiteRange(value.intensity, 0, 1, 'command.intensity');
      integerRange(value.outputLeaseMs, 1, MAX_OUTPUT_LEASE_MS, 'command.outputLeaseMs');
      break;
    case 'stop':
      exactKeys(
        value,
        ['version', 'type', 'interactionId', 'deviceId', 'featureId'],
        [],
        'command',
      );
      stringValue(value.deviceId, 'command.deviceId', 160);
      stringValue(value.featureId, 'command.featureId', 160);
      break;
    case 'emergency-stop':
      exactKeys(value, ['version', 'type', 'interactionId'], [], 'command');
      break;
    default:
      fail('command.type', 'unknown command type');
  }
  return value as unknown as RuntimeCommand;
}

function validateBackendCapability(input: unknown, path: string): void {
  const value = record(input, path);
  switch (value.kind) {
    case 'vibrate':
      exactKeys(value, ['kind', 'nativeFeatureId', 'stepCount'], [], path);
      stringValue(value.nativeFeatureId, `${path}.nativeFeatureId`);
      integerRange(value.stepCount, 1, 10_000, `${path}.stepCount`);
      return;
    case 'battery':
      exactKeys(value, ['kind', 'nativeFeatureId', 'value'], [], path);
      stringValue(value.nativeFeatureId, `${path}.nativeFeatureId`);
      nullableRange(value.value, 0, 1, `${path}.value`);
      return;
    case 'rssi':
      exactKeys(value, ['kind', 'nativeFeatureId', 'value'], [], path);
      stringValue(value.nativeFeatureId, `${path}.nativeFeatureId`);
      if (value.value !== null) integerRange(value.value, -127, 20, `${path}.value`);
      return;
    default:
      fail(`${path}.kind`, 'unknown capability kind');
  }
}

function validateBackendDevices(input: unknown, path: string): void {
  if (!Array.isArray(input)) fail(path, 'expected array');
  if (input.length > MAX_DEVICES) fail(path, `maximum ${MAX_DEVICES} devices exceeded`);
  let featureCount = 0;
  const deviceIds = new Set<string>();
  for (const [deviceIndex, item] of input.entries()) {
    const devicePath = `${path}[${deviceIndex}]`;
    const device = record(item, devicePath);
    exactKeys(device, ['nativeDeviceId', 'name', 'capabilities'], [], devicePath);
    stringValue(device.nativeDeviceId, `${devicePath}.nativeDeviceId`);
    stringValue(device.name, `${devicePath}.name`);
    if (deviceIds.has(device.nativeDeviceId)) fail(devicePath, 'duplicate nativeDeviceId');
    deviceIds.add(device.nativeDeviceId);
    if (!Array.isArray(device.capabilities)) fail(`${devicePath}.capabilities`, 'expected array');
    if (device.capabilities.length > MAX_FEATURES_PER_DEVICE) {
      fail(devicePath, `maximum ${MAX_FEATURES_PER_DEVICE} capabilities per device exceeded`);
    }
    featureCount += device.capabilities.length;
    if (featureCount > MAX_TOTAL_FEATURES) {
      fail(path, `maximum ${MAX_TOTAL_FEATURES} total capabilities exceeded`);
    }
    const featureIds = new Set<string>();
    for (const [featureIndex, capability] of device.capabilities.entries()) {
      const featurePath = `${devicePath}.capabilities[${featureIndex}]`;
      validateBackendCapability(capability, featurePath);
      const nativeFeatureId = (capability as UnknownRecord).nativeFeatureId as string;
      if (featureIds.has(nativeFeatureId)) fail(featurePath, 'duplicate nativeFeatureId');
      featureIds.add(nativeFeatureId);
    }
  }
}

export function parseBackendEvent(input: unknown): BackendEvent {
  const value = record(input, 'backendEvent');
  literal(value.version, DEVICE_RUNTIME_SCHEMA_VERSION, 'backendEvent.version');
  switch (value.type) {
    case 'topology':
      exactKeys(value, ['version', 'type', 'devices'], [], 'backendEvent');
      validateBackendDevices(value.devices, 'backendEvent.devices');
      break;
    case 'session-ended':
      exactKeys(value, ['version', 'type', 'reason'], [], 'backendEvent');
      stringValue(value.reason, 'backendEvent.reason', 512);
      break;
    default:
      fail('backendEvent.type', 'unknown backend event type');
  }
  return value as unknown as BackendEvent;
}

function validateCapability(input: unknown, path: string): asserts input is DeviceCapability {
  const value = record(input, path);
  switch (value.kind) {
    case 'vibrate':
      exactKeys(value, ['kind', 'featureId', 'stepCount', 'faulted'], [], path);
      stringValue(value.featureId, `${path}.featureId`, 160);
      integerRange(value.stepCount, 1, 10_000, `${path}.stepCount`);
      if (typeof value.faulted !== 'boolean') fail(`${path}.faulted`, 'expected boolean');
      return;
    case 'battery':
      exactKeys(value, ['kind', 'featureId', 'value'], [], path);
      stringValue(value.featureId, `${path}.featureId`, 160);
      nullableRange(value.value, 0, 1, `${path}.value`);
      return;
    case 'rssi':
      exactKeys(value, ['kind', 'featureId', 'value'], [], path);
      stringValue(value.featureId, `${path}.featureId`, 160);
      if (value.value !== null) integerRange(value.value, -127, 20, `${path}.value`);
      return;
    default:
      fail(`${path}.kind`, 'unknown capability kind');
  }
}

function validateSnapshot(input: unknown, path: string): asserts input is DeviceSnapshot {
  const value = record(input, path);
  exactKeys(
    value,
    ['version', 'sessionId', 'sequence', 'topologyGeneration', 'safetyGeneration', 'devices'],
    [],
    path,
  );
  literal(value.version, DEVICE_RUNTIME_SCHEMA_VERSION, `${path}.version`);
  stringValue(value.sessionId, `${path}.sessionId`, 160);
  integerRange(value.sequence, 0, Number.MAX_SAFE_INTEGER, `${path}.sequence`);
  integerRange(value.topologyGeneration, 0, Number.MAX_SAFE_INTEGER, `${path}.topologyGeneration`);
  integerRange(value.safetyGeneration, 0, Number.MAX_SAFE_INTEGER, `${path}.safetyGeneration`);
  if (!Array.isArray(value.devices) || value.devices.length > MAX_DEVICES) {
    fail(`${path}.devices`, `expected array of at most ${MAX_DEVICES}`);
  }
  let total = 0;
  for (const [deviceIndex, item] of value.devices.entries()) {
    const devicePath = `${path}.devices[${deviceIndex}]`;
    const device = record(item, devicePath);
    exactKeys(device, ['deviceId', 'name', 'capabilities'], [], devicePath);
    stringValue(device.deviceId, `${devicePath}.deviceId`, 160);
    stringValue(device.name, `${devicePath}.name`);
    if (
      !Array.isArray(device.capabilities) ||
      device.capabilities.length > MAX_FEATURES_PER_DEVICE
    ) {
      fail(`${devicePath}.capabilities`, `expected array of at most ${MAX_FEATURES_PER_DEVICE}`);
    }
    total += device.capabilities.length;
    if (total > MAX_TOTAL_FEATURES) fail(`${path}.devices`, 'too many total capabilities');
    for (const [featureIndex, capability] of device.capabilities.entries()) {
      validateCapability(capability, `${devicePath}.capabilities[${featureIndex}]`);
    }
  }
}

/** Strict validator for events crossing an adapter or persistence boundary. */
export function parseRuntimeEvent(input: unknown): RuntimeEvent {
  const value = record(input, 'event');
  literal(value.version, DEVICE_RUNTIME_SCHEMA_VERSION, 'event.version');
  switch (value.type) {
    case 'snapshot':
      exactKeys(value, ['version', 'type', 'snapshot'], [], 'event');
      validateSnapshot(value.snapshot, 'event.snapshot');
      break;
    case 'ack':
      exactKeys(
        value,
        [
          'version',
          'type',
          'interactionId',
          'status',
          'code',
          'hardwareState',
          'sessionId',
          'topologyGeneration',
          'safetyGeneration',
        ],
        ['appliedIntensity'],
        'event',
      );
      stringValue(value.interactionId, 'event.interactionId', 128);
      if (!['applied', 'stopped', 'rejected', 'faulted'].includes(value.status as string)) {
        fail('event.status', 'unknown ack status');
      }
      stringValue(value.code, 'event.code', 128);
      literal(value.hardwareState, 'unknown', 'event.hardwareState');
      stringValue(value.sessionId, 'event.sessionId', 160);
      integerRange(
        value.topologyGeneration,
        0,
        Number.MAX_SAFE_INTEGER,
        'event.topologyGeneration',
      );
      integerRange(value.safetyGeneration, 0, Number.MAX_SAFE_INTEGER, 'event.safetyGeneration');
      if (Object.hasOwn(value, 'appliedIntensity')) {
        finiteRange(value.appliedIntensity, 0, 1, 'event.appliedIntensity');
      }
      break;
    case 'fault':
      exactKeys(
        value,
        ['version', 'type', 'sessionId', 'deviceId', 'featureId', 'code', 'hardwareState'],
        [],
        'event',
      );
      stringValue(value.sessionId, 'event.sessionId', 160);
      stringValue(value.deviceId, 'event.deviceId', 160);
      stringValue(value.featureId, 'event.featureId', 160);
      literal(value.code, 'stop-failed', 'event.code');
      literal(value.hardwareState, 'unknown', 'event.hardwareState');
      break;
    default:
      fail('event.type', 'unknown runtime event type');
  }
  return value as unknown as RuntimeEvent;
}

export function isRuntimeDevice(input: unknown): input is RuntimeDevice {
  try {
    const value = record(input, 'device');
    exactKeys(value, ['deviceId', 'name', 'capabilities'], [], 'device');
    stringValue(value.deviceId, 'device.deviceId', 160);
    stringValue(value.name, 'device.name');
    if (!Array.isArray(value.capabilities)) return false;
    for (const [index, capability] of value.capabilities.entries()) {
      validateCapability(capability, `device.capabilities[${index}]`);
    }
    return true;
  } catch {
    return false;
  }
}
