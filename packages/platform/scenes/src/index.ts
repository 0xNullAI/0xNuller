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
 * New cards come from Market. Previously saved local cards and hidden
 * built-in preferences remain readable for migration, but no built-in
 * persona is offered as a new chat entrypoint.
 */

import { parseMarketPortraitId } from '@0xnullai/market-client';
import { currentAuthUserId } from '@0xnullai/auth';
import { parseCharacterCard, type CharacterCard } from './character-card.js';
export { parseCharacterCard, type CharacterCard } from './character-card.js';

export interface SavedScene {
  id: string;
  name: string;
  icon?: string;
  prompt: string;
  /** Public-card semantics. Legacy entries without a kind retain their existing prompt. */
  kind?: 'character' | 'scene';
  characterCard?: CharacterCard;
  /** Last public Market revision explicitly imported by this account. */
  marketRevision?: number;
  /** Public default image reference, separate from private account photos. */
  marketPortraitId?: string;
}
import {
  pullContent,
  pullContentPreferences,
  pushContent,
  pushContentPreferences,
} from '@0xnullai/sync';

export interface SceneLibrary {
  /** Scenes the user wrote. */
  scenes: SavedScene[];
  /** Currently selected saved card ID. */
  selectedId: string;
  /** Built-in persona ids the user has hidden. */
  hiddenBuiltinIds: string[];
}

const LEGACY_KEY = '0xnullai.scenes';
const accountKey = (account = currentAuthUserId()) =>
  account ? `${LEGACY_KEY}:${encodeURIComponent(account)}` : null;
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

const DEFAULT_SELECTED = '';
// Mirrors Market's transport ceiling. Content sync accepts up to 512 KiB per
// entity, so a 100,000-character prompt remains below the worst-case UTF-8 cap.
const MAX_MARKET_SCENE_PROMPT_LENGTH = 100_000;
const listeners = new Set<(lib: SceneLibrary) => void>();
let syncPromise: Promise<void> | null = null;
let synced = false;
let syncGeneration = 0;
let observedAccount = currentAuthUserId();
let localRevision = 0;
let preferenceRevision = 0;
const sceneRevisions = new Map<string, number>();

function emptyLibrary(): SceneLibrary {
  return { scenes: [], selectedId: DEFAULT_SELECTED, hiddenBuiltinIds: [] };
}

function normalizeLibrary(lib: SceneLibrary): SceneLibrary {
  // An empty selection is intentional. Importing an environment with
  // `select: false` must not silently choose a card for the current chat.
  if (lib.selectedId === DEFAULT_SELECTED) return lib;
  const selectedId = lib.scenes.some((scene) => scene.id === lib.selectedId)
    ? lib.selectedId
    : (lib.scenes[0]?.id ?? DEFAULT_SELECTED);
  return selectedId === lib.selectedId ? lib : { ...lib, selectedId };
}

function characterMetadata(value: unknown): { characterCard?: CharacterCard } {
  const characterCard = parseCharacterCard(value);
  return characterCard ? { characterCard } : {};
}

function promptKindMetadata(value: unknown): { kind?: SavedScene['kind'] } {
  return value === 'character' || value === 'scene' ? { kind: value } : {};
}

/** Legacy structured cards are characters; old prompt-only entries remain scenes. */
export function savedPromptKind(
  scene: Pick<SavedScene, 'kind' | 'characterCard'>,
): 'character' | 'scene' {
  return scene.kind ?? (scene.characterCard ? 'character' : 'scene');
}

function marketRevisionMetadata(id: string, value: unknown): { marketRevision?: number } {
  return id.startsWith('market-') && Number.isSafeInteger(value) && (value as number) > 0
    ? { marketRevision: value as number }
    : {};
}

function marketPortraitMetadata(id: string, value: unknown): { marketPortraitId?: string } {
  const portrait = /^market-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
    ? parseMarketPortraitId(value)
    : null;
  return portrait ? { marketPortraitId: portrait } : {};
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
      ...promptKindMetadata(o.kind),
      ...(o.kind === 'scene' ? {} : characterMetadata(o.characterCard)),
      ...marketRevisionMetadata(o.id, o.marketRevision),
      ...marketPortraitMetadata(o.id, o.marketPortraitId),
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

function parseStoredLibrary(raw: string | null): SceneLibrary | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return normalizeLibrary({
      scenes: coerceScenes(o.scenes),
      selectedId: typeof o.selectedId === 'string' ? o.selectedId : DEFAULT_SELECTED,
      hiddenBuiltinIds: coerceStringArray(o.hiddenBuiltinIds),
    });
  } catch {
    return null;
  }
}

