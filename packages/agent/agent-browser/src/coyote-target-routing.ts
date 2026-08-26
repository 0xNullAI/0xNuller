import type {
  CoyoteTargetRouter,
  CoyoteTargetSnapshot,
  DeviceClient,
  DeviceCommand,
  DeviceCommandResult,
  ToolCall,
  ToolDefinition,
  ToolExecutionPlan,
} from '@dg-agent/core';
import { withCoyoteTargetIds } from '@dg-agent/core';
import { ToolRegistry } from '@dg-agent/runtime';
import type { ConnectedCoyote } from './multi-coyote-client.js';

interface MultiCoyoteExactClient extends DeviceClient {
  getConnectedCoyotes(): ConnectedCoyote[];
  getDeviceStateById(targetId: string): Promise<CoyoteTargetSnapshot['state'] | null>;
  executeDeviceById(targetId: string, command: DeviceCommand): Promise<DeviceCommandResult | null>;
  emergencyStopDeviceById(targetId: string): Promise<boolean>;
}

/** Adapts both single and multi-Coyote clients to one exact-target boundary. */
export function createCoyoteTargetRouter(
  device: DeviceClient,
  initialTargetId = `coyote/${crypto.randomUUID()}`,
): CoyoteTargetRouter {
  if (isMultiCoyoteExactClient(device)) {
    return {
      listTargets: async () =>
        device.getConnectedCoyotes().map(({ id, state }) => ({ targetId: id, state })),
      getTargetState: (id) => device.getDeviceStateById(id),
      executeTarget: (id, command) => device.executeDeviceById(id, command),
      emergencyStopTarget: (id) => device.emergencyStopDeviceById(id),
    };
  }

  let nextIdentity: string | null = initialTargetId;
  let activeTargetId: string | null = null;
  const updateIdentity = (state: CoyoteTargetSnapshot['state']): string | null => {
    if (!state.connected) {
      activeTargetId = null;
      return null;
    }
    activeTargetId ??= nextIdentity ?? `coyote/${crypto.randomUUID()}`;
    nextIdentity = null;
    return activeTargetId;
  };
  device.onStateChanged((state) => updateIdentity(state));
  return {
    listTargets: async () => {
      const state = await device.getState();
      const targetId = updateIdentity(state);
      return targetId ? [{ targetId, state }] : [];
    },
    getTargetState: async (id) => {
      const state = await device.getState();
      return updateIdentity(state) === id ? state : null;
    },
    executeTarget: async (id, command) => {
      if (updateIdentity(await device.getState()) !== id) return null;
      return device.execute(command);
    },
    emergencyStopTarget: async (id) => {
      if (updateIdentity(await device.getState()) !== id) return false;
      await device.emergencyStop();
      return true;
    },
  };
}

/** Adds an exact opaque target enum to every Coyote model tool. */
export class CoyoteTargetToolRegistry extends ToolRegistry {
  constructor(
    private readonly legacy: ToolRegistry,
    private readonly targets: Pick<CoyoteTargetRouter, 'listTargets'>,
  ) {
    super();
  }

  override resolve(toolCall: ToolCall): Promise<ToolExecutionPlan> {
    return this.legacy.resolve(toolCall);
  }

  override async listDefinitions(): Promise<ToolDefinition[]> {
    const [definitions, targets] = await Promise.all([
      this.legacy.listDefinitions(),
      this.targets.listTargets(),
    ]);
    const targetIds = targets.map(({ targetId }) => targetId);
    return withCoyoteTargetIds(definitions, targetIds);
  }

  override getDisplayName(name: string): string | undefined {
    return this.legacy.getDisplayName(name);
  }

  override summarizeCommand(
    name: string,
    command: Parameters<ToolRegistry['summarizeCommand']>[1],
  ) {
    return this.legacy.summarizeCommand(name, command);
  }

  override resetTurn(): void {
    this.legacy.resetTurn();
  }
}

function isMultiCoyoteExactClient(device: DeviceClient): device is MultiCoyoteExactClient {
  const candidate = device as Partial<MultiCoyoteExactClient>;
  return (
    typeof candidate.getConnectedCoyotes === 'function' &&
    typeof candidate.getDeviceStateById === 'function' &&
    typeof candidate.executeDeviceById === 'function' &&
    typeof candidate.emergencyStopDeviceById === 'function'
  );
}
