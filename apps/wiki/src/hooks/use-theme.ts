import { useTheme as useSharedTheme } from '@0xnullai/ui';

export type Theme = 'dark' | 'light';

/**
 * 主题现在由 `@0xnullai/ui` 的共享 store 统一持有。
 *
 * 这里保留这个 hook 只是为了不改 App.tsx 的调用点。它以前自己往
 * `documentElement.dataset.theme` 写、自己存 `dg-wiki:theme`——挂进统一外壳后，
 * 那份写入会把外壳和其它模块的主题一起顶掉。共享 store 会把旧键迁移过来。
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const { effective, toggle } = useSharedTheme();
  return { theme: effective, toggle };
}
