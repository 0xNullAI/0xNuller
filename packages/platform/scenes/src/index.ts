/**
 * Scene library shared across modules.
 *
 * A "scene" is the same thing in Agent and Voice — the `SavedPromptPreset`
 * type was byte-identical in both (Voice's PresetSelector was ported from
 * Agent). Only persistence differed: one lived inside the big
 * `dg-agent.browser-settings` JSON, the other inside `dg-voice-settings`.
 * A persona written in Agent was invisible in Voice.
 *
 * There is a second, more important reason to extract it: Agent's settings
 * blob had "one failed zod check → whole blob falls back to defaults"
 * semantics. Scenes shared that blob with `maxStrengthA/B` and
 * `permissionMode`, so one corrupt custom scene would silently reset the
 * user's strength caps. Here each scene parses independently; a bad one is
 * dropped, the rest survive.
 *
 * Built-in personas do NOT live here. Agent and Voice own their respective
 * built-in lists and copy; only "which one the user picked" and the scenes
 * the user wrote are shared. A module therefore validates a shared selected
 * id against the built-ins it actually supports.
 */

export interface SavedScene {
  id: string;
  name: string;
  icon?: string;
  prompt: string;
}
import {
  pullContent,
  pullContentPreferences,
  pushContent,
  pushContentPreferences,
} from '@0xnullai/sync';
import type { MarketItem, MarketScenarioContent } from '@0xnullai/market-client';

export interface SceneLibrary {
  /** Scenes the user wrote. */
  scenes: SavedScene[];
  /** Currently selected scene id (may point at a built-in persona). */
  selectedId: string;
  /** Built-in persona ids the user has hidden. */
  hiddenBuiltinIds: string[];
}

const KEY = '0xnullai.scenes';
/** Per-module keys from before the merge, migrated once on read. */
const LEGACY = [
  {
    key: 'dg-agent.browser-settings',
    scenes: 'savedPromptPresets',
    selected: 'promptPresetId',
    hidden: 'hiddenBuiltinPresetIds',
  },
  {
    key: 'dg-voice-settings',
    scenes: 'savedPromptPresets',
    selected: 'promptPresetId',
    hidden: 'hiddenBuiltinPresetIds',
  },
] as const;

const DEFAULT_SELECTED = 'gentle';
const listeners = new Set<(lib: SceneLibrary) => void>();
let syncPromise: Promise<void> | null = null;
let synced = false;

function emptyLibrary(): SceneLibrary {
  return { scenes: [], selectedId: DEFAULT_SELECTED, hiddenBuiltinIds: [] };
}

/**
 * Parse per item. A bad item drops only itself — this is exactly the
 * property the extraction from the big blob buys; whole-blob fallback means
 * the user unknowingly loses every custom scene.
 */
function coerceScenes(raw: unknown): SavedScene[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedScene[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.name !== 'string' || !o.name) continue;
    if (typeof o.prompt !== 'string') continue;
    out.push({
      id: o.id,
      name: o.name,
      prompt: o.prompt,
      ...(typeof o.icon === 'string' ? { icon: o.icon } : {}),
    });
  }
  return out;
}

function coerceStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

function readLegacy(): SceneLibrary | null {
  let merged: SceneLibrary | null = null;
  for (const src of LEGACY) {
    try {
      const blob = JSON.parse(localStorage.getItem(src.key) ?? 'null') as Record<
        string,
        unknown
      > | null;
      if (!blob) continue;
      const scenes = coerceScenes(blob[src.scenes]);
      const hidden = coerceStringArray(blob[src.hidden]);
      const selected =
        typeof blob[src.selected] === 'string' ? (blob[src.selected] as string) : null;
      if (!scenes.length && !hidden.length && !selected) continue;
      if (!merged) merged = emptyLibrary();
      // When both sides have custom scenes, merge instead of picking one —
      // whatever side the user wrote them on, they are the user's. Dedupe
      // by id, first writer wins (Agent is ordered first).
      for (const s of scenes) {
        if (!merged.scenes.some((existing) => existing.id === s.id)) merged.scenes.push(s);
      }
      for (const h of hidden)
        if (!merged.hiddenBuiltinIds.includes(h)) merged.hiddenBuiltinIds.push(h);
      if (selected && merged.selectedId === DEFAULT_SELECTED) merged.selectedId = selected;
    } catch {
      // A corrupt legacy blob must not block the other.
    }
  }
  return merged;
}

export function loadScenes(): SceneLibrary {
  if (typeof localStorage === 'undefined') return emptyLibrary();
  try {
    const own = localStorage.getItem(KEY);
    if (own) {
      const o = JSON.parse(own) as Record<string, unknown>;
      const result = {
        scenes: coerceScenes(o.scenes),
        selectedId:
          typeof o.selectedId === 'string' && o.selectedId ? o.selectedId : DEFAULT_SELECTED,
        hiddenBuiltinIds: coerceStringArray(o.hiddenBuiltinIds),
      };
      void syncScenes();
      return result;
    }
    const legacy = readLegacy();
    if (legacy) {
      saveScenes(legacy);
      return legacy;
    }
  } catch {
    // On corrupt storage fall back to an empty library instead of crashing
    // the module at startup.
  }
  return emptyLibrary();
}

