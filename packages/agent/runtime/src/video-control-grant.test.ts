import { describe, expect, it } from 'vitest';
import type { DeviceExecutionGateInput } from './runtime-tool-executor.js';
import {
  VIDEO_CONTROL_MAX_DURATION_MS,
  VIDEO_CONTROL_MIN_CADENCE_MS,
  VIDEO_CONTROL_MIN_CAPTURE_INTERVAL_MS,
  VideoControlGrant,
} from './video-control-grant.js';

function gate(
  deviceKind: DeviceExecutionGateInput['deviceKind'],
  command: DeviceExecutionGateInput['command'],
): DeviceExecutionGateInput {
  return {
    sessionId: 'video-control-ephemeral',
    context: { sessionId: 'video-control-ephemeral', sourceType: 'web', traceId: 'test' },
    deviceKind,
    toolName: 'test',
    command,
  };
}

describe('VideoControlGrant', () => {
  it('bounds duration, cadence and intensity by the current safety cap', () => {
    const grant = new VideoControlGrant(
      {
        targetKind: 'coyote',
        channel: 'B',
        intensityCap: 180,
        allowEnhanced: true,
        allowBurst: true,
        durationMs: Number.MAX_SAFE_INTEGER,
        cadenceMs: 1,
        captureIntervalMs: 1,
      },
      { now: () => 1_000, safetyIntensityCap: 42 },
    ).getSnapshot();

    expect(grant).toMatchObject({
      channel: 'B',
      intensityCap: 42,
      durationMs: VIDEO_CONTROL_MAX_DURATION_MS,
      cadenceMs: VIDEO_CONTROL_MIN_CADENCE_MS,
      captureIntervalMs: VIDEO_CONTROL_MIN_CAPTURE_INTERVAL_MS,
      expiresAt: 1_000 + VIDEO_CONTROL_MAX_DURATION_MS,
      revoked: false,
    });
  });

  it('expires and revokes only in memory', () => {
    let now = 0;
    const grant = new VideoControlGrant(
      {
        targetKind: 'opossum',
        channel: 'A',
        intensityCap: 20,
        allowEnhanced: false,
        allowBurst: false,
        durationMs: 1_000,
        cadenceMs: 10_000,
        captureIntervalMs: 1_000,
      },
      { now: () => now },
    );
    expect(grant.isActive()).toBe(true);
    now = 1_000;
    expect(grant.isActive()).toBe(false);
    grant.revoke();
    expect(grant.getSnapshot().revoked).toBe(true);
  });

  it('enforces target, channel, cap and enhanced/burst flags at the final command gate', async () => {
    const grant = new VideoControlGrant({
      targetKind: 'opossum',
      channel: 'A',
      intensityCap: 30,
      allowEnhanced: false,
      allowBurst: false,
      durationMs: 60_000,
      cadenceMs: 10_000,
      captureIntervalMs: 1_000,
    });
    const limits = { intensityCap: 50, maxBurstDurationMs: 5_000 };

    await expect(
      grant.allowsCommand(
        gate('opossum', { type: 'vibrateStart', channel: 'A', intensity: 30 }),
        () => 0,
        limits,
      ),
    ).resolves.toBe(true);
    await expect(
      grant.allowsCommand(
        gate('opossum', { type: 'vibrateStart', channel: 'A', intensity: 20 }),
        () => 10,
        limits,
      ),
    ).resolves.toBe(false);
    await expect(
      grant.allowsCommand(
        gate('opossum', { type: 'vibrateAdjust', channel: 'A', delta: 1 }),
        () => 10,
        limits,
      ),
    ).resolves.toBe(false);
    await expect(
      grant.allowsCommand(
        gate('opossum', { type: 'vibrateStart', channel: 'B', intensity: 10 }),
        () => 0,
        limits,
      ),
    ).resolves.toBe(false);
    await expect(
      grant.allowsCommand(
        gate('coyote', {
          type: 'start',
          channel: 'A',
          strength: 10,
          waveform: { id: 'constant', name: 'Constant', frames: [[10, 10]] },
          loop: true,
        }),
        () => 0,
        limits,
      ),
    ).resolves.toBe(false);
    await expect(
      grant.allowsCommand(
        gate('opossum', {
          type: 'vibrateBurst',
          channel: 'A',
          intensity: 20,
          durationMs: 500,
        }),
        () => 10,
        limits,
      ),
    ).resolves.toBe(false);
  });
});
