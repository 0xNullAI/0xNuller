import type { DeviceSafetySettings } from '@0xnullai/settings';
import type { DeviceSnapshot, FeatureId } from './contracts.js';
import { genericDeviceIntensityCap } from './device-policy.js';

export type UnifiedOutputKind = 'coyote' | 'opossum' | 'embedded';
export type UnifiedOutputModality = 'electrostimulation' | 'vibration';

interface UnifiedOutputTargetBase {
  /** Stable across snapshots for as long as the physical/runtime identity remains valid. */
  id: string;
  kind: UnifiedOutputKind;
  label: string;
  modality: UnifiedOutputModality;
  battery: number | null;
  active: boolean;
}

export interface UnifiedDgLabOutputTarget extends UnifiedOutputTargetBase {
  kind: 'coyote' | 'opossum';
  targetId: string;
}

export interface UnifiedEmbeddedOutputTarget extends UnifiedOutputTargetBase {
  kind: 'embedded';
  deviceId: DeviceSnapshot['devices'][number]['deviceId'];
  featureId: FeatureId;
}

export type UnifiedOutputTarget = UnifiedDgLabOutputTarget | UnifiedEmbeddedOutputTarget;

export interface DgLabOutputCandidate {
  kind: 'coyote' | 'opossum';
  targetId: string;
  name: string;
  battery?: number | null;
  active?: boolean;
}

export interface OutputTargetSafetyControl {
  max: number;
  step: number;
  normalized: boolean;
}

function identityPart(value: string): string {
  return encodeURIComponent(value);
}

export function unifiedOutputIdentity(kind: 'coyote' | 'opossum', targetId: string): string;
export function unifiedOutputIdentity(
  kind: 'embedded',
  deviceId: string,
  featureId: string,
): string;
export function unifiedOutputIdentity(
  kind: UnifiedOutputKind,
  firstId: string,
  secondId?: string,
): string {
  return kind === 'embedded'
    ? `embedded/${identityPart(firstId)}/${identityPart(secondId ?? '')}`
    : `${kind}/${identityPart(firstId)}`;
}

/**
 * Project legacy DG-Lab targets and generic runtime vibration capabilities into
 * one selection model. The target keeps enough opaque identity to authorize
 * exactly one physical output without teaching the UI about either runtime.
 */
export function createUnifiedOutputTargets(
  dgLabTargets: readonly DgLabOutputCandidate[],
  embeddedSnapshot: DeviceSnapshot | null,
): UnifiedOutputTarget[] {
  const targets: UnifiedOutputTarget[] = dgLabTargets.map((target) => ({
    id: unifiedOutputIdentity(target.kind, target.targetId),
    kind: target.kind,
    targetId: target.targetId,
    label: `${target.kind === 'coyote' ? '郊狼' : '负鼠'} · ${target.name}`,
    modality: target.kind === 'coyote' ? 'electrostimulation' : 'vibration',
    battery: target.battery ?? null,
    active: target.active ?? false,
  }));

  for (const device of embeddedSnapshot?.devices ?? []) {
    const battery = device.capabilities.find((feature) => feature.kind === 'battery');
    const vibrationFeatures = device.capabilities.filter(
      (feature): feature is Extract<typeof feature, { kind: 'vibrate' }> =>
        feature.kind === 'vibrate',
    );
    vibrationFeatures.forEach((feature, index) => {
      targets.push({
        id: unifiedOutputIdentity('embedded', device.deviceId, feature.featureId),
        kind: 'embedded',
        deviceId: device.deviceId,
        featureId: feature.featureId,
        label: `通用设备 · ${device.name} · 振动 ${index + 1}`,
        modality: 'vibration',
        battery:
          battery?.kind === 'battery' && battery.value !== null
            ? Math.round(battery.value * 100)
            : null,
        active: false,
      });
    });
  }
  return targets;
}

/** Keep the current identity when possible, otherwise select the first live output. */
export function resolveUnifiedOutputTarget(
  targets: readonly UnifiedOutputTarget[],
  selectedId: string | null,
): UnifiedOutputTarget | null {
  return targets.find((target) => target.id === selectedId) ?? targets[0] ?? null;
}

/** Shared settings are the sole cap source; generic runtimes use normalized 0..1 intensity. */
export function outputTargetSafetyControl(
  target: UnifiedOutputTarget | null,
  channel: 'A' | 'B',
  safety: Pick<
    DeviceSafetySettings,
    'maxStrengthA' | 'maxStrengthB' | 'maxIntensityA' | 'maxIntensityB'
  >,
): OutputTargetSafetyControl {
  if (target?.kind === 'coyote') {
    return {
      max: channel === 'A' ? safety.maxStrengthA : safety.maxStrengthB,
      step: 1,
      normalized: false,
    };
  }
  if (target?.kind === 'embedded') {
    return {
      max: genericDeviceIntensityCap(safety),
      step: 0.01,
      normalized: true,
    };
  }
  return {
    max: channel === 'A' ? safety.maxIntensityA : safety.maxIntensityB,
    step: 1,
    normalized: false,
  };
}
