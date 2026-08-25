import type { DeviceSafetySettings } from '@0xnullai/settings';
import type { DeviceSafetyPolicy } from './contracts.js';

/**
 * Convert the shared DG-Lab percentage-like settings to the normalized generic-device scale.
 *
 * Generic capabilities have no A/B identity, so every bound uses the lower configured channel cap.
 * Keep this conversion at the final runtime boundary so Web, Android, human controls, and AI grants
 * cannot drift by reimplementing the arithmetic in each surface.
 */
export function genericDeviceIntensityCap(settings: DeviceSafetySettings): number {
  return Math.min(
    normalizedSetting(settings.maxIntensityA),
    normalizedSetting(settings.maxIntensityB),
  );
}

export function genericDeviceSafetyPolicy(settings: DeviceSafetySettings): DeviceSafetyPolicy {
  return {
    intensityCap: genericDeviceIntensityCap(settings),
    maxIncrease: normalizedSetting(settings.maxOpossumAdjustStep),
    coldStartCap: normalizedSetting(settings.maxColdStartIntensity),
    maxOutputLeaseMs: Math.max(1, Math.min(5_000, Math.floor(settings.maxBurstDurationMs))),
  };
}

function normalizedSetting(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value) / 200);
}
