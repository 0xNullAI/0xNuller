import type { ReactNode } from 'react';
import { AppSwitcher } from './app-switcher';
import { useInShell } from '../shell-context';

/**
 * 模块自己的顶栏。
 *
 * 独立部署时它就是那条 header：左边模块名与应用切换器，右边模块自己的按钮。
 * 挂进统一外壳后它**什么都不画**——全局只有外壳那一条横栏，按钮由 `<ModuleActions>`
 * 投上去，模块名也由外壳导航里高亮的那一项表达。两条栏上下叠着、模块名重复出现，
 * 就是合并前的样子。
 *
 * children 里应当包一层 `<ModuleActions>`：外壳里它 portal 走，独立时原地渲染。
 */

export interface HeaderBarProps {
  /** 应用切换器用的模块 id。 */
  moduleId: string;
  /** 标题文字。 */
  label: string;
  children?: ReactNode;
}

export function HeaderBar({ moduleId, label, children }: HeaderBarProps) {
  const inShell = useInShell();

  // 仍然渲染 children：里面的 ModuleActions 会把按钮 portal 到外壳栏上。
  if (inShell) return <>{children}</>;

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-2.5">
      <AppSwitcher current={moduleId} label={label} className="text-base font-semibold" />
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