/** Shared legacy keys have no owner. Never upload them to whichever account logs in first. */
function legacyLibrary(): SceneLibrary | null {
  if (typeof localStorage === 'undefined') return null;
  let old: SceneLibrary | null = null;
  try {
    old = parseStoredLibrary(localStorage.getItem(LEGACY_KEY));
  } catch {
    /* private browsing */
  }
  const moduleLegacy = readLegacy();
  if (!old) return moduleLegacy;
  if (!moduleLegacy) return old;
  const ids = new Set(old.scenes.map((scene) => scene.id));
  return normalizeLibrary({
    scenes: [...old.scenes, ...moduleLegacy.scenes.filter((scene) => !ids.has(scene.id))],
    selectedId: old.selectedId || moduleLegacy.selectedId,
    hiddenBuiltinIds: [...new Set([...old.hiddenBuiltinIds, ...moduleLegacy.hiddenBuiltinIds])],
  });
}

export function legacyScenesToImportCount(): number {
  if (!accountKey()) return 0;
  const existing = new Set(loadScenesWithoutSync().scenes.map((scene) => scene.id));
  return legacyLibrary()?.scenes.filter((scene) => !existing.has(scene.id)).length ?? 0;
}

export function canImportLegacyScenes(): boolean {
  return Boolean(accountKey()) && synced;
}

/** Explicitly claim this browser's old ownerless cards for the current account. */
export function importLegacyScenes(): number {
  const account = currentAuthUserId();
  if (!account || !synced) return 0;
  const legacy = legacyLibrary();
  if (!legacy?.scenes.length || currentAuthUserId() !== account) return 0;
  let imported = 0;
  updateScenes((current) => {
    const ids = new Set(current.scenes.map((scene) => scene.id));
    const missing = legacy.scenes.filter((scene) => !ids.has(scene.id));
    imported = missing.length;
    if (!imported) return current;
    return {
      ...current,
      scenes: [...current.scenes, ...missing],
      selectedId: current.selectedId || legacy.selectedId,
      hiddenBuiltinIds: [...new Set([...current.hiddenBuiltinIds, ...legacy.hiddenBuiltinIds])],
    };
  });
  return imported;
}

export function loadScenes(): SceneLibrary {
  const result = loadScenesWithoutSync();
  if (accountKey()) void syncScenes();
  return result;
}

export function saveScenes(lib: SceneLibrary, skipRemotePush = false): void {
  const key = accountKey();
  if (!key) return;
  lib = normalizeLibrary(lib);
  const previous = loadScenesWithoutSync();
  const revision = ++localRevision;
  const previousById = new Map(previous.scenes.map((scene) => [scene.id, scene]));
  const nextById = new Map(lib.scenes.map((scene) => [scene.id, scene]));
  const changedIds = new Set<string>();
  for (const id of new Set([...previousById.keys(), ...nextById.keys()])) {
    if (JSON.stringify(previousById.get(id)) !== JSON.stringify(nextById.get(id))) {
      changedIds.add(id);
      sceneRevisions.set(id, revision);
    }
  }
  const preferencesChanged =
    previous.selectedId !== lib.selectedId ||
    JSON.stringify(previous.hiddenBuiltinIds) !== JSON.stringify(lib.hiddenBuiltinIds);
  if (preferencesChanged) preferenceRevision = revision;
  try {
    localStorage.setItem(key, JSON.stringify(lib));
  } catch {
    // Private browsing / quota exceeded: a failed write must not block use.
  }
  for (const l of listeners) l(lib);
  if (!skipRemotePush)
    void pushContent(
      lib.scenes
        .map((scene, order) => ({
          id: scene.id,
          kind: 'scene' as const,
          name: scene.name,
          payload: {
            prompt: scene.prompt,
            ...(scene.icon ? { icon: scene.icon } : {}),
            ...promptKindMetadata(scene.kind),
            ...(scene.kind === 'scene' ? {} : characterMetadata(scene.characterCard)),
            ...marketRevisionMetadata(scene.id, scene.marketRevision),
            ...marketPortraitMetadata(scene.id, scene.marketPortraitId),
          },
          order,
        }))
        .filter((scene) => changedIds.has(scene.id)),
    );
  if (preferencesChanged && !skipRemotePush)
    void pushContentPreferences('scene', {
      selectedId: lib.selectedId,
      hiddenBuiltinIds: lib.hiddenBuiltinIds,
    });
}

