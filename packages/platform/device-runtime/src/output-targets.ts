import type { DeviceSafetySettings } from '@0xnullai/settings';

export type UnifiedOutputKind = 'coyote' | 'opossum';
export type UnifiedOutputModality = 'electrostimulation' | 'vibration';

export interface UnifiedOutputTarget {
  /** Stable across snapshots for as long as the physical identity remains valid. */
  id: string;
  kind: UnifiedOutputKind;
  targetId: string;
  label: string;
  modality: UnifiedOutputModality;
  battery: number | null;
  active: boolean;
}

export interface DgLabOutputCandidate {
  kind: UnifiedOutputKind;
  targetId: string;
  name: string;
  battery?: number | null;
  active?: boolean;
}

export interface OutputTargetSafetyControl {
  max: number;
  step: number;
}

export function unifiedOutputIdentity(kind: UnifiedOutputKind, targetId: string): string {
  return `${kind}/${encodeURIComponent(targetId)}`;
}

/**
 * Project connected Coyote and Opossum targets into one selection model. Each target keeps its
 * opaque physical identity so one selection authorizes exactly one output, even when names match.
 */
export function createUnifiedOutputTargets(
  dgLabTargets: readonly DgLabOutputCandidate[],
): UnifiedOutputTarget[] {
  const labelTotals = new Map<string, number>();
  for (const target of dgLabTargets) {
    const key = `${target.kind}:${target.name}`;
    labelTotals.set(key, (labelTotals.get(key) ?? 0) + 1);
  }
  const labelSeen = new Map<string, number>();
  return dgLabTargets.map((target) => {
    const key = `${target.kind}:${target.name}`;
    const occurrence = (labelSeen.get(key) ?? 0) + 1;
    labelSeen.set(key, occurrence);
    const ordinal = (labelTotals.get(key) ?? 0) > 1 ? ` #${occurrence}` : '';
    return {
      id: unifiedOutputIdentity(target.kind, target.targetId),
      kind: target.kind,
      targetId: target.targetId,
      label: `${target.kind === 'coyote' ? '郊狼' : '负鼠'} · ${target.name}${ordinal}`,
      modality: target.kind === 'coyote' ? 'electrostimulation' : 'vibration',
      battery: target.battery ?? null,
      active: target.active ?? false,
    };
  });
}

/** Keep the current identity when possible, otherwise select the first live output. */
export function resolveUnifiedOutputTarget(
  targets: readonly UnifiedOutputTarget[],
  selectedId: string | null,
): UnifiedOutputTarget | null {
  return targets.find((target) => target.id === selectedId) ?? targets[0] ?? null;
}

/** Shared settings are the sole cap source: Coyote strength or Opossum intensity per channel. */
export function outputTargetSafetyControl(
  target: UnifiedOutputTarget | null,
  channel: 'A' | 'B',
  safety: Pick<
    DeviceSafetySettings,
    'maxStrengthA' | 'maxStrengthB' | 'maxIntensityA' | 'maxIntensityB'
  >,
): OutputTargetSafetyControl {
  if (target?.kind === 'coyote') {
    return { max: channel === 'A' ? safety.maxStrengthA : safety.maxStrengthB, step: 1 };
  }
  return { max: channel === 'A' ? safety.maxIntensityA : safety.maxIntensityB, step: 1 };
}
