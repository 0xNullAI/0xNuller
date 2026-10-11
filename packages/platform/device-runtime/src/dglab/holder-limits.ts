import type { DeviceCommand, DeviceState, OpossumCommand } from '@dg-kit/core';
import type { OpossumState } from '@dg-kit/protocol';
import {
  createDefaultOpossumPolicyRules,
  createDefaultPolicyRules,
  type ActionContext,
  type OpossumPolicyRule,
  type PolicyRule,
} from '@dg-kit/safety';
import type { DeviceSafetySettings } from '@0xnullai/settings';

/**
 * The caps the device holder applies to every write, whatever module sent it.
 *
 * Shaped as a slice of the shared settings so the host can pass `loadDeviceSafety()` unchanged.
 */
export type HolderSafetyLimits = Pick<
  DeviceSafetySettings,
  | 'maxStrengthA'
  | 'maxStrengthB'
  | 'maxColdStartStrength'
  | 'maxAdjustStep'
  | 'maxBurstDurationMs'
  | 'maxBurstStrengthAbsolute'
  | 'maxBurstStrengthRelative'
  | 'maxIntensityA'
  | 'maxIntensityB'
  | 'maxColdStartIntensity'
  | 'maxOpossumAdjustStep'
>;

export type HolderLimitResult<TCommand> =
  | { ok: true; command: TCommand; clamped: boolean; reasons: string[] }
  | { ok: false; reason: string };

/**
 * Only the absolute ceilings are re-applied here: strength/intensity caps, the burst-specific
 * caps and burst duration. Cold-start and step pacing stay in each module's own policy chain —
 * a human slider legitimately jumps from 0 to the cap, and re-pacing it here would turn one
 * drag into a sequence of +10 writes. Stateful policies (per-turn counters, lifecycle guards)
 * also stay where they are; this is a re-clamp, not a second safety chain.
 */
const COYOTE_HOLDER_RULES = [
  'require-device-connection',
  'user-strength-cap',
  'burst-strength-cap',
  'burst-duration',
] as const;
const OPOSSUM_HOLDER_RULES = ['require-opossum-connection', 'opossum-user-intensity-cap'] as const;

const HOLDER_CONTEXT: ActionContext = {
  sessionId: 'dglab-holder',
  sourceType: 'system',
  traceId: 'dglab-holder-limits',
};

/** Re-clamp one Coyote command against the latest device state and the shared caps. */
export function clampCoyoteCommandToHolderLimits(
  command: DeviceCommand,
  deviceState: DeviceState,
  limits: HolderSafetyLimits,
): HolderLimitResult<DeviceCommand> {
  // Stops only lower output; nothing may block or rewrite them.
  if (command.type === 'stop' || command.type === 'emergencyStop') {
    return { ok: true, command, clamped: false, reasons: [] };
  }
  const rules = pickRules(
    createDefaultPolicyRules(coyotePolicyOptions(limits)),
    COYOTE_HOLDER_RULES,
  );
  let current: DeviceCommand = command;
  const reasons: string[] = [];
  for (const rule of rules) {
    const decision = rule.evaluate({ context: HOLDER_CONTEXT, command: current, deviceState });
    if (!decision) continue;
    if (decision.type === 'deny') return { ok: false, reason: decision.reason };
    if (decision.type === 'clamp') {
      current = decision.command;
      reasons.push(decision.reason);
    }
  }
  return { ok: true, command: current, clamped: reasons.length > 0, reasons };
}

/** Re-clamp one Opossum command against the latest device state and the shared caps. */
export function clampOpossumCommandToHolderLimits(
  command: OpossumCommand,
  deviceState: OpossumState,
  limits: HolderSafetyLimits,
): HolderLimitResult<OpossumCommand> {
  if (command.type === 'vibrateStop') return { ok: true, command, clamped: false, reasons: [] };
  const rules = pickRules(
    createDefaultOpossumPolicyRules(opossumPolicyOptions(limits)),
    OPOSSUM_HOLDER_RULES,
  );
  let current: OpossumCommand = command;
  const reasons: string[] = [];
  for (const rule of rules) {
    const decision = rule.evaluate({ context: HOLDER_CONTEXT, command: current, deviceState });
    if (!decision) continue;
    if (decision.type === 'deny') return { ok: false, reason: decision.reason };
    if (decision.type === 'clamp') {
      current = decision.command;
      reasons.push(decision.reason);
    }
  }
  if (current.type === 'vibrateBurst') {
    const durationMs = clampBurstDurationMs(current.durationMs, limits);
    if (durationMs !== current.durationMs) {
      current = { ...current, durationMs };
      reasons.push(`Burst 时长上限为 ${durationMs}ms`);
    }
  }
  return { ok: true, command: current, clamped: reasons.length > 0, reasons };
}

/**
 * Burst duration through the kit's own Coyote `burst-duration` rule.
 *
 * The Opossum rule set has no duration rule; evaluating the Coyote one on an equivalent burst
 * keeps the normalization (100 ms floor, 20 s ceiling) in exactly one place.
 */
export function clampBurstDurationMs(durationMs: number, limits: HolderSafetyLimits): number {
  const [rule] = pickRules(createDefaultPolicyRules(coyotePolicyOptions(limits)), [
    'burst-duration',
  ]);
  const decision = rule!.evaluate({
    context: HOLDER_CONTEXT,
    command: { type: 'burst', channel: 'A', strength: 0, durationMs },
    deviceState: {
      connected: true,
      strengthA: 0,
      strengthB: 0,
      limitA: 0,
      limitB: 0,
      waveActiveA: false,
      waveActiveB: false,
    },
  });
  if (decision?.type === 'clamp' && decision.command.type === 'burst') {
    return decision.command.durationMs;
  }
  return Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
}

function coyotePolicyOptions(limits: HolderSafetyLimits) {
  return {
    maxStrengthA: limits.maxStrengthA,
    maxStrengthB: limits.maxStrengthB,
    maxColdStartStrength: limits.maxColdStartStrength,
    maxAdjustStep: limits.maxAdjustStep,
    maxBurstDurationMs: limits.maxBurstDurationMs,
    maxBurstStrengthAbsolute: limits.maxBurstStrengthAbsolute,
    maxBurstStrengthRelative: limits.maxBurstStrengthRelative,
  };
}

function opossumPolicyOptions(limits: HolderSafetyLimits) {
  return {
    maxIntensityA: limits.maxIntensityA,
    maxIntensityB: limits.maxIntensityB,
    maxColdStartIntensity: limits.maxColdStartIntensity,
    maxAdjustStep: limits.maxOpossumAdjustStep,
  };
}

/**
 * Select kit rules by name and fail closed if one disappears: a renamed kit rule must break the
 * build's tests, not silently drop a cap from the holder side.
 */
function pickRules<TRule extends PolicyRule | OpossumPolicyRule>(
  rules: TRule[],
  names: readonly string[],
): TRule[] {
  return names.map((name) => {
    const rule = rules.find((candidate) => candidate.name === name);
    if (!rule) throw new Error(`@dg-kit/safety rule "${name}" is missing`);
    return rule;
  });
}
