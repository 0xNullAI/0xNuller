/**
 * Rate-limit policy interface, injected into the tool registry by consumers.
 *
 * Different runtimes have different notions of "how often a tool can be
 * called": DG-Agent counts per-turn; DG-MCP doesn't have turns and prefers a
 * sliding time window. Both implement the same interface.
 */
export interface RateLimitPolicy {
  /** Called before resolving a tool call. Reject to deny. */
  shouldAllow(toolName: string): { allow: true } | { allow: false; reason: string };
  /** Called after a tool call has been admitted. */
  recordCall(toolName: string): void;
  /** Called when the runtime opens a new "turn" (DG-Agent). No-op for stateless runtimes. */
  resetTurn?(): void;
}

export function createNoOpRateLimitPolicy(): RateLimitPolicy {
  return {
    shouldAllow: () => ({ allow: true }),
    recordCall: () => undefined,
  };
}

export interface SlidingWindowOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Per-tool maximum call count within the window. Tools not listed are unrestricted. */
  caps: Record<string, number>;
  /** Optional clock override (testing). */
  now?: () => number;
}

export function createSlidingWindowRateLimitPolicy(options: SlidingWindowOptions): RateLimitPolicy {
  const now = options.now ?? (() => Date.now());
  const history = new Map<string, number[]>();

  function prune(toolName: string): number[] {
    const cutoff = now() - options.windowMs;
    const list = history.get(toolName) ?? [];
    const fresh = list.filter((t) => t >= cutoff);
    history.set(toolName, fresh);
    return fresh;
  }

  return {
    shouldAllow(toolName) {
      const cap = options.caps[toolName];
      if (cap === undefined || cap < 0) return { allow: true };
      const fresh = prune(toolName);
      if (fresh.length >= cap) {
        return {
          allow: false,
          reason: `工具 ${toolName} 在最近 ${Math.round(options.windowMs / 1000)} 秒内已被调用 ${fresh.length} 次（上限 ${cap}）`,
        };
      }
      return { allow: true };
    },
    recordCall(toolName) {
      const cap = options.caps[toolName];
      if (cap === undefined || cap < 0) return;
      const fresh = prune(toolName);
      fresh.push(now());
      history.set(toolName, fresh);
    },
  };
}

export interface PerTurnOptions {
  /** Per-tool maximum call count within a turn. Tools not listed are unrestricted. */
  caps: Record<string, number>;
}

export function createTurnRateLimitPolicy(options: PerTurnOptions): RateLimitPolicy {
  let counts = new Map<string, number>();

  return {
    shouldAllow(toolName) {
      const cap = options.caps[toolName];
      if (cap === undefined || cap < 0) return { allow: true };
      const used = counts.get(toolName) ?? 0;
      if (used >= cap) {
        return {
          allow: false,
          reason: `工具 ${toolName} 本回合已调用 ${used} 次（上限 ${cap}），请换一种方式继续`,
        };
      }
      return { allow: true };
    },
    recordCall(toolName) {
      const cap = options.caps[toolName];
      if (cap === undefined || cap < 0) return;
      counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
    },
    resetTurn() {
      counts = new Map();
    },
  };
}
