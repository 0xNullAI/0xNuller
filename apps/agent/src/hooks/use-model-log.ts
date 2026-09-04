import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeEvent } from '@dg-agent/core';
import { BrowserDiagnosticStore } from '@dg-agent/storage-browser';
import { reportPersistenceResult } from '@0xnullai/settings';
import {
  appendModelLogEvent,
  boundModelLogs,
  clearModelLogs,
  readLegacyModelLogs,
  type ModelLogTurn,
} from '../services/model-log-store.js';

export interface UseModelLogResult {
  turns: ModelLogTurn[];
  ingest: (event: RuntimeEvent) => void;
  clear: () => void;
}
const STATUS_KEY = 'model-logs';
export function useModelLog(enabled: boolean): UseModelLogResult {
  const [store] = useState(() => new BrowserDiagnosticStore<ModelLogTurn>());
  const [turns, setTurns] = useState<ModelLogTurn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const clearGeneration = useRef(0);
  useEffect(() => {
    if (!enabled || loaded) return;
    let cancelled = false;
    const generation = clearGeneration.current;
    void store
      .load()
      .then((saved) => {
        if (cancelled || generation !== clearGeneration.current) return;
        const legacy = saved.length ? [] : readLegacyModelLogs();
        setTurns((current) =>
          boundModelLogs(
            [...saved, ...legacy, ...current].sort((a, b) => a.startedAt - b.startedAt),
          ),
        );
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          reportPersistenceResult(STATUS_KEY, false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, loaded, store]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void store.save(turns).then(
        () => {
          clearModelLogs();
          reportPersistenceResult(STATUS_KEY, true);
        },
        () => reportPersistenceResult(STATUS_KEY, false),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [turns, loaded, store]);

  const ingest = useCallback(
    (event: RuntimeEvent) => {
      if (enabled) setTurns((current) => appendModelLogEvent(current, event));
    },
    [enabled],
  );
  const clear = useCallback(() => {
    clearGeneration.current++;
    clearModelLogs();
    setTurns([]);
    setLoaded(true);
    void store.save([]).then(
      () => reportPersistenceResult(STATUS_KEY, true),
      () => reportPersistenceResult(STATUS_KEY, false),
    );
  }, [store]);
  return { turns, ingest, clear };
}
