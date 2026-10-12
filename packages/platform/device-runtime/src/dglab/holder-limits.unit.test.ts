import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type DeviceState } from '@dg-kit/core';
import { createEmptyOpossumState, type OpossumState } from '@dg-kit/protocol';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import {
  applyDeviceOwnLimits,
  clampBurstDurationMs,
  clampCoyoteCommandToHolderLimits,
  clampOpossumCommandToHolderLimits,
  holderChannelLimits,
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

describe('per-device holder limits', () => {
  it('lowers only the matching kind and never raises a global cap', () => {
    const own = { a: 20, b: 120 };
    expect(applyDeviceOwnLimits(limits, 'coyote', own)).toMatchObject({
      maxStrengthA: 20,
      maxStrengthB: 50,
      maxIntensityA: 50,
    });
    expect(applyDeviceOwnLimits(limits, 'opossum', own)).toMatchObject({
      maxIntensityA: 20,
      maxIntensityB: 50,
      maxStrengthA: 50,
    });
    expect(applyDeviceOwnLimits(limits, 'paw-prints', own)).toBe(limits);
    expect(applyDeviceOwnLimits(limits, 'coyote', null)).toBe(limits);
  });

  it('reports normalized channel caps', () => {
    expect(
      holderChannelLimits({ ...limits, maxStrengthA: 12.4, maxStrengthB: 999 }, 'coyote'),
    ).toEqual({ a: 12, b: 200 });
    expect(holderChannelLimits({ ...limits, maxIntensityA: 7 }, 'opossum')).toEqual({
      a: 7,
      b: 50,
    });
  });

  it('refuses a waveform or burst that would keep output above a lowered cap', () => {
    const over = coyote({ strengthA: 80 });
    const changeWave = (channel: 'A' | 'B') =>
      clampCoyoteCommandToHolderLimits(
        { type: 'changeWave', channel, waveform: wave, loop: true },
        over,
        limits,
      );
    expect(changeWave('A').ok).toBe(false);
    expect(changeWave('B').ok).toBe(true);
    expect(
      clampCoyoteCommandToHolderLimits(
        { type: 'burst', channel: 'A', strength: 10, durationMs: 100 },
        over,
        limits,
      ).ok,
    ).toBe(false);
    // Lowering output stays possible.
    expect(
      clampCoyoteCommandToHolderLimits(
        { type: 'adjustStrength', channel: 'A', delta: 3 },
        over,
        limits,
      ),
    ).toMatchObject({ ok: true, command: { delta: -30 } });
    expect(clampCoyoteCommandToHolderLimits({ type: 'stop', channel: 'A' }, over, limits).ok).toBe(
      true,
    );
    const loud = opossum({ intensityA: 90 });
    expect(
      clampOpossumCommandToHolderLimits(
        { type: 'vibrateSetPattern', channel: 'A', pattern: 'pulse' },
        loud,
        limits,
      ).ok,
    ).toBe(false);
    expect(clampOpossumCommandToHolderLimits({ type: 'vibrateStop' }, loud, limits).ok).toBe(true);
  });
});
