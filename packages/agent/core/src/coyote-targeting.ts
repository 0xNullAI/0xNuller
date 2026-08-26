import {
  createEmptyDeviceState,
  type DeviceClient,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type ToolDefinition,
} from '@dg-kit/core';

/** One currently connected Coyote instance exposed to an Agent model. */
export interface CoyoteTargetSnapshot {
  /** Opaque, connection-lifetime identity. Never derive this from a device name or BLE address. */
  targetId: string;
  state: DeviceState;
}

/** Exact-target boundary shared by Agent composition, policy evaluation, and final execution. */
export interface CoyoteTargetRouter {
  listTargets(): Promise<CoyoteTargetSnapshot[]>;
  getTargetState(targetId: string): Promise<DeviceState | null>;
  executeTarget(targetId: string, command: DeviceCommand): Promise<DeviceCommandResult | null>;
  emergencyStopTarget(targetId: string): Promise<boolean>;
}

export function createExactCoyoteDeviceClient(
  router: CoyoteTargetRouter,
  targetId: string,
): DeviceClient {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => (await router.getTargetState(targetId)) ?? createEmptyDeviceState(),
    execute: async (command) => {
      const result = await router.executeTarget(targetId, command);
      if (!result) throw new Error('目标郊狼未连接或身份已失效');
      return result;
    },
    emergencyStop: async () => {
      if (!(await router.emergencyStopTarget(targetId))) {
        throw new Error('目标郊狼未连接或身份已失效');
      }
    },
    onStateChanged: () => () => undefined,
  };
}

/** Adds the shared exact-target field to every model-visible Coyote tool. */
export function withCoyoteTargetIds(
  definitions: ToolDefinition[],
  targetIds: string[],
): ToolDefinition[] {
  return definitions.map((definition) => {
    if (!isCoyoteModelTool(definition.name)) return definition;
    const parameters = definition.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      ...definition,
      description: `${definition.description}\n目标：targetId 必须逐字使用当前设备状态中的 opaque 标识；每次只控制一个目标。`,
      parameters: {
        ...definition.parameters,
        properties: {
          targetId: {
            type: 'string',
            enum: targetIds,
            description: '当前连接实例的 opaque targetId。不得按设备名称猜测。',
          },
          ...(parameters.properties ?? {}),
        },
        required: [
          'targetId',
          ...(parameters.required ?? []).filter((name) => name !== 'targetId'),
        ],
        additionalProperties: false,
      },
    };
  });
}

function isCoyoteModelTool(name: string): boolean {
  return ['shock_start', 'shock_stop', 'shock_adjust', 'shock_change_wave', 'shock_burst'].includes(
    name,
  );
}