export function saveScenes(lib: SceneLibrary): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lib));
  } catch {
    // Private browsing / quota exceeded: a failed write must not block use.
  }
  for (const l of listeners) l(lib);
  void pushContent(
    lib.scenes.map((scene, order) => ({
      id: scene.id,
      kind: 'scene' as const,
      name: scene.name,
      payload: { prompt: scene.prompt, ...(scene.icon ? { icon: scene.icon } : {}) },
      order,
    })),
  );
  void pushContentPreferences('scene', {
    selectedId: lib.selectedId,
    hiddenBuiltinIds: lib.hiddenBuiltinIds,
  });
}

/** Merge account-owned custom scenes into the local library; built-ins stay code-owned. */
export function syncScenes(): Promise<void> {
  if (synced) return Promise.resolve();
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const [remote, preferences] = await Promise.all([
      pullContent('scene'),
      pullContentPreferences('scene'),
    ]);
    if (!remote) return;
    synced = true;
    const local = loadScenesWithoutSync();
    const byId = new Map(local.scenes.map((scene) => [scene.id, scene]));
    for (const item of remote) {
      if (item.deleted) byId.delete(item.id);
      else if (item.payload && typeof item.payload === 'object') {
        const payload = item.payload as Record<string, unknown>;
        if (typeof payload.prompt === 'string')
          byId.set(item.id, {
            id: item.id,
            name: item.name,
            prompt: payload.prompt,
            ...(typeof payload.icon === 'string' ? { icon: payload.icon } : {}),
          });
      }
    }
    const merged = {
      ...local,
      scenes: [...byId.values()],
      selectedId: preferences?.selectedId ?? local.selectedId,
      hiddenBuiltinIds: [
        ...new Set([...local.hiddenBuiltinIds, ...(preferences?.hiddenBuiltinIds ?? [])]),
      ],
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(merged));
    } catch {
      /* local-first */
    }
    const remoteIds = new Set(remote.map((item) => item.id));
    await pushContent(
      merged.scenes
        .filter((s) => !remoteIds.has(s.id))
        .map((s, order) => ({
          id: s.id,
          kind: 'scene' as const,
          name: s.name,
          payload: { prompt: s.prompt, ...(s.icon ? { icon: s.icon } : {}) },
          order,
        })),
    );
    for (const l of listeners) l(merged);
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

if (typeof window !== 'undefined')
  window.addEventListener('0xnullai:auth-changed', () => {
    synced = false;
    void syncScenes();
  });

function loadScenesWithoutSync(): SceneLibrary {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null;
    if (raw)
      return {
        scenes: coerceScenes(raw.scenes),
        selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : DEFAULT_SELECTED,
        hiddenBuiltinIds: coerceStringArray(raw.hiddenBuiltinIds),
      };
  } catch {
    /* fall through */
  }
  return emptyLibrary();
}

/** Add or select one Market scenario without duplicating a previous import. */
export function withImportedMarketScene(current: SceneLibrary, item: MarketItem): SceneLibrary {
  const id = `market-${item.id}`;
  const existing = current.scenes.some((scene) => scene.id === id);
  if (existing) return { ...current, selectedId: id };

  const prompt = (item.content as MarketScenarioContent).prompt;
  return {
    ...current,
    selectedId: id,
    scenes: [...current.scenes, { id, name: item.name, icon: item.icon || '📝', prompt }],
  };
}

export function updateScenes(updater: (prev: SceneLibrary) => SceneLibrary): SceneLibrary {
  const prev = loadScenes();
  const next = updater(prev);
  saveScenes(next);
  const nextIds = new Set(next.scenes.map((scene) => scene.id));
  void pushContent(
    prev.scenes
      .filter((scene) => !nextIds.has(scene.id))
      .map((scene) => ({
        id: scene.id,
        kind: 'scene' as const,
        name: scene.name,
        payload: null,
        deleted: true,
      })),
  );
  return next;
}

/** Subscribe to changes. Same-document via listeners, cross-tab via the storage event. */
export function subscribeScenes(listener: (lib: SceneLibrary) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener(loadScenes());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Id for a newly created scene.
 *
 * Pre-merge this was `custom-${Date.now()}`. When merging two libraries,
 * scenes created in the same millisecond collide — and lookup is `find()`,
 * so a collision is silent shadowing: the user sees a scene that "does
 * nothing when clicked".
 */
export function newSceneId(): string {
  return crypto.randomUUID();
}
