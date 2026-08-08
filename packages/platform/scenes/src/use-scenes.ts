import { useCallback, useSyncExternalStore } from 'react';
import { loadScenes, subscribeScenes, updateScenes } from './index';
import type { SceneLibrary } from './index';

/**
 * 订阅共享场景库。
 *
 * 快照必须是稳定引用，否则 useSyncExternalStore 每次比较都不相等会无限重渲。
 * 这里缓存 JSON 序列化后的字符串做比较，只有内容真变了才换新对象——场景库很小
 * （用户手写的几条人设），序列化成本远低于一次错误的重渲。
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