/** Merge account-owned cards into the local library. */
export function syncScenes(): Promise<void> {
  const account = currentAuthUserId();
  const key = accountKey(account);
  if (!account || !key) return Promise.resolve();
  if (synced) return Promise.resolve();
  if (syncPromise) return syncPromise;
  const generation = syncGeneration;
  const startingRevision = localRevision;
  const task = (async () => {
    const [remote, preferences] = await Promise.all([
      pullContent('scene'),
      pullContentPreferences('scene'),
    ]);
    if (!remote || generation !== syncGeneration || currentAuthUserId() !== account) return;
    synced = true;
    const local = loadScenesWithoutSync(account);
    const byId = new Map(local.scenes.map((scene) => [scene.id, scene]));
    for (const item of remote) {
      if ((sceneRevisions.get(item.id) ?? 0) > startingRevision) continue;
      if (item.deleted) byId.delete(item.id);
      else if (item.payload && typeof item.payload === 'object') {
        const payload = item.payload as Record<string, unknown>;
        if (typeof payload.prompt === 'string')
          byId.set(item.id, {
            id: item.id,
            name: item.name,
            prompt: payload.prompt,
            ...(typeof payload.icon === 'string' ? { icon: payload.icon } : {}),
            ...promptKindMetadata(payload.kind),
            ...(payload.kind === 'scene' ? {} : characterMetadata(payload.characterCard)),
            ...marketRevisionMetadata(item.id, payload.marketRevision),
            ...marketPortraitMetadata(item.id, payload.marketPortraitId),
          });
      }
    }
    const merged = normalizeLibrary({
      ...local,
      scenes: [...byId.values()],
      selectedId:
        preferenceRevision > startingRevision
          ? local.selectedId
          : (preferences?.selectedId ?? local.selectedId),
      hiddenBuiltinIds: [
        ...new Set([
          ...local.hiddenBuiltinIds,
          ...(preferenceRevision > startingRevision ? [] : (preferences?.hiddenBuiltinIds ?? [])),
        ]),
      ],
    });
    if (generation !== syncGeneration || currentAuthUserId() !== account) return;
    try {
      localStorage.setItem(key, JSON.stringify(merged));
    } catch {
      /* local-first */
    }
    const remoteIds = new Set(remote.map((item) => item.id));
    const missing = merged.scenes
      .filter((s) => !remoteIds.has(s.id))
      .map((s, order) => ({
        id: s.id,
        kind: 'scene' as const,
        name: s.name,
        payload: {
          prompt: s.prompt,
          ...(s.icon ? { icon: s.icon } : {}),
          ...promptKindMetadata(s.kind),
          ...(s.kind === 'scene' ? {} : characterMetadata(s.characterCard)),
          ...marketRevisionMetadata(s.id, s.marketRevision),
          ...marketPortraitMetadata(s.id, s.marketPortraitId),
        },
        order,
      }));
    if (currentAuthUserId() !== account || generation !== syncGeneration) return;
    await pushContent(missing);
    if (currentAuthUserId() !== account || generation !== syncGeneration) return;
    for (const l of listeners) l(merged);
  })().finally(() => {
    if (syncPromise === task) syncPromise = null;
  });
  syncPromise = task;
  return task;
}

if (typeof window !== 'undefined')
  window.addEventListener('0xnullai:auth-changed', () => {
    const nextAccount = currentAuthUserId();
    if (nextAccount === observedAccount) return;
    observedAccount = nextAccount;
    syncGeneration += 1;
    synced = false;
    syncPromise = null;
    localRevision = 0;
    preferenceRevision = 0;
    sceneRevisions.clear();
    const current = loadScenesWithoutSync();
    for (const listener of listeners) listener(current);
    void syncScenes();
  });

