import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * 模块是否运行在统一外壳里。
 *
 * 每个模块都是独立可部署的应用，所以自带完整的顶栏：应用切换器、主题按钮、标题。
 * 挂进外壳后这些和外壳顶栏一一重复——两个应用切换器、两个主题按钮。
 *
 * 模块用这个标志隐藏那些外壳已经提供的控件；独立运行时（无 Provider）默认 false，
 * 行为与合并前完全一致。**只用于隐藏重复的外壳级控件**，不要用它给模块加分支逻辑，
 * 那会让两种运行形态悄悄分叉。
 */
const InShellContext = createContext(false);

export function ShellChromeProvider({ children }: { children: ReactNode }) {
  return <InShellContext.Provider value={true}>{children}</InShellContext.Provider>;
}

export function useInShell(): boolean {
  return useContext(InShellContext);
}
