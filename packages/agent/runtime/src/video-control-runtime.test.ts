import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceClient,
  type DeviceCommand,
  type DeviceState,
  type LlmClient,
  type LlmImageInput,
  type PermissionService,
} from '@dg-agent/core';
import {
  createEmptyOpossumState,
  type OpossumClient,
  type OpossumCommandResult,
  type OpossumState,
} from '@dg-kit/protocol';
import { createDefaultToolRegistry } from '@dg-kit/tools';
import {
  VideoControlRuntime,
  narrowVideoToolDefinitions,
  type VideoControlSafetyLimits,
  type VideoControlTargetRouter,
} from './video-control-runtime.js';
import { VideoControlGrant } from './video-control-grant.js';

const FRAME: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'private-image-payload',
  width: 640,
  height: 480,
  byteLength: 21,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createDevice(
  execute = vi.fn(async () => ({ state: createConnectedCoyote() })),
): DeviceClient & { execute: typeof execute; emergencyStop: ReturnType<typeof vi.fn> } {
  let state = createConnectedCoyote();
  const emergencyStop = vi.fn(async () => {
    state = { ...state, strengthA: 0, strengthB: 0, waveActiveA: false, waveActiveB: false };
  });
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => ({ ...state }),
    execute,
    emergencyStop,
    onStateChanged: () => () => undefined,
  };
}

function createConnectedCoyote(): DeviceState {
  return {
    ...createEmptyDeviceState(),
    connected: true,
    strengthA: 10,
    waveActiveA: true,
  };
}

function createOpossum(): OpossumClient {
  let state: OpossumState = { ...createEmptyOpossumState(), connected: true };
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => ({ ...state }),
    execute: async (): Promise<OpossumCommandResult> => ({ state: { ...state } }),
    emergencyStop: async () => {
      state = { ...state, intensityA: 0, intensityB: 0 };
    },
    setIndicatorColor: async () => undefined,
    onStateChanged: () => () => undefined,
  };
}

function createRuntime(input: {
  llm: LlmClient;
  device?: DeviceClient;
  opossum?: OpossumClient;
  permission?: PermissionService;
  onEffectSettled?: (output: string | null) => void;
  onEvent?: (event: unknown) => void;
  targetRouter?: VideoControlTargetRouter;
}) {
  const device = input.device ?? createDevice();
  const opossum = input.opossum ?? createOpossum();
  const targetRouter: VideoControlTargetRouter = input.targetRouter ?? {
    selectTarget: async (kind, targetId) =>
      targetId === `${kind}-session-1` &&
      (kind === 'coyote'
        ? (await device.getState()).connected
        : (await opossum.getState()).connected),
    getCoyoteState: async (targetId) =>
      targetId === 'coyote-session-1' ? device.getState() : null,
    getOpossumState: async (targetId) =>
      targetId === 'opossum-session-1' ? opossum.getState() : null,
    executeCoyote: async (targetId, command) =>
      targetId === 'coyote-session-1' ? device.execute(command) : null,
    executeOpossum: async (targetId, command) =>
      targetId === 'opossum-session-1' ? opossum.execute(command) : null,
    stopTarget: async (kind, targetId) => {
      if (targetId !== `${kind}-session-1`) return false;
      await (kind === 'coyote' ? device.emergencyStop() : opossum.emergencyStop());
      return true;
    },
  };
  return new VideoControlRuntime({
    device,
    opossum,
    getLlm: () => input.llm,
    getSafetyLimits: () => SAFETY,
    hasLease: () => true,
    targetRouter,
    permission: input.permission,
    onEffectSettled: (_call, output) => input.onEffectSettled?.(output),
    onRuntimeEvent: input.onEvent,
  });
}

