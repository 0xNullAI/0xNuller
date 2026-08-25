// Clamp rules converge in practice because each pass narrows the command. Four
// passes cover burst cap -> user cap -> step adjustment -> permission gate,
// while the bound protects the runtime from a custom rule that keeps clamping.
export const POLICY_RESOLVE_MAX_ITERATIONS = 4;

export const POLICY_NOT_CONVERGED_REASON = '策略评估未收敛（clamp 规则未稳定），本次调用被拒绝。';

export type PolicyLoopDecision<TCommand> =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'clamp'; command: TCommand; reason: string }
  | { type: 'require-confirm'; reason: string };

export interface PolicyResolution<TCommand> {
  command: TCommand;
  clampedFrom?: { command: TCommand; reason: string };
  clampReasons: string[];
  denyReason?: string;
  needsConfirm: boolean;
  confirmReason: string;
  exhausted: boolean;
}

/**
 * Applies clamp decisions until a terminal policy decision is reached. Keeping
 * this loop pure makes both Coyote and Opossum dispatch share the exact same
 * convergence and fail-closed behavior.
 */
export function resolvePolicyDecision<TCommand>(
  initialCommand: TCommand,
  maxIterations: number,
  evaluate: (command: TCommand) => PolicyLoopDecision<TCommand>,
): PolicyResolution<TCommand> {
  let command = initialCommand;
  const clampReasons: string[] = [];
  let needsConfirm = false;
  let confirmReason = '';
  let denyReason: string | undefined;
  let exhausted = true;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const decision = evaluate(command);

    if (decision.type === 'allow') {
      exhausted = false;
      break;
    }
    if (decision.type === 'deny') {
      denyReason = decision.reason;
      exhausted = false;
      break;
    }
    if (decision.type === 'require-confirm') {
      needsConfirm = true;
      confirmReason = decision.reason;
      exhausted = false;
      break;
    }
    clampReasons.push(decision.reason);
    command = decision.command;
  }

  if (exhausted) denyReason = POLICY_NOT_CONVERGED_REASON;

  const clampedFrom =
    clampReasons.length > 0
      ? { command: initialCommand, reason: clampReasons.join('; ') }
      : undefined;

  return { command, clampedFrom, clampReasons, denyReason, needsConfirm, confirmReason, exhausted };
}
