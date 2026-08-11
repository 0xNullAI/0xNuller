import { useEffect, useSyncExternalStore } from 'react';
import { applyTheme, getEffectiveTheme } from './theme';
import type { EffectiveTheme, ThemeMode } from './theme';

/**
 * Theme shared across modules.
 *
 * Pre-merge there were six theme owners, each persisting to a different key
 * while all writing the same `documentElement[data-theme]`: the shell
 * (`0xnullai-theme`), Agent and Voice (fields in their settings objects),
 * Chat (no persistence, read the DOM directly), Market (`dg-market.theme`
 * plus a fully duplicated applyTheme), Wiki (`dg-wiki:theme`).
 *
 * Standalone that was fine — one owner per document. In the unified shell
 * it became a race: open Wiki and it flips the theme by its own key; switch
 * back to Agent and Agent's effect deps haven't changed so it doesn't
 * re-run, leaving Wiki's theme stuck. Symptom: "I clicked the theme button
 * and another module switched it back."
 *
 * So this is now the *only* owner: only setThemeMode touches that DOM
 * attribute, and there is one key. Any caller is equal; no ownership
 * negotiation between modules.
 */

const KEY = '0xnullai.theme';

/**
 * Pre-merge keys, migrated once. Order is priority — the shell's key comes
 * first because the user's most recent explicit choice most likely happened
 * there.
 */
const LEGACY_KEYS = ['0xnullai-theme', 'dg-market.theme', 'dg-wiki:theme'];
/** Agent and Voice store the theme inside their settings objects; read by path. */
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
      // A corrupt settings object must not take the theme down — try the
      // next source.
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
    // Private browsing: fall back to follow-system instead of crashing the
    // app at startup.
  }
  return 'auto';
}

/** The only entry point that mutates `data-theme`. */
export function setThemeMode(mode: ThemeMode): void {
  applyTheme(mode);
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // If the write fails the value still applies for this session.
  }
  for (const l of listeners) l(mode);
}

/**
 * Subscribe to theme changes. Same-document via listeners, cross-tab via
 * the storage event — the latter implements "switch to dark in the Agent
 * tab, the Chat tab follows".
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
  /** The mode the user picked, including auto. Settings UI shows this. */
  mode: ThemeMode;
  /** The effective dark/light. The toggle's icon and inversion both use
   *  this — inverting mode instead means the first click starting from
   *  auto yields light, which on a light system looks like a dead button. */
  effective: EffectiveTheme;
  setMode: (mode: ThemeMode) => void;
  /** Toggle between dark and light. */
  toggle: () => void;
}

/**
 * The snapshot must be a stable primitive, or useSyncExternalStore sees
 * inequality on every compare and re-renders forever. Encoding both values
 * into one string is the cheapest approach — they always change together.
 */
function snapshot(): `${ThemeMode}|${EffectiveTheme}` {
  const mode = loadThemeMode();
  return `${mode}|${getEffectiveTheme(mode)}`;
}

function subscribeAll(onChange: () => void): () => void {
  const stopStore = subscribeThemeMode(onChange);
  // In auto mode an OS color-scheme flip must re-render too. We cannot
  // subscribe only when mode==='auto' — mode changes, and subscribe's
  // identity must stay stable or every mode change re-subscribes.
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

  // Apply once on mount. Modules mount into the shell late, when the DOM
  // attribute may not exist yet; standalone this is also where the first
  // application happens. An effect, not render-phase work, because it
  // writes DOM outside React.
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
