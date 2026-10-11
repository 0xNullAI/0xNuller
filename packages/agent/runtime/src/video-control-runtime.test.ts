import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceClient,
  type DeviceCommand,
  type DeviceState,
} from '@dg-agent/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import type { OpossumClient } from './device-clients.js';
import {
  VideoControlRuntime,
  type VideoControlSafetyLimits,
  type VideoControlTargetRouter,
} from './video-control-runtime.js';

const limits: VideoControlSafetyLimits = {
  maxStrengthA: 100,
  maxStrengthB: 100,
  maxColdStartStrength: 20,
  maxAdjustStep: 10,
  maxBurstDurationMs: 2_000,
  maxBurstStrengthAbsolute: 50,
  maxBurstStrengthRelative: 10,
  maxIntensityA: 100,
  maxIntensityB: 100,
  maxColdStartIntensity: 20,
  maxOpossumAdjustStep: 10,
  maxToolIterations: 3,
  maxToolCallsPerTurn: 5,
  maxAdjustStrengthCallsPerTurn: 3,
  maxBurstCallsPerTurn: 1,
  maxVibrateAdjustCallsPerTurn: 3,
  maxVibrateBurstCallsPerTurn: 1,
  burstRequiresActiveChannel: true,
};

function createRuntime() {
  let state: DeviceState = { ...createEmptyDeviceState(), connected: true };
  const executeCoyote = vi.fn(async (_targetId: string, command: DeviceCommand) => {
    if (command.type === 'start')
      state = { ...state, strengthA: command.strength, waveActiveA: true };
    if (command.type === 'stop') state = { ...state, strengthA: 0, waveActiveA: false };
    return { state };
  });
  const router: VideoControlTargetRouter = {
    selectTarget: (kind, targetId) => kind === 'coyote' && targetId === 'coyote-1',
    getCoyoteState: async (targetId) => (targetId === 'coyote-1' ? state : null),
    getOpossumState: async () => null,
    executeCoyote,
    executeOpossum: async () => null,
    stopTarget: () => true,
  };
  const device = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => state,
    execute: async () => ({ state }),
    emergencyStop: async () => undefined,
    onStateChanged: () => () => undefined,
  } as unknown as DeviceClient;
  const opossum = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => createEmptyOpossumState(),
    execute: async () => ({ state: createEmptyOpossumState() }),
    emergencyStop: async () => undefined,
    setIndicatorColor: async () => undefined,
    onStateChanged: () => () => undefined,
  } as unknown as OpossumClient;
  const runtime = new VideoControlRuntime({
    device,
    opossum,
    getLlm: () => null,
    getSafetyLimits: () => limits,
    hasLease: () => true,
    targetRouter: router,
    waveformLibrary: createBasicWaveformLibrary(),
  });
  return { runtime, executeCoyote };
}

const grant = {
  targetKind: 'coyote' as const,
  targetId: 'coyote-1',
  channel: 'A' as const,
  intensityCap: 20,
  allowEnhanced: false,
  allowBurst: false,
  durationMs: 60_000,
  cadenceMs: 5_000,
  captureIntervalMs: 1_000,
};

describe('VideoControlRuntime.executeAuthorizedTool', () => {
  it('names the granted physical Coyote in an accepted command result', async () => {
    const { runtime, executeCoyote } = createRuntime();
    await runtime.authorize(grant);
    const output = JSON.parse(
      await runtime.executeAuthorizedTool({
        id: 'video-start',
        name: 'shock_start',
        args: { channel: 'A', strength: 10 },
      }),
    );
    expect(executeCoyote).toHaveBeenCalledWith(
      'coyote-1',
      expect.objectContaining({ type: 'start' }),
    );
    expect(output).toMatchObject({ ok: true, targetId: 'coyote-1', command: { type: 'start' } });
  });

  it('does not name a target when the grant changed during the command', async () => {
    const { runtime, executeCoyote } = createRuntime();
    await runtime.authorize(grant);
    executeCoyote.mockImplementationOnce(async (_targetId, command) => {
      await runtime.emergencyStop();
      return {
        state: {
          ...createEmptyDeviceState(),
          connected: true,
          strengthA: command.type === 'start' ? command.strength : 0,
        },
      };
    });
    const output = await runtime.executeAuthorizedTool({
      id: 'video-start',
      name: 'shock_start',
      args: { channel: 'A', strength: 10 },
    });
    expect(JSON.parse(output).targetId).toBeUndefined();
  });
});
