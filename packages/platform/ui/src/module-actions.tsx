import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * 模块把自己的顶栏按钮投到外壳那条栏上。
 *
 * 合并前每个模块都有自己的一条 header：模块名 + 连接设备 + 设置。挂进外壳后就是两条
 * 横栏上下叠着，模块名还和外壳导航里高亮的那个重复。
 *
 * 现在只有一条栏：左上角是模块切换，右边依次是模块自己的按钮、急停、账号、主题。
 * 模块不再画自己的 header，只声明「我有哪些按钮」，由外壳决定放在哪。
 *
 * 独立部署时没有 Provider，`<ModuleActions>` 原地渲染，模块保留自己的 header——
 * 两种形态共用同一份按钮代码，不分叉。
 */

const ActionsContainerContext = createContext<HTMLElement | null>(null);

export function ModuleActionsProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <ActionsContainerContext.Provider value={container}>{children}</ActionsContainerContext.Provider>
  );
}

export function ModuleActions({ children }: { children: ReactNode }) {
  const container = useContext(ActionsContainerContext);
  return container ? createPortal(children, container) : <>{children}</>;
}

/**
 * 外壳侧：拿到那个容器元素。
 *
 * 用 state 而不是 ref——ref 的赋值不触发重渲染，Provider 会一直拿到 null，模块的按钮
 * 就永远投不进来（首屏空一次，且没有任何东西会让它再渲染一遍）。
 */
export function useModuleActionsContainer(): [
  (el: HTMLDivElement | null) => void,
  HTMLElement | null,
] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return [setEl, el];
}
