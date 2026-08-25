import type { BrowserPermissionMode } from '@0xnullai/permissions';
import {
  effectivePermissionMode,
  loadDeviceSafety,
  updateDeviceSafety,
  type DeviceSafetySettings,
} from './device-safety.js';

/** Coyote limits in the nested shape consumed by product device panels and runtimes. */
export interface CoyoteSafetySettings {
  maxStrengthA: number;
  maxStrengthB: number;
  maxColdStartStrength: number;
  maxAdjustStep: number;
  maxBurstDurationMs: number;
  maxBurstStrengthAbsolute: number;
  maxBurstStrengthRelative: number;
}

/** Opossum limits in the nested shape consumed by product device panels and runtimes. */
export interface OpossumSafetySettings {
  maxColdStartIntensity: number;
  maxAdjustStep: number;
  maxIntensityA: number;
  maxIntensityB: number;
}

/** Shared view adapter over the canonical flat device-safety record. */
export interface DeviceSafetySections {
  permissionMode: BrowserPermissionMode;
  coyoteSafety: CoyoteSafetySettings;
  opossumSafety: OpossumSafetySettings;
}

export function deviceSafetySections(settings: DeviceSafetySettings): DeviceSafetySections {
  return {
    permissionMode: effectivePermissionMode(settings),
    coyoteSafety: {
      maxStrengthA: settings.maxStrengthA,
      maxStrengthB: settings.maxStrengthB,
      maxColdStartStrength: settings.maxColdStartStrength,
      maxAdjustStep: settings.maxAdjustStep,
      maxBurstDurationMs: settings.maxBurstDurationMs,
      maxBurstStrengthAbsolute: settings.maxBurstStrengthAbsolute,
      maxBurstStrengthRelative: settings.maxBurstStrengthRelative,
    },
    opossumSafety: {
      maxColdStartIntensity: settings.maxColdStartIntensity,
      maxAdjustStep: settings.maxOpossumAdjustStep,
      maxIntensityA: settings.maxIntensityA,
      maxIntensityB: settings.maxIntensityB,
    },
  };
}

export function loadDeviceSafetySections(): DeviceSafetySections {
  return deviceSafetySections(loadDeviceSafety());
}

/**
 * Persist the shared nested contract without overwriting safety fields that are not represented
 * in the device panels (per-turn caps and lifecycle policy, for example).
 */
export function saveDeviceSafetySections(sections: DeviceSafetySections): DeviceSafetySections {
  const saved = updateDeviceSafety((previous) => ({
    ...previous,
    maxStrengthA: sections.coyoteSafety.maxStrengthA,
    maxStrengthB: sections.coyoteSafety.maxStrengthB,
    maxColdStartStrength: sections.coyoteSafety.maxColdStartStrength,
    maxAdjustStep: sections.coyoteSafety.maxAdjustStep,
    maxBurstDurationMs: sections.coyoteSafety.maxBurstDurationMs,
    maxBurstStrengthAbsolute: sections.coyoteSafety.maxBurstStrengthAbsolute,
    maxBurstStrengthRelative: sections.coyoteSafety.maxBurstStrengthRelative,
    maxColdStartIntensity: sections.opossumSafety.maxColdStartIntensity,
    maxOpossumAdjustStep: sections.opossumSafety.maxAdjustStep,
    maxIntensityA: sections.opossumSafety.maxIntensityA,
    maxIntensityB: sections.opossumSafety.maxIntensityB,
    permissionMode: sections.permissionMode,
  }));
  return deviceSafetySections(saved);
}
