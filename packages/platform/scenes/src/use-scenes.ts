import { useCallback, useSyncExternalStore } from 'react';
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

function snapshot(): SceneLibrary {
  const lib = loadScenes();
  const json = JSON.stringify(lib);
  if (json !== cachedJson || !cachedLib) {
    cachedJson = json;
    cachedLib = lib;
  }
  return cachedLib;
}

const SERVER_SNAPSHOT: SceneLibrary = { scenes: [], selectedId: 'gentle', hiddenBuiltinIds: [] };

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
