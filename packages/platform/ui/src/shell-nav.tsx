import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * 外壳导航。模块用它知道「我在哪」以及「怎么切到别处」。
 *
 * 独立部署时没有 Provider，`useShellNav()` 返回 null，切换器回落成真跳转（各应用
 * 有自己的域名）。挂进外壳后是同一个文档内的路由切换——不重新加载，BLE 连接与
 * 模块状态都保住。
 */

export interface ShellModule {
  id: string;
  /** 侧边栏顶部显示的名字。不带 DG- 前缀。 */
  label: string;
  /** 一句话说明。 */
  blurb: string;
}

export interface ShellNav {
  activeId: string | null;
  modules: readonly ShellModule[];
  navigate: (moduleId: string | null) => void;
}

const ShellNavContext = createContext<ShellNav | null>(null);

export function ShellNavProvider({ value, children }: { value: ShellNav; children: ReactNode }) {
  return <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>;
}

export function useShellNav(): ShellNav | null {
  return useContext(ShellNavContext);
}
