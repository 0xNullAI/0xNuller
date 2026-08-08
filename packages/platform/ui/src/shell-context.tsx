import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * 外壳提供给模块的东西。
 *
 * 每个模块都是独立可部署的应用，所以自带完整的顶栏：应用切换器、主题按钮、标题、
 * 自己的设置面板。挂进外壳后这些和外壳一一重复——两个应用切换器、两个主题按钮、
 * 同一个设置项在两处能改。
 *
 * 模块用 `useInShell()` 隐藏那些外壳已经提供的控件；独立运行时（无 Provider）默认
 * false，行为与合并前完全一致。**只用于隐藏重复的外壳级控件**，不要用它给模块加
 * 分支逻辑，那会让两种运行形态悄悄分叉。
 */

export type ShellSettingsTab = 'appearance' | 'ai' | 'scenes' | 'safety';

interface ShellChrome {
  inShell: boolean;
  /**
   * 打开外壳那个唯一的设置面板，可指定落在哪一页。
   *
   * 给的是「入口位置」而不是「第二套设置界面」：模块界面里该有设置入口的地方
   * （比如 Chat 房主要配 AI 的那个按钮）仍然有按钮，只是点开的是同一个面板。
   */
  openSettings: (tab?: ShellSettingsTab) => void;
}

const ShellChromeContext = createContext<ShellChrome>({
  inShell: false,
  openSettings: () => undefined,
});

export function ShellChromeProvider({
  children,
  openSettings,
}: {
  children: ReactNode;
  openSettings: (tab?: ShellSettingsTab) => void;
}) {
  // 刻意不 memo：Shell 每次渲染都会重建这个对象，但消费者只有几个按钮，
  // 而 memo 会引入一个「openSettings 变了没」的依赖，写错就是点了没反应。
  return (
    <ShellChromeContext.Provider value={{ inShell: true, openSettings }}>
      {children}
    </ShellChromeContext.Provider>
  );
}

export function useInShell(): boolean {
  return useContext(ShellChromeContext).inShell;
}

/** 打开外壳设置面板。不在外壳里时是空操作——模块自己那套面板此时仍然可用。 */
export function useOpenShellSettings(): (tab?: ShellSettingsTab) => void {
  return useContext(ShellChromeContext).openSettings;
}
