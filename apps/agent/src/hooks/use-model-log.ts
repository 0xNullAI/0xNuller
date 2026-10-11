import { useCallback, useEffect, useRef, useState } from 'react';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import type { RuntimeEvent } from '@dg-agent/core';
import { appendModelLogEvent, type ModelLogTurn } from '../services/model-log-store.js';

export interface UseModelLogResult {
  turns: ModelLogTurn[];
  ingest: (event: RuntimeEvent) => void;
  clear: () => void;
}
/** Raw model payloads are visible only in this mounted page, never restored or persisted. */
export function useModelLog(enabled: boolean): UseModelLogResult {
  const [turns, setTurns] = useState<ModelLogTurn[]>([]);
  const accountRef = useRef(currentAuthUserId());
  useEffect(
    () =>
      subscribeAuthChanges(() => {
        const next = currentAuthUserId();
        if (next !== accountRef.current) {
          accountRef.current = next;
          setTurns([]);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!enabled) setTurns([]);
  }, [enabled]);
  const ingest = useCallback(
    (event: RuntimeEvent) => {
      if (enabled) setTurns((current) => appendModelLogEvent(current, event));
    },
    [enabled],
  );
  const clear = useCallback(() => setTurns([]), []);
  return { turns, ingest, clear };
}
