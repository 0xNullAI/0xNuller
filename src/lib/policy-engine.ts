import type { DeviceCommand, DeviceState, OpossumCommand } from '@dg-kit/core';
import type { OpossumState } from '@dg-kit/protocol';
import type { ActionContext, OpossumPolicyDecision, PolicyDecision } from './types.js';

export interface EvaluatePolicyInput {
  context: ActionContext;
  command: DeviceCommand;
  deviceState: DeviceState;
}

export interface PolicyRule {
  name: string;
  evaluate(input: EvaluatePolicyInput): PolicyDecision | null;
}

export class PolicyEngine {
  private readonly rules: PolicyRule[];

  constructor(rules: PolicyRule[]) {
    this.rules = rules;
  }

  evaluate(input: EvaluatePolicyInput): PolicyDecision {
    for (const rule of this.rules) {
      const result = rule.evaluate(input);
      if (result) {
        return result;
      }
    }

    return { type: 'allow' };
  }
}

// ---------------------------------------------------------------------------
// Opossum (vibration controller) policy engine — a deliberately separate,
// parallel engine rather than a generic one. `OpossumCommand`/`OpossumState`
// are a different shape from `DeviceCommand`/`DeviceState` (see @dg-kit/core's
// OpossumCommand doc comment), so forcing a shared generic through
// `PolicyEngine`/`PolicyRule`/`PolicyDecision` would be a bigger, riskier
// change than duplicating ~20 lines of loop logic.
// ---------------------------------------------------------------------------

export interface EvaluateOpossumPolicyInput {
  context: ActionContext;
  command: OpossumCommand;
  deviceState: OpossumState;
}

export interface OpossumPolicyRule {
  name: string;
  evaluate(input: EvaluateOpossumPolicyInput): OpossumPolicyDecision | null;
}

export class OpossumPolicyEngine {
  constructor(private readonly rules: OpossumPolicyRule[]) {}

  evaluate(input: EvaluateOpossumPolicyInput): OpossumPolicyDecision {
    for (const rule of this.rules) {
      const result = rule.evaluate(input);
      if (result) {
        return result;
      }
    }

    return { type: 'allow' };
  }
}
