import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type LlmClient,
  type ToolDefinition,
} from '@dg-agent/core';
import {
  AgentRuntime,
  createDefaultToolRegistryWithDeps,
  grantDeviceLease,
  hasDeviceLease,
  type PermissionService,
} from '@dg-agent/runtime';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import {
  DgLabConnectionRegistry,
  type DgLabCoyoteClient,
  type DgLabTransport,
  type HolderSafetyLimits,
} from '@0xnullai/device-runtime';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import { CoyoteTargetToolRegistry, createCoyoteTargetRouter } from './coyote-target-routing.js';
import { AGENT_DEVICE_MODULE_ID, createRegistryAgentDevices } from './create-browser-services.js';

/** The BLE-side Coyote the registry owns. Records what actually reached the device. */
class FakeCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  private readonly listeners = new Set<(state: DeviceState) => void>();

  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices; it never opens a second chooser');
  }
  async connectDevice(): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: '47L121000' });
  }
  async disconnect(): Promise<void> {
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<DeviceState> {
    return { ...this.state };
  }
  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    this.writes.push(command);
    if (command.type === 'start') {
      this.set({ ...this.state, strengthA: command.strength, waveActiveA: true });
    }
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.set({ ...this.state, strengthA: 0, strengthB: 0, waveActiveA: false, waveActiveB: false });
  }
  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(state: DeviceState): void {
    this.state = state;
    for (const listener of this.listeners) listener({ ...state });
  }
}

const LIMITS: HolderSafetyLimits = {
  maxStrengthA: 100,
  maxStrengthB: 100,
  maxColdStartStrength: 20,
  maxAdjustStep: 10,
  maxBurstDurationMs: 5000,
  maxBurstStrengthAbsolute: 100,
  maxBurstStrengthRelative: 20,
  maxIntensityA: 100,
  maxIntensityB: 100,
  maxColdStartIntensity: 20,
  maxOpossumAdjustStep: 10,
};

const approve: PermissionService = {
  request: async () => ({ type: 'approve-once' }) as const,
};

/** Starts channel A on whichever Coyote target the tool schema offers; records the offer. */
class StartFirstTargetLlm implements LlmClient {
  readonly offered: ToolDefinition[][] = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.offered.push(input.tools ?? []);
    const start = input.tools?.find((tool) => tool.name === 'shock_start');
    const targetId = (start?.parameters as { properties?: { targetId?: { enum?: string[] } } })
      ?.properties?.targetId?.enum?.[0];
    return {
      assistantMessage: '',
      toolCalls: targetId
        ? [
            {
              id: `start-${this.offered.length}`,
              name: 'shock_start',
              args: { targetId, channel: 'A', strength: 5, waveformId: 'pulse_mid', loop: true },
            },
          ]
        : [],
    };
  }
}

let registry: DgLabConnectionRegistry | null = null;

afterEach(async () => {
  await registry?.dispose();
  registry = null;
  await grantDeviceLease(null);
});

function createRegistry(coyote: FakeCoyote): DgLabConnectionRegistry {
  const device = Object.assign(new EventTarget(), {
    name: '47L121000',
    id: 'addr-1',
    gatt: { connected: true, connect: async () => ({}), disconnect: () => undefined },
  }) as BluetoothDeviceLike;
  const transport: DgLabTransport = {
    requestDevice: async () => ({
      kind: 'coyote',
      device,
      server: {} as BluetoothRemoteGATTServerLike,
    }),
    createCoyoteClient: () => coyote,
    createOpossumClient: () => {
      throw new Error('not used');
    },
    createSensorClient: () => {
      throw new Error('not used');
    },
  };
  return new DgLabConnectionRegistry({ transport, limits: () => LIMITS });
}

