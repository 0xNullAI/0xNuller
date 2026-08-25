import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  MAX_OUTPUT_LEASE_MS,
  type CommandAck,
  type DeviceId,
  type DeviceSnapshot,
  type FeatureId,
  type RuntimeCommand,
} from './contracts.js';
import type { DeviceRuntimeExecutor } from './executor.js';
import type { DeviceRuntimeManager } from './manager.js';

export type DeviceToolName =
  | 'device_snapshot'
  | 'device_scan'
  | 'device_disconnect'
  | 'device_vibrate'
  | 'device_stop'
  | 'device_emergency_stop';

export interface DeviceToolDefinition {
  name: DeviceToolName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

const INTERACTION = { type: 'string', minLength: 1, maxLength: 128 } as const;
const DEVICE_ID = { type: 'string', minLength: 1, maxLength: 160 } as const;
const FEATURE_ID = { type: 'string', minLength: 1, maxLength: 160 } as const;

/** Full SDK-neutral catalog; AI adapters derive a smaller positive allowlist from it. */
export const DEVICE_TOOL_CATALOG: readonly DeviceToolDefinition[] = [
  {
    name: 'device_snapshot',
    description: 'List connected devices and their vibration, battery, and RSSI capabilities.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'device_scan',
    description: 'Ask the active backend session to scan for devices.',
    inputSchema: {
      type: 'object',
      properties: { interactionId: INTERACTION },
      required: ['interactionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_disconnect',
    description: 'Stop output and disconnect one device.',
    inputSchema: {
      type: 'object',
      properties: { interactionId: INTERACTION, deviceId: DEVICE_ID },
      required: ['interactionId', 'deviceId'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_vibrate',
    description: 'Write a normalized, bounded vibration intensity with a short output lease.',
    inputSchema: {
      type: 'object',
      properties: {
        interactionId: INTERACTION,
        deviceId: DEVICE_ID,
        featureId: FEATURE_ID,
        intensity: { type: 'number', minimum: 0, maximum: 1 },
        outputLeaseMs: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_LEASE_MS },
      },
      required: ['interactionId', 'deviceId', 'featureId', 'intensity', 'outputLeaseMs'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_stop',
    description:
      'Immediately stop one vibration feature. No control lease or permission is required.',
    inputSchema: {
      type: 'object',
      properties: { interactionId: INTERACTION, deviceId: DEVICE_ID, featureId: FEATURE_ID },
      required: ['interactionId', 'deviceId', 'featureId'],
      additionalProperties: false,
    },
  },
  {
    name: 'device_emergency_stop',
    description: 'Immediately stop all output in the backend session.',
    inputSchema: {
      type: 'object',
      properties: { interactionId: INTERACTION },
      required: ['interactionId'],
      additionalProperties: false,
    },
  },
] as const;

export interface DeviceControlActions {
  snapshot(): DeviceSnapshot;
  scan(input: { interactionId: string }): Promise<CommandAck>;
  disconnect(input: { interactionId: string; deviceId: DeviceId }): Promise<CommandAck>;
  vibrate(input: {
    interactionId: string;
    deviceId: DeviceId;
    featureId: FeatureId;
    intensity: number;
    outputLeaseMs: number;
  }): Promise<CommandAck>;
  stop(input: {
    interactionId: string;
    deviceId: DeviceId;
    featureId: FeatureId;
  }): Promise<CommandAck>;
  emergencyStop(input: { interactionId: string }): Promise<CommandAck>;
}

export interface BoundDeviceTools {
  catalog: readonly DeviceToolDefinition[];
  actions: DeviceControlActions;
  invoke(name: DeviceToolName, input: unknown): Promise<DeviceSnapshot | CommandAck>;
}

/** One provider supplies SDK adapters and typed Control code from the same actions. */
export class DeviceToolProvider {
  private readonly manager: DeviceRuntimeManager;
  private readonly executor: DeviceRuntimeExecutor;

  constructor(manager: DeviceRuntimeManager, executor: DeviceRuntimeExecutor) {
    this.manager = manager;
    this.executor = executor;
  }

  forModule(moduleId: string): BoundDeviceTools {
    if (!moduleId || moduleId.length > 128) throw new Error('Invalid module id');
    const actions = this.createActions(moduleId);
    return {
      catalog: DEVICE_TOOL_CATALOG,
      actions,
      invoke: async (name, input) => {
        const value = strictToolInput(name, input);
        switch (name) {
          case 'device_snapshot':
            return actions.snapshot();
          case 'device_scan':
            return actions.scan({ interactionId: value.interactionId as string });
          case 'device_disconnect':
            return actions.disconnect({
              interactionId: value.interactionId as string,
              deviceId: value.deviceId as DeviceId,
            });
          case 'device_vibrate':
            return actions.vibrate({
              interactionId: value.interactionId as string,
              deviceId: value.deviceId as DeviceId,
              featureId: value.featureId as FeatureId,
              intensity: value.intensity as number,
              outputLeaseMs: value.outputLeaseMs as number,
            });
          case 'device_stop':
            return actions.stop({
              interactionId: value.interactionId as string,
              deviceId: value.deviceId as DeviceId,
              featureId: value.featureId as FeatureId,
            });
          case 'device_emergency_stop':
            return actions.emergencyStop({ interactionId: value.interactionId as string });
        }
      },
    };
  }

  private createActions(moduleId: string): DeviceControlActions {
    const executeFenced = (
      command: Omit<
        Extract<RuntimeCommand, { type: 'scan' | 'disconnect' | 'vibrate' }>,
        keyof ReturnType<DeviceRuntimeExecutor['captureFence']> | 'version'
      >,
    ) =>
      this.executor.execute({
        version: DEVICE_RUNTIME_SCHEMA_VERSION,
        ...this.executor.captureFence(moduleId),
        ...command,
      });

    return {
      snapshot: () => this.manager.snapshot(),
      scan: (input) => executeFenced({ type: 'scan', ...input }),
      disconnect: (input) => executeFenced({ type: 'disconnect', ...input }),
      vibrate: (input) => executeFenced({ type: 'vibrate', ...input }),
      stop: (input) =>
        this.executor.execute({
          version: DEVICE_RUNTIME_SCHEMA_VERSION,
          type: 'stop',
          ...input,
        }),
      emergencyStop: (input) =>
        this.executor.execute({
          version: DEVICE_RUNTIME_SCHEMA_VERSION,
          type: 'emergency-stop',
          ...input,
        }),
    };
  }
}

function strictToolInput(name: DeviceToolName, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${name}: expected object`);
  }
  const value = input as Record<string, unknown>;
  const required: Record<DeviceToolName, readonly string[]> = {
    device_snapshot: [],
    device_scan: ['interactionId'],
    device_disconnect: ['interactionId', 'deviceId'],
    device_vibrate: ['interactionId', 'deviceId', 'featureId', 'intensity', 'outputLeaseMs'],
    device_stop: ['interactionId', 'deviceId', 'featureId'],
    device_emergency_stop: ['interactionId'],
  };
  const keys = required[name];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${name}: unknown field`);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${name}: missing field`);
  for (const key of keys.filter((key) => key.endsWith('Id'))) {
    const max = key === 'interactionId' ? 128 : 160;
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > max) {
      throw new Error(`${name}: invalid ${key}`);
    }
  }
  if (name === 'device_vibrate') {
    if (
      typeof value.intensity !== 'number' ||
      !Number.isFinite(value.intensity) ||
      value.intensity < 0 ||
      value.intensity > 1
    ) {
      throw new Error(`${name}: invalid intensity`);
    }
    if (
      !Number.isSafeInteger(value.outputLeaseMs) ||
      (value.outputLeaseMs as number) < 1 ||
      (value.outputLeaseMs as number) > MAX_OUTPUT_LEASE_MS
    ) {
      throw new Error(`${name}: invalid outputLeaseMs`);
    }
  }
  return value;
}
