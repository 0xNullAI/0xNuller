import { useEffect, useState } from 'react';

/**
 * Tracks the connection state of an "auxiliary" device client (opossum,
 * paw-prints, civet-edging) for the Devices settings tab. These three
 * clients don't flow through `AgentRuntime`'s `device-state-changed` event
 * (that event is Coyote-only — see `agent-runtime.ts`'s constructor) since
 * they're constructed and owned one layer up, in `@dg-agent/agent-browser`.
 * The UI reads their state directly via `getState()` + `onStateChanged()`
 * instead, mirroring how `ChatPanel` reads Coyote's `liveDeviceState` but
 * sourced locally rather than through the runtime event bus.
 */
export function useAuxDeviceState<TState extends { connected: boolean }>(
  client: {
    getState(): Promise<TState>;
    onStateChanged(listener: (state: TState) => void): () => void;
  },
  emptyState: TState,
): TState {
  const [state, setState] = useState<TState>(emptyState);

  useEffect(() => {
    let cancelled = false;
    void client.getState().then((next) => {
      if (!cancelled) setState(next);
    });
    const unsubscribe = client.onStateChanged((next) => {
      // Disconnected clients report a fresh empty object on every Coyote tick.
      if (!cancelled) setState((current) => (sameShallow(current, next) ? current : next));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return state;
}

function sameShallow<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  return true;
}
