import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type DeviceState } from '@dg-kit/core';
import { createEmptyOpossumState, type OpossumState } from '@dg-kit/protocol';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import {
  clampBurstDurationMs,
  clampCoyoteCommandToHolderLimits,
  clampOpossumCommandToHolderLimits,
} from './holder-limits.js';

const limits = DEFAULT_DEVICE_SAFETY;
const coyote = (patch: Partial<DeviceState> = {}): DeviceState => ({
  ...createEmptyDeviceState(),
  connected: true,
  ...patch,
});
const opossum = (patch: Partial<OpossumState> = {}): OpossumState => ({
  ...createEmptyOpossumState(),
  connected: true,
  ...patch,
});
const wave = { id: 'w', name: 'w', frames: [[10, 50]] as [number, number][] };

describe('holder limits', () => {
  it('writes a raw 200 start as the user cap, without re-pacing a cold start', () => {
    const result = clampCoyoteCommandToHolderLimits(
      { type: 'start', channel: 'A', strength: 200, waveform: wave, loop: true },
      coyote(),
      limits,
    );
    expect(result).toMatchObject({ ok: true, clamped: true, command: { strength: 50 } });
  });

  it('uses the lower of the hardware limit and the user cap', () => {
    const result = clampCoyoteCommandToHolderLimits(
      { type: 'start', channel: 'B', strength: 45, waveform: wave, loop: true },
      coyote({ limitB: 30 }),
      limits,
    );
    expect(result).toMatchObject({ ok: true, command: { strength: 30 } });
  });

  it('clamps an adjust so the result stays under the cap', () => {
    const result = clampCoyoteCommandToHolderLimits(
      { type: 'adjustStrength', channel: 'A', delta: 40 },
      coyote({ strengthA: 45 }),
      limits,
    );
    expect(result).toMatchObject({ ok: true, command: { delta: 5 } });
  });

  it('clamps burst strength, burst-specific caps and burst duration', () => {
    const result = clampCoyoteCommandToHolderLimits(
      { type: 'burst', channel: 'A', strength: 180, durationMs: 60_000 },
      coyote({ strengthA: 10 }),
      { ...limits, maxBurstStrengthAbsolute: 30 },
    );
    expect(result).toMatchObject({ ok: true, command: { strength: 30, durationMs: 5_000 } });
  });

  it('denies output to a disconnected device but never blocks a stop', () => {
    const disconnected = { ...coyote(), connected: false };
    expect(
      clampCoyoteCommandToHolderLimits(
        { type: 'start', channel: 'A', strength: 5, waveform: wave, loop: true },
        disconnected,
        limits,
      ).ok,
    ).toBe(false);
    expect(clampCoyoteCommandToHolderLimits({ type: 'stop' }, disconnected, limits)).toEqual({
      ok: true,
      command: { type: 'stop' },
      clamped: false,
      reasons: [],
    });
  });

  it('caps Opossum intensity and burst duration', () => {
    expect(
      clampOpossumCommandToHolderLimits(
        { type: 'vibrateStart', channel: 'A', intensity: 200 },
        opossum(),
        limits,
      ),
    ).toMatchObject({ ok: true, command: { intensity: 50 } });
    expect(
      clampOpossumCommandToHolderLimits(
        { type: 'vibrateBurst', channel: 'B', intensity: 200, durationMs: 60_000 },
        opossum(),
        { ...limits, maxBurstDurationMs: 2_000 },
      ),
    ).toMatchObject({ ok: true, command: { intensity: 50, durationMs: 2_000 } });
  });

  it('normalizes burst duration through the kit rule', () => {
    expect(clampBurstDurationMs(60_000, { ...limits, maxBurstDurationMs: 99_000 })).toBe(20_000);
    expect(clampBurstDurationMs(800, limits)).toBe(800);
  });
});
