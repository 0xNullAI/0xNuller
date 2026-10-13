import { fetchPublicMarketPortrait } from '@0xnullai/market-client';
import { useCallback, useSyncExternalStore, useEffect, useState } from 'react';
import { loadScenes, subscribeScenes, updateScenes } from './index';
import type { SceneLibrary } from './index';

/**
 * Subscribe to the shared scene library.
 *
 * The snapshot must be referentially stable, or useSyncExternalStore sees a
 * new value on every compare and re-renders forever. We cache the JSON
 * serialization for comparison and only swap the object when content truly
 * changed — the library is tiny (a handful of hand-written personas), so
 * serializing costs far less than one spurious re-render.
 */

let cachedJson: string | null = null;
let cachedLib: SceneLibrary | null = null;
let cachedSource: SceneLibrary | null = null;

function snapshot(): SceneLibrary {
  const lib = loadScenes();
  // The store hands back the same object until the stored text changes.
  if (lib === cachedSource && cachedLib) return cachedLib;
  cachedSource = lib;
  const json = JSON.stringify(lib);
  if (json !== cachedJson || !cachedLib) {
    cachedJson = json;
    cachedLib = lib;
  }
  return cachedLib;
}

const SERVER_SNAPSHOT: SceneLibrary = { scenes: [], selectedId: '', hiddenBuiltinIds: [] };

export function useScenes(): [
  SceneLibrary,
  (updater: (prev: SceneLibrary) => SceneLibrary) => void,
] {
  const lib = useSyncExternalStore(subscribeScenes, snapshot, () => SERVER_SNAPSHOT);
  const update = useCallback((updater: (prev: SceneLibrary) => SceneLibrary) => {
    updateScenes(updater);
  }, []);
  return [lib, update];
}

/** Public default only. Bytes stay in memory, never enter private photos or content sync. */
export function usePublicMarketPortrait(portraitId: string | null | undefined): string | null {
  const [loaded, setLoaded] = useState<{ id: string; url: string; signal: AbortSignal } | null>(
    null,
  );
  useEffect(() => {
    if (!portraitId) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let image: HTMLImageElement | undefined;
    let active = true;
    const release = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = undefined;
      }
    };
    void fetchPublicMarketPortrait(portraitId, controller.signal)
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        image = new Image();
        image.onload = () => {
          if (active && objectUrl)
            setLoaded({ id: portraitId, url: objectUrl, signal: controller.signal });
        };
        image.onerror = () => {
          release();
          if (active) setLoaded(null);
        };
        image.src = objectUrl;
      })
      .catch(() => {
        if (active) setLoaded(null);
      });
    return () => {
      active = false;
      controller.abort();
      if (image) {
        image.onload = null;
        image.onerror = null;
      }
      release();
    };
  }, [portraitId]);
  return loaded && loaded.id === portraitId && !loaded.signal.aborted ? loaded.url : null;
}
