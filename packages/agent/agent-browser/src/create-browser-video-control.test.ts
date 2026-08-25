import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceState,
  type LlmClient,
  type LlmImageInput,
} from '@dg-agent/core';
import {
  createEmptyOpossumState,
  type BluetoothDeviceLike,
  type OpossumState,
} from '@dg-kit/protocol';
import type { OpossumCommand } from '@dg-kit/core';
import type { VideoControlSafetyLimits } from '@dg-agent/runtime';
import { BrowserVideoControlService } from './create-browser-video-control.js';
import { MultiCoyoteDeviceClient } from './multi-coyote-client.js';

const FRAME: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'ephemeral-frame',
  width: 2,
  height: 2,
  byteLength: 15,
};

const SAFETY: VideoControlSafetyLimits = {
  maxStrengthA: 50,
  maxStrengthB: 50,
  maxColdStartStrength: 10,
  maxAdjustStep: 10,
  maxBurstDurationMs: 5_000,
  maxBurstStrengthAbsolute: 0,
  maxBurstStrengthRelative: 0,
  maxIntensityA: 50,
  maxIntensityB: 50,
  maxColdStartIntensity: 10,
  maxOpossumAdjustStep: 10,
  maxToolIterations: 5,
  maxToolCallsPerTurn: 5,
  maxAdjustStrengthCallsPerTurn: 2,
  maxBurstCallsPerTurn: 1,
  maxVibrateAdjustCallsPerTurn: 2,
  maxVibrateBurstCallsPerTurn: 1,
  burstRequiresActiveChannel: true,
};

class FakeCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  deviceId: string | null = null;
  readonly execute = vi.fn(async (command: DeviceCommand) => {
    if (command.type === 'adjustStrength') {
      const key = command.channel === 'A' ? 'strengthA' : 'strengthB';
      this.state = { ...this.state, [key]: this.state[key] + command.delta };
      this.emit();
    }
    return { state: { ...this.state } };
  });
  readonly emergencyStop = vi.fn(async () => {
    this.state = { ...this.state, strengthA: 0, strengthB: 0 };
    this.emit();
  });
  readonly disconnect = vi.fn(async () => {
    this.state = { ...this.state, connected: false };
    this.emit();
  });
  private readonly listeners = new Set<(state: DeviceState) => void>();

  constructor(
    private readonly transportId: string,
    private readonly name = '47L121',
  ) {}

  async connect(): Promise<void> {
    this.deviceId = this.transportId;
    this.state = {
      ...createEmptyDeviceState(),
      connected: true,
      deviceName: this.name,
      strengthA: 10,
    };
    this.emit();
  }

  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.deviceId = device.id ?? this.transportId;
    await this.connect();
  }

  async getState(): Promise<DeviceState> {
    return { ...this.state };
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener({ ...this.state });
  }
}

class FakeSingleCoyoteClient extends FakeCoyoteClient {
  override async connect(): Promise<void> {
    await super.connect();
  }
}

class FakeOpossumClient {
  state: OpossumState = createEmptyOpossumState();
  readonly emergencyStop = vi.fn(async () => {
    this.state = { ...this.state, intensityA: 0, intensityB: 0 };
    this.emit();
  });
  private readonly listeners = new Set<(state: OpossumState) => void>();

  async connect(): Promise<void> {
    this.state = { ...createEmptyOpossumState(), connected: true, deviceName: 'Opossum' };
    this.emit();
  }

  async disconnect(): Promise<void> {
    this.state = { ...this.state, connected: false };
    this.emit();
  }

  async getState(): Promise<OpossumState> {
    return { ...this.state };
  }

  async execute(_command: OpossumCommand) {
    return { state: { ...this.state } };
  }

  async setIndicatorColor(_color: number): Promise<void> {}

