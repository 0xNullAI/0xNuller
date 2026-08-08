// @0xnullai/ui —— 平台设计系统单一真源。
// 令牌与滚动条样式通过 '@0xnullai/ui/styles/*.css' 引入（CSS 不走 JS 导出）。

export * from './components/alert';
export * from './components/app-switcher';
export * from './components/overlay-surface';
export * from './components/permission-modal';
export * from './components/safety-notice';
export * from './components/setting-toggle';
export * from './components/setting-label';
export * from './components/setting-select';
export * from './components/help-tip';
export * from './components/device-status';
export * from './components/emergency-stop';
export * from './components/badge';
export * from './components/button';
export * from './components/card';
export * from './components/checkbox';
export * from './components/dialog';
export * from './components/input';
export * from './components/meter';
export * from './components/scroll-area';
export * from './components/select';
export * from './components/sheet';
export * from './components/textarea';
export * from './utils';
// 只导出类型。applyTheme / subscribeThemeChanges 是 theme-store 的内部实现——
// 把它们公开出去就等于邀请模块再各写各的 data-theme，那正是刚清掉的那个 bug。
export type { ThemeMode, EffectiveTheme } from './theme';
export * from './theme-store';
export * from './shell-context';
export * from './overlay';
