/**
 * 跨模块共享的场景库。
 *
 * 「场景」在 Agent 与 Voice 里是同一个东西——`SavedPromptPreset` 的类型定义两处逐
 * 字节相同（Voice 的 PresetSelector 就是从 Agent 移植的）。差别只在持久化：一份塞在
 * `dg-agent.browser-settings` 的大 JSON 里，另一份塞在 `dg-voice-settings` 里。用户在
 * Agent 里写的人设，到 Voice 里看不到。
 *
 * 拆出来还有第二个、更重要的理由：Agent 的设置 blob 是「一处 zod 校验失败 → 整份回落
 * 默认值」。场景和 `maxStrengthA/B`、`permissionMode` 住在同一个 blob 里，于是一条写坏
 * 的自定义场景会**静默重置用户的强度上限**。这里每个场景独立解析，坏的那条丢掉，
 * 其余照常。
 *
 * **内置人设不在这里。** 七个内置 id 两边一致（gentle / dominant / tease / reward /
 * edging / companion / hell-island），但文案不同——Voice 那份为 TTS 重写过（短句、无
 * markdown）。共享的是「用户选了哪个」和「用户自己写的那些」，不是文案本身。
 */

export interface SavedScene {
  id: string;
  name: string;
  icon?: string;
  prompt: string;
}

export interface SceneLibrary {
  /** 用户自己写的场景。 */
  scenes: SavedScene[];
  /** 当前选中的场景 id（可能指向内置人设）。 */
  selectedId: string;
  /** 被用户隐藏的内置人设 id。 */
  hiddenBuiltinIds: string[];
}

const KEY = '0xnullai.scenes';
/** 合并前各模块自己的键，用于一次性迁移。 */
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

function emptyLibrary(): SceneLibrary {
  return { scenes: [], selectedId: DEFAULT_SELECTED, hiddenBuiltinIds: [] };
}

/**
 * 逐条解析。一条坏了只丢那一条——这正是从大 blob 里拆出来要换取的性质，
 * 整份回落默认值意味着用户会不知不觉丢掉全部自定义场景。
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
      // 两边都有自定义场景时合并而不是二选一——用户在哪边写的都是自己的东西。
      // 按 id 去重，先到者胜（Agent 排在前面）。
      for (const s of scenes) {
        if (!merged.scenes.some((existing) => existing.id === s.id)) merged.scenes.push(s);
      }
      for (const h of hidden)
        if (!merged.hiddenBuiltinIds.includes(h)) merged.hiddenBuiltinIds.push(h);
      if (selected && merged.selectedId === DEFAULT_SELECTED) merged.selectedId = selected;
    } catch {
      // 某个旧 blob 坏了不影响另一个。
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
      return {
        scenes: coerceScenes(o.scenes),
        selectedId:
          typeof o.selectedId === 'string' && o.selectedId ? o.selectedId : DEFAULT_SELECTED,
        hiddenBuiltinIds: coerceStringArray(o.hiddenBuiltinIds),
      };
    }
    const legacy = readLegacy();
    if (legacy) {
      saveScenes(legacy);
      return legacy;
    }
  } catch {
    // 存储被污染时回落空库，而不是让模块崩在启动阶段。
  }
  return emptyLibrary();
}

export function saveScenes(lib: SceneLibrary): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lib));
  } catch {
    // 隐私模式 / 配额满：存不下不该阻断使用。
  }
  for (const l of listeners) l(lib);
}

export function updateScenes(updater: (prev: SceneLibrary) => SceneLibrary): SceneLibrary {
  const next = updater(loadScenes());
  saveScenes(next);
  return next;
}

/** 订阅变化。同文档走 listeners，跨标签页走 storage 事件。 */
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
 * 新建场景的 id。
 *
 * 合并前用的是 `custom-${Date.now()}`。两个库合并时同一毫秒建的场景会撞 id，而查找是
 * `find()`——撞了就是静默遮蔽，用户会发现某个场景「点了没反应」。
 */
export function newSceneId(): string {
  return crypto.randomUUID();
}