  onStateChanged(listener: (state: OpossumState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener({ ...this.state });
  }
}

function createService(input: {
  device: MultiCoyoteDeviceClient | FakeSingleCoyoteClient;
  opossum?: FakeOpossumClient;
  llm?: LlmClient;
}) {
  return new BrowserVideoControlService({
    device: input.device,
    opossum: input.opossum ?? new FakeOpossumClient(),
    getLlm: () => input.llm ?? null,
    getSafetyLimits: () => SAFETY,
    hasLease: () => true,
  });
}

function grantInput(targetId: string) {
  return {
    targetKind: 'coyote' as const,
    targetId,
    channel: 'A' as const,
    intensityCap: 30,
    allowEnhanced: true,
    allowBurst: false,
    durationMs: 60_000,
    cadenceMs: 10_000,
    captureIntervalMs: 1_000,
  };
}

describe('BrowserVideoControlService physical targets', () => {
  it('exposes two Coyotes with opaque connection IDs and routes tools to the selected one', async () => {
    const children: FakeCoyoteClient[] = [];
    const ids = ['transport-a', 'transport-b'];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeCoyoteClient(ids[children.length]!, '47L121');
      children.push(child);
      return child;
    });
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(async () => ({
        assistantMessage: 'ok',
        toolCalls: [{ id: 'adjust-b', name: 'shock_adjust', args: { channel: 'A', delta: 2 } }],
      })),
    };
    const service = createService({ device: aggregate, llm });

    const first = await service.connect('coyote');
    const second = await service.connect('coyote');

    expect(service.getSnapshot().coyotes).toHaveLength(2);
    expect([first.targetId, second.targetId]).not.toContain('transport-a');
    expect([first.targetId, second.targetId]).not.toContain('transport-b');

    const grant = await service.authorize(grantInput(second.targetId));
    expect(grant.targetId).toBe(second.targetId);
    service.beginRun();
    await service.observe(FRAME);
    await vi.waitFor(() => expect(children[1]!.execute).toHaveBeenCalledTimes(1));

    expect(children[0]!.execute).not.toHaveBeenCalled();
  });

  it('rejects a stale grant and gives a same-name reconnect a new target ID', async () => {
    const children: FakeCoyoteClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeCoyoteClient('reused-transport-id', '47L121');
      children.push(child);
      return child;
    });
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(async () => ({ assistantMessage: 'ok' })),
    };
    const service = createService({ device: aggregate, llm });
    const original = await service.connect('coyote');
    await service.authorize(grantInput(original.targetId));

    await service.disconnect(original.targetId);
    const replacement = await service.connect('coyote');

    expect(replacement.name).toBe(original.name);
    expect(replacement.targetId).not.toBe(original.targetId);
    expect(service.getSnapshot().coyotes.map(({ targetId }) => targetId)).toEqual([
      replacement.targetId,
    ]);
    expect(() => service.beginRun()).not.toThrow();
    await expect(service.observe(FRAME)).rejects.toThrow('授权物理目标已断开或身份已失效');
    await expect(service.authorize(grantInput(original.targetId))).rejects.toThrow(
      '授权物理目标已断开或身份已失效',
    );
  });

  it('lifecycle-stops only the authorized physical Coyote', async () => {
    const children: FakeCoyoteClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeCoyoteClient(`transport-${children.length + 1}`);
      children.push(child);
      return child;
    });
    const opossum = new FakeOpossumClient();
    const service = createService({ device: aggregate, opossum });
    await service.connect('coyote');
    const selected = await service.connect('coyote');
    await service.connect('opossum');
    await service.authorize(grantInput(selected.targetId));

    await service.stop('stop');

    expect(children[0]!.emergencyStop).not.toHaveBeenCalled();
    expect(children[1]!.emergencyStop).toHaveBeenCalledTimes(1);
    expect(opossum.emergencyStop).not.toHaveBeenCalled();
  });

  it('escalates a stale lifecycle target to every still-connected output', async () => {
    const children: FakeCoyoteClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeCoyoteClient(`transport-${children.length + 1}`);
      children.push(child);
      return child;
    });
    const opossum = new FakeOpossumClient();
    const service = createService({ device: aggregate, opossum });
    await service.connect('coyote');
    const stale = await service.connect('coyote');
    await service.connect('opossum');
    await service.authorize(grantInput(stale.targetId));
    await service.disconnect(stale.targetId);

    await service.stop('device-loss');

    expect(children[0]!.emergencyStop).toHaveBeenCalledTimes(1);
    expect(opossum.emergencyStop).toHaveBeenCalledTimes(1);
    expect(service.isEmergencyLatched()).toBe(true);
  });

  it('surfaces an escalated global-stop failure after attempting every output', async () => {
    const children: FakeCoyoteClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeCoyoteClient(`transport-${children.length + 1}`);
      children.push(child);
      return child;
    });
    const opossum = new FakeOpossumClient();
    const service = createService({ device: aggregate, opossum });
    await service.connect('coyote');
    const stale = await service.connect('coyote');
    await service.connect('opossum');
    await service.authorize(grantInput(stale.targetId));
    await service.disconnect(stale.targetId);
    children[0]!.emergencyStop.mockRejectedValueOnce(new Error('unreachable'));

    await expect(service.stop('device-loss')).rejects.toThrow('unreachable');
    expect(children[0]!.emergencyStop).toHaveBeenCalledTimes(1);
    expect(opossum.emergencyStop).toHaveBeenCalledTimes(1);
    expect(service.isEmergencyLatched()).toBe(true);
  });

  it('keeps emergency stop global across every Coyote and Opossum', async () => {
    const children: FakeCoyoteClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeCoyoteClient(`transport-${children.length + 1}`);
      children.push(child);
      return child;
    });
    const opossum = new FakeOpossumClient();
    const service = createService({ device: aggregate, opossum });
    await service.connect('coyote');
    await service.connect('coyote');
    await service.connect('opossum');

    await service.emergencyStop();

    expect(children[0]!.emergencyStop).toHaveBeenCalledTimes(1);
    expect(children[1]!.emergencyStop).toHaveBeenCalledTimes(1);
    expect(opossum.emergencyStop).toHaveBeenCalledTimes(1);
  });

  it('limits Android-style identity-unprovable transport to one Coyote session target', async () => {
    const device = new FakeSingleCoyoteClient('android-address', '47L121 Android');
    const service = createService({ device });

    const first = await service.connect('coyote');
    expect(service.supportsMultipleCoyotes()).toBe(false);
    expect(first.targetId).not.toContain('android-address');
    await expect(service.connect('coyote')).rejects.toThrow('无法证明多个郊狼身份');

    await service.disconnect(first.targetId);
    const replacement = await service.connect('coyote');
    expect(replacement.targetId).not.toBe(first.targetId);
  });
});