/** The same composition createBrowserAgentClient builds, with a scripted model. */
function createAgentRuntime(registry: DgLabConnectionRegistry, llm: LlmClient) {
  const devices = createRegistryAgentDevices(registry.forModule(AGENT_DEVICE_MODULE_ID));
  const coyoteTargetRouter = createCoyoteTargetRouter(devices.device);
  const waveformLibrary = createBasicWaveformLibrary();
  const runtime = new AgentRuntime({
    ...devices,
    coyoteTargetRouter,
    llm,
    toolRegistry: new CoyoteTargetToolRegistry(
      createDefaultToolRegistryWithDeps({ waveformLibrary }),
      coyoteTargetRouter,
    ),
    permission: approve,
    waveformLibrary,
    // The shell gate from use-browser-app-services, minus the per-chat consent half.
    deviceExecutionGate: () => hasDeviceLease(AGENT_DEVICE_MODULE_ID),
    toolCallConfig: { maxToolIterations: 1 },
  });
  return { runtime, devices };
}

async function send(runtime: AgentRuntime, runId: string) {
  await runtime.sendUserMessage({
    sessionId: 'chat',
    runId,
    text: '开始',
    context: { sessionId: 'chat', sourceType: 'web', traceId: runId },
  });
  return runtime.getTaskRun(runId)?.receipts ?? [];
}

describe('Agent over the shared DG-Lab registry', () => {
  it('offers device tools for a Coyote another module connected, and loses them with the lease', async () => {
    const coyote = new FakeCoyote();
    registry = createRegistry(coyote);
    await grantDeviceLease('control');
    const { id } = await registry.forModule('control').connect();

    await grantDeviceLease(AGENT_DEVICE_MODULE_ID);
    const llm = new StartFirstTargetLlm();
    const { runtime, devices } = createAgentRuntime(registry, llm);
    const revoked: string[] = [];
    registry.forModule(AGENT_DEVICE_MODULE_ID).onRevoked(() => revoked.push('agent'));

    const granted = await send(runtime, 'run-agent-holds-lease');
    const start = llm.offered[0]!.find((tool) => tool.name === 'shock_start');
    expect(start?.parameters).toMatchObject({ properties: { targetId: { enum: [id] } } });
    expect(granted).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(coyote.writes).toContainEqual(expect.objectContaining({ type: 'start', strength: 5 }));

    await grantDeviceLease('control');
    expect(revoked).toEqual(['agent']);
    const writesAfterSwitch = coyote.writes.length;

    const denied = await send(runtime, 'run-lease-moved');
    expect(denied).not.toContainEqual(expect.objectContaining({ status: 'succeeded' }));
    // A stale or bypassed Agent gate still cannot write: the registry fences on the lease.
    await expect(
      (
        devices.device as unknown as {
          executeDeviceById(targetId: string, command: DeviceCommand): Promise<unknown>;
        }
      ).executeDeviceById(id, { type: 'adjustStrength', channel: 'A', delta: 1 }),
    ).rejects.toMatchObject({ code: 'lease-not-held' });
    expect(coyote.writes.slice(writesAfterSwitch)).not.toContainEqual(
      expect.objectContaining({ type: 'start' }),
    );
    expect(coyote.writes.slice(writesAfterSwitch)).not.toContainEqual(
      expect.objectContaining({ type: 'adjustStrength' }),
    );
    runtime.dispose();
  });

  it('lease loss releases Agent work without zeroing output the new holder starts', async () => {
    const coyote = new FakeCoyote();
    registry = createRegistry(coyote);
    await grantDeviceLease(AGENT_DEVICE_MODULE_ID);
    const control = registry.forModule('control');
    const { id } = await control.connect();
    const { runtime } = createAgentRuntime(registry, new StartFirstTargetLlm());
    await send(runtime, 'run-before-switch');
    expect(coyote.state.strengthA).toBe(5);

    // What Agent's revoke does on the registry path: abort and release, no device write.
    registry.forModule(AGENT_DEVICE_MODULE_ID).onRevoked(() => {
      void runtime.abortCurrentReply('chat');
      runtime.releaseDeviceControl('chat');
    });
    await grantDeviceLease('control');
    expect(coyote.state.strengthA).toBe(0);

    // The new holder starts output a few ms after the switch.
    await control.execute(id, {
      type: 'start',
      channel: 'A',
      strength: 15,
      waveform: { id: 'w', name: 'w', frames: [[10, 50]] },
      loop: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(coyote.state.strengthA).toBe(15);
    runtime.dispose();
  });
});