function loadScenesWithoutSync(account = currentAuthUserId()): SceneLibrary {
  const key = accountKey(account);
  if (!key || typeof localStorage === 'undefined') return emptyLibrary();
  try {
    return parseStoredLibrary(localStorage.getItem(key)) ?? emptyLibrary();
  } catch {
    return emptyLibrary();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate public content before it can become an account-owned scene snapshot. */
function marketSceneSnapshot(item: unknown): SavedScene | null {
  if (!isPlainObject(item) || item.type !== 'scenario') return null;

  const rawId = item.id;
  const rawName = item.name;
  if (
    typeof rawId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(rawId) ||
    typeof rawName !== 'string'
  ) {
    return null;
  }
  const name = rawName.trim();
  if (!name || name.length > 60 || !isPlainObject(item.content)) return null;

  const rawPrompt = item.content.prompt;
  if (typeof rawPrompt !== 'string') return null;
  const prompt = rawPrompt.trim();
  if (!prompt || prompt.length > MAX_MARKET_SCENE_PROMPT_LENGTH) return null;

  const id = `market-${rawId}`;
  const rawIcon = typeof item.icon === 'string' ? item.icon.trim() : '';
  const icon = rawIcon && rawIcon.length <= 8 ? rawIcon : '📝';
  const card = characterMetadata(item.content.characterCard);
  const rawKind = item.content.kind;
  if (rawKind !== undefined && rawKind !== 'character' && rawKind !== 'scene') return null;
  const kind = rawKind ?? (card.characterCard ? 'character' : 'scene');
  if (kind === 'character' && !card.characterCard) return null;
  if (kind === 'scene' && rawKind === 'scene' && item.content.characterCard !== undefined)
    return null;
  return {
    id,
    name,
    icon,
    prompt,
    kind,
    ...(kind === 'character' ? card : {}),
    ...marketRevisionMetadata(id, item.revision),
    ...marketPortraitMetadata(id, item.content.portraitId),
  };
}

/** Initial import selects a stable account-scoped snapshot; repeated imports never overwrite edits. */
export function withImportedMarketScene(current: SceneLibrary, item: unknown): SceneLibrary {
  const snapshot = marketSceneSnapshot(item);
  if (!snapshot) return current;
  const existing = current.scenes.some((scene) => scene.id === snapshot.id);
  if (existing)
    return current.selectedId === snapshot.id ? current : { ...current, selectedId: snapshot.id };
  return {
    ...current,
    selectedId: snapshot.id,
    scenes: [...current.scenes, snapshot],
  };
}

/** Apply an explicitly accepted newer public revision without changing the private entity ID. */
export function withUpdatedMarketScene(current: SceneLibrary, item: unknown): SceneLibrary {
  const snapshot = marketSceneSnapshot(item);
  if (!snapshot?.marketRevision) return current;
  const index = current.scenes.findIndex((scene) => scene.id === snapshot.id);
  if (index < 0) return current;
  const existing = current.scenes[index]!;
  if (savedPromptKind(existing) !== snapshot.kind) return current;
  if (existing.marketRevision && snapshot.marketRevision <= existing.marketRevision) return current;
  const scenes = [...current.scenes];
  scenes[index] = snapshot;
  return { ...current, scenes };
}

export function updateScenes(
  updater: (prev: SceneLibrary) => SceneLibrary,
  skipRemotePush = false,
): SceneLibrary {
  if (!accountKey()) return emptyLibrary();
  const prev = loadScenes();
  const next = normalizeLibrary(updater(prev));
  if (next === prev) return prev;
  saveScenes(next, skipRemotePush);
  const nextIds = new Set(next.scenes.map((scene) => scene.id));
  if (!skipRemotePush)
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

/** Confirm the account-owned snapshot online before a Market character opens a chat.
 * A retry after a lost response checks the server first, so it keeps the same
 * character identity and does not replace an existing private edit. */
export async function importMarketSceneOnline(
  item: unknown,
  options: {
    select?: boolean;
    /**
     * The user explicitly asked to import this card again, so a deletion marker from
     * another device is overridden by a fresh copy of the public card. Without it, the
     * deletion wins and nothing is resurrected.
     */
    restoreDeleted?: boolean;
  } = {},
): Promise<SceneLibrary> {
  const snapshot = marketSceneSnapshot(item);
  if (!snapshot) throw new Error('公开卡内容无效，无法导入');
  const account = currentAuthUserId();
  const generation = syncGeneration;
  if (!account) throw new Error('请先登录后导入公开内容');
  await syncScenes();
  if (currentAuthUserId() !== account || syncGeneration !== generation)
    throw new Error('账号已切换，请重新打开公开内容');
  if (!synced) throw new Error('云端卡片暂不可用，请重试导入');
  const remote = await pullContent('scene');
  if (currentAuthUserId() !== account || syncGeneration !== generation)
    throw new Error('账号已切换，请重新打开公开内容');
  if (!remote) throw new Error('云端卡片暂不可用，请重试导入');
  if (!options.restoreDeleted && remote.some((entry) => entry.id === snapshot.id && entry.deleted))
    throw new Error('这张个人卡已在其他设备删除，请刷新后确认是否重新导入');
  const existing = remote.find((entry) => entry.id === snapshot.id && !entry.deleted);
  const current = loadScenesWithoutSync(account);
  const local = current.scenes.find((scene) => scene.id === snapshot.id);
  const remotePayload = existing?.payload;
  const remoteScene =
    existing && isPlainObject(remotePayload)
      ? coerceScenes([{ ...remotePayload, id: existing.id, name: existing.name }])[0]
      : undefined;
  if (existing && !remoteScene) throw new Error('云端个人卡内容无效，请刷新后重试');
  if (remoteScene && savedPromptKind(remoteScene) !== snapshot.kind)
    throw new Error('已有个人卡类型与公开卡不一致，请刷新后重试');
  if (local && savedPromptKind(local) !== snapshot.kind)
    throw new Error('已有个人卡类型与公开卡不一致，请刷新后重试');
  const selected = remoteScene ?? local ?? snapshot;
  if (!existing) {
    const saved = await pushContent([
      {
        id: selected.id,
        kind: 'scene',
        name: selected.name,
        payload: {
          prompt: selected.prompt,
          ...(selected.icon ? { icon: selected.icon } : {}),
          ...promptKindMetadata(selected.kind),
          ...(selected.kind === 'scene' ? {} : characterMetadata(selected.characterCard)),
          ...marketRevisionMetadata(selected.id, selected.marketRevision),
          ...marketPortraitMetadata(selected.id, selected.marketPortraitId),
        },
        order: current.scenes.length,
      },
    ]);
    if (currentAuthUserId() !== account || syncGeneration !== generation)
      throw new Error('账号已切换，请重新打开公开内容');
    if (!saved) throw new Error('公开卡尚未保存到云端，请重试导入');
  }
  if (options.select !== false) {
    const preferencesSaved = await pushContentPreferences('scene', {
      selectedId: snapshot.id,
      hiddenBuiltinIds: current.hiddenBuiltinIds,
    });
    if (currentAuthUserId() !== account || syncGeneration !== generation)
      throw new Error('账号已切换，请重新打开公开内容');
    if (!preferencesSaved) throw new Error('公开卡选择尚未同步到云端，请重试导入');
  }
  return updateScenes((library) => {
    const withRemote =
      remoteScene && !library.scenes.some((scene) => scene.id === remoteScene.id)
        ? { ...library, scenes: [...library.scenes, remoteScene] }
        : library;
    const imported = withImportedMarketScene(withRemote, item);
    return options.select === false ? { ...imported, selectedId: library.selectedId } : imported;
  }, true);
}

/** Subscribe to changes. Same-document via listeners, cross-tab via the storage event. */
export function subscribeScenes(listener: (lib: SceneLibrary) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === accountKey() || e.key === null) listener(loadScenes());
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

/** Test seam for module-level reconciliation state. */
export function __resetSceneSyncForTests(): void {
  syncPromise = null;
  synced = false;
  syncGeneration = 0;
  observedAccount = currentAuthUserId();
  localRevision = 0;
  preferenceRevision = 0;
  sceneRevisions.clear();
}
