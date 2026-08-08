import { useEffect, useSyncExternalStore } from 'react';
import { applyTheme, getEffectiveTheme } from './theme';
import type { EffectiveTheme, ThemeMode } from './theme';

/**
 * 跨模块共享的主题。
 *
 * 合并前有六个主题所有者，各自持久化到不同的键，却都往同一个
 * `documentElement[data-theme]` 上写：外壳（`0xnullai-theme`）、Agent 与 Voice
 * （各自设置对象里的字段）、Chat（不持久化，直接读 DOM）、Market
 * （`dg-market.theme` + 一份完全重复的 applyTheme）、Wiki（`dg-wiki:theme`）。
 *
 * 独立部署时这没问题——一个文档里只有一个所有者。挂进统一外壳后就成了竞态：打开
 * Wiki，它按自己的键把主题改掉；切回 Agent，Agent 的 effect 依赖没变不会重跑，于是
 * Wiki 的主题一直赖着。表现是「点了主题按钮，进另一个模块又变回去了」。
 *
 * 所以这里收成**唯一**的所有者：只有 setThemeMode 会碰那个 DOM 属性，只有一个键。
 * 谁调用都一样，不需要在模块之间协商所有权。
 */

const KEY = '0xnullai.theme';

/**
 * 合并前各处的键，用于一次性迁移。顺序即优先级——外壳的排最前，因为用户最近一次
 * 明确的选择最可能发生在那里。
 */
const LEGACY_KEYS = ['0xnullai-theme', 'dg-market.theme', 'dg-wiki:theme'];
/** Agent 与 Voice 把主题存在各自的设置对象里，需要按路径取。 */
const LEGACY_SETTINGS: { key: string; field: string }[] = [
  { key: 'dg-agent.browser-settings', field: 'themeMode' },
  { key: 'dg-voice-settings', field: 'theme' },
];

const listeners = new Set<(mode: ThemeMode) => void>();

function isMode(v: unknown): v is ThemeMode {
  return v === 'auto' || v === 'dark' || v === 'light';
}

function readLegacy(): ThemeMode | null {
  for (const key of LEGACY_KEYS) {
    const v = localStorage.getItem(key);
    if (isMode(v)) return v;
  }
  for (const { key, field } of LEGACY_SETTINGS) {
    try {
      const blob = JSON.parse(localStorage.getItem(key) ?? 'null') as Record<
        string,
        unknown
      > | null;
      const v = blob?.[field];
      if (isMode(v)) return v;
    } catch {
      // 设置对象坏了不该连累主题——继续看下一个来源。
    }
  }
  return null;
}

export function loadThemeMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    const own = localStorage.getItem(KEY);
    if (isMode(own)) return own;
    const legacy = readLegacy();
    if (legacy) {
      localStorage.setItem(KEY, legacy);
      return legacy;
    }
  } catch {
    // 隐私模式：回落跟随系统，而不是让整个应用崩在启动阶段。
  }
  return 'auto';
}

/** 唯一会修改 `data-theme` 的入口。 */
export function setThemeMode(mode: ThemeMode): void {
  applyTheme(mode);
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // 存不下时本次会话内仍然生效。
  }
  for (const l of listeners) l(mode);
}

/**
 * 订阅主题变化。同文档内走 listeners，跨标签页走 storage 事件——后者是「在 Agent
 * 标签页切了深色，Chat 标签页跟着变」的实现。
 */
export function subscribeThemeMode(listener: (mode: ThemeMode) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY && isMode(e.newValue)) {
      applyTheme(e.newValue);
      listener(e.newValue);
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export interface UseThemeResult {
  /** 用户选的模式，含 auto。设置界面显示这个。 */
  mode: ThemeMode;
  /** 实际生效的深/浅。切换按钮的图标与取反都用这个——基于 mode 取反的话，从 auto
   *  出发的第一次点击会得到 light，在浅色系统上等于按钮没反应。 */
  effective: EffectiveTheme;
  setMode: (mode: ThemeMode) => void;
  /** 在深浅之间切。 */
  toggle: () => void;
}

/**
 * 快照必须是稳定的原始值，否则 useSyncExternalStore 每次比较都不相等，会无限重渲。
 * 两个值编码进一个字符串是最省事的做法——它们总是一起变。
 */
function snapshot(): `${ThemeMode}|${EffectiveTheme}` {
  const mode = loadThemeMode();
  return `${mode}|${getEffectiveTheme(mode)}`;
}

function subscribeAll(onChange: () => void): () => void {
  const stopStore = subscribeThemeMode(onChange);
  // auto 模式下系统配色翻转也要重渲。这里不能只在 mode==='auto' 时订阅——mode 会变，
  // 而 subscribe 的身份必须稳定，否则每次 mode 变化都要重新订阅。
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onMedia = () => {
    if (loadThemeMode() === 'auto') applyTheme('auto');
    onChange();
  };
  media.addEventListener('change', onMedia);
  return () => {
    stopStore();
    media.removeEventListener('change', onMedia);
  };
}

export function useTheme(): UseThemeResult {
  const snap = useSyncExternalStore(subscribeAll, snapshot, () => 'auto|light' as const);
  const [mode, effective] = snap.split('|') as [ThemeMode, EffectiveTheme];

  // 挂载即施加一次。模块是后挂进外壳的，此时 DOM 上可能还没有属性；独立运行时
  // 这也是首次施加的地方。用 effect 而不是渲染期做，因为它写的是 React 之外的 DOM。
  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  return {
    mode,
    effective,
    setMode: setThemeMode,
    toggle: () => setThemeMode(effective === 'dark' ? 'light' : 'dark'),
  };
}