async function authorize(runtime: VideoControlRuntime): Promise<void> {
  await runtime.authorize({
    targetKind: 'coyote',
    targetId: 'coyote-session-1',
    channel: 'A',
    intensityCap: 30,
    allowEnhanced: true,
    allowBurst: false,
    durationMs: 60_000,
    cadenceMs: 10_000,
    captureIntervalMs: 1_000,
  });
  runtime.beginRun();
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

describe('VideoControlRuntime', () => {
  it('does not let delayed target authorization clear a newer emergency latch', async () => {
    const selected = deferred<boolean>();
    const device = createDevice();
    const targetRouter: VideoControlTargetRouter = {
      selectTarget: () => selected.promise,
      getCoyoteState: async () => createConnectedCoyote(),
      getOpossumState: async () => null,
      executeCoyote: async (_targetId, command) => device.execute(command),
      executeOpossum: async () => null,
      stopTarget: async () => true,
    };
    const runtime = createRuntime({
      llm: { capabilities: { imageInput: true }, runTurn: vi.fn() },
      device,
      targetRouter,
    });
    const pending = runtime.authorize({
      targetKind: 'coyote',
      targetId: 'coyote-session-1',
      channel: 'A',
      intensityCap: 30,
      allowEnhanced: true,
      allowBurst: false,
      durationMs: 60_000,
      cadenceMs: 10_000,
      captureIntervalMs: 1_000,
    });

    await runtime.emergencyStop();
    selected.resolve(true);

    await expect(pending).rejects.toThrow('cancelled');
    expect(runtime.getGrant()).toBeNull();
    expect(runtime.isEmergencyLatched()).toBe(true);
  });

  it('keeps inference single-flight', async () => {
    const first = deferred<{ assistantMessage: string }>();
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(() => first.promise),
    };
    const runtime = createRuntime({ llm });
    await authorize(runtime);

    const pending = runtime.observe(FRAME);
    await expect(runtime.observe(FRAME)).rejects.toThrow('已有画面正在分析');
    first.resolve({ assistantMessage: 'ok' });
    await expect(pending).resolves.toBe('ok');
  });

  it('registers and removes exactly one external abort listener', async () => {
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(async () => ({ assistantMessage: 'ok' })),
    };
    const runtime = createRuntime({ llm });
    await authorize(runtime);
    const external = new AbortController();
    const add = vi.spyOn(external.signal, 'addEventListener');
    const remove = vi.spyOn(external.signal, 'removeEventListener');

    await runtime.observe(FRAME, external.signal);

    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('returns the observation without waiting for asynchronous tool execution', async () => {
    const execution = deferred<{ state: DeviceState }>();
    const execute = vi.fn((_command: DeviceCommand) => execution.promise);
    const device = createDevice(execute);
    const settled = vi.fn();
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi
        .fn()
        .mockResolvedValueOnce({
          assistantMessage: '继续保持节奏。',
          toolCalls: [{ id: 'adjust-1', name: 'shock_adjust', args: { channel: 'A', delta: 2 } }],
        })
        .mockResolvedValueOnce({ assistantMessage: '已看到下一帧。' }),
    };
    const runtime = createRuntime({ llm, device, onEffectSettled: settled });
    await authorize(runtime);

    await expect(runtime.observe(FRAME)).resolves.toBe('继续保持节奏。');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(settled).not.toHaveBeenCalled();
    await expect(runtime.observe(FRAME)).resolves.toBe('已看到下一帧。');
    expect(llm.runTurn).toHaveBeenCalledTimes(2);

    execution.resolve({ state: createConnectedCoyote() });
    await flushAsyncWork();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('emergency latch aborts delayed effects and an old generation cannot resume output', async () => {
    const permission = deferred<{ type: 'approve-scoped' }>();
    const execute = vi.fn(async () => ({ state: createConnectedCoyote() }));
    const device = createDevice(execute);
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(async () => ({
        assistantMessage: '收到。',
        toolCalls: [{ id: 'late', name: 'shock_adjust', args: { channel: 'A', delta: 2 } }],
      })),
    };
    const runtime = createRuntime({
      llm,
      device,
      permission: { request: () => permission.promise },
    });
    await authorize(runtime);

    await runtime.observe(FRAME);
    await flushAsyncWork();
    await runtime.emergencyStop();
    permission.resolve({ type: 'approve-scoped' });
    await flushAsyncWork();

    expect(runtime.isEmergencyLatched()).toBe(true);
    expect(device.emergencyStop).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(() => runtime.beginRun()).toThrow('紧急停止已锁定');
  });

  it('blocks resume until a paused target has confirmed stop', async () => {
    const device = createDevice();
    const runtime = createRuntime({
      llm: { capabilities: { imageInput: true }, runTurn: vi.fn() },
      device,
    });
    await authorize(runtime);
    const stopped = deferred<void>();
    device.emergencyStop.mockImplementation(() => stopped.promise);

    const stopping = runtime.stop('pause');
    await vi.waitFor(() => expect(device.emergencyStop).toHaveBeenCalledOnce());
    expect(() => runtime.beginRun()).toThrow('正在确认设备已停止');
    stopped.resolve();
    await stopping;
    expect(() => runtime.beginRun()).not.toThrow();
  });

  it('emergency-stops both output families even when only one target was authorized', async () => {
    const device = createDevice();
    const opossum = createOpossum();
    const coyoteStop = vi.spyOn(device, 'emergencyStop');
    const opossumStop = vi.spyOn(opossum, 'emergencyStop');
    const runtime = createRuntime({
      device,
      opossum,
      llm: { capabilities: { imageInput: true }, runTurn: vi.fn() },
    });
    await authorize(runtime);

    await runtime.emergencyStop();

    expect(coyoteStop).toHaveBeenCalledTimes(1);
    expect(opossumStop).toHaveBeenCalledTimes(1);
  });

  it('latches after a stop failure and rejects later output until explicit reauthorization', async () => {
    const device = createDevice();
    device.emergencyStop.mockRejectedValueOnce(new Error('stop failed'));
    const runtime = createRuntime({
      device,
      llm: { capabilities: { imageInput: true }, runTurn: vi.fn() },
    });
    await authorize(runtime);

    await expect(runtime.stop('watchdog')).rejects.toThrow('stop failed');
    expect(runtime.isEmergencyLatched()).toBe(true);
    expect(() => runtime.beginRun()).toThrow('紧急停止已锁定');
  });

  it('never copies image bytes into messages, conversation text, runtime events or traces', async () => {
    const inputs: Parameters<LlmClient['runTurn']>[0][] = [];
    const events: unknown[] = [];
    const llm: LlmClient = {
      capabilities: { imageInput: true },
      runTurn: vi.fn(async (input) => {
        inputs.push(input);
        return { assistantMessage: '仅内存回应' };
      }),
    };
    const runtime = createRuntime({ llm, onEvent: (event) => events.push(event) });
    await authorize(runtime);
    await runtime.observe(FRAME);

    const input = inputs[0]!;
    expect(input.image?.data).toBe(FRAME.data);
    expect(JSON.stringify(input.session.messages)).not.toContain(FRAME.data);
    expect(JSON.stringify(input.conversation)).not.toContain(FRAME.data);
    expect(JSON.stringify(events)).not.toContain(FRAME.data);
    expect(input.session.messages).toEqual([]);
  });
});

describe('Video tool definitions', () => {
  it('narrows the shared @dg-kit/tools definitions instead of declaring a duplicate API', async () => {
    const shared = await createDefaultToolRegistry({}).listDefinitions();
    const grant = new VideoControlGrant({
      targetKind: 'coyote',
      targetId: 'coyote-session-1',
      channel: 'B',
      intensityCap: 25,
      allowEnhanced: false,
      allowBurst: false,
      durationMs: 60_000,
      cadenceMs: 10_000,
      captureIntervalMs: 1_000,
    }).getSnapshot();
    const video = narrowVideoToolDefinitions(shared, grant);

    expect(video.map((definition) => definition.name)).toEqual([
      'shock_start',
      'shock_stop',
      'shock_adjust',
      'shock_change_wave',
    ]);
    const sharedStart = shared.find((definition) => definition.name === 'shock_start')!;
    const videoStart = video.find((definition) => definition.name === 'shock_start')!;
    expect(videoStart.description).toBe(sharedStart.description);
    const properties = videoStart.parameters.properties as Record<
      string,
      { enum?: string[]; maximum?: number }
    >;
    expect(properties.channel?.enum).toEqual(['B']);
    expect(properties.strength?.maximum).toBe(25);
  });
});
