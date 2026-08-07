// 主题切换，与 DG-Agent 主站一致：auto 跟随系统，或手动锁定 light / dark。
export type ThemeMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'dg-market.theme';

export function getStoredMode(): ThemeMode {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function effective(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const value = effective(mode);
  root.setAttribute('data-theme', value);
  root.style.colorScheme = value;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', value === 'dark' ? '#080808' : '#ffffff');
}

export function setMode(mode: ThemeMode): void {
  if (mode === 'auto') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, mode);
  applyTheme(mode);
}

// auto 模式下跟随系统变化重渲染。
export function subscribeSystem(mode: ThemeMode, onChange: () => void): () => void {
  if (mode !== 'auto') return () => undefined;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange();
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}
