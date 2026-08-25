import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { genericDeviceIntensityCap, genericDeviceSafetyPolicy } from './device-policy.js';

describe('generic device safety policy', () => {
  it('uses the lower A/B cap for a capability without channel identity', () => {
    const settings = { ...DEFAULT_DEVICE_SAFETY, maxIntensityA: 80, maxIntensityB: 30 };

    expect(genericDeviceIntensityCap(settings)).toBe(0.15);
    expect(genericDeviceSafetyPolicy(settings).intensityCap).toBe(0.15);
  });

  it('normalizes every output-increasing bound and clamps unsafe values', () => {
    expect(
      genericDeviceSafetyPolicy({
        ...DEFAULT_DEVICE_SAFETY,
        maxIntensityA: Number.POSITIVE_INFINITY,
        maxIntensityB: 900,
        maxOpossumAdjustStep: 300,
        maxColdStartIntensity: -10,
        maxBurstDurationMs: 9_999.8,
      }),
    ).toEqual({
      intensityCap: 0,
      maxIncrease: 1,
      coldStartCap: 0,
      maxOutputLeaseMs: 5_000,
    });
  });
});
