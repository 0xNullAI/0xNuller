import type { ComponentType } from 'react';
import { lazy } from 'react';

/**
 * 模块注册表。每个模块是自己源码树里的根组件，外壳只负责按路由挂载。
 * lazy 让每个模块连同它的 CSS 单独成块——只有真正打开过的模块才会被下载。
 *
 * 名字不带 DG 前缀：软件叫 0xNuller，这些是它的模块。
 */
export interface ModuleRoute {
  id: string;
  label: string;
  blurb: string;
  Component: ComponentType;
}

/** 应用切换器里的四项。 */
export const MODULES: ModuleRoute[] = [
  { id: 'agent', label: 'Agent', blurb: '对话控制设备', Component: lazy(() => import('./modules/agent')) },
  { id: 'chat', label: 'Chat', blurb: '多人房间远程控制', Component: lazy(() => import('./modules/chat')) },
  { id: 'voice', label: 'Voice', blurb: '实时语音通话', Component: lazy(() => import('./modules/voice')) },
  { id: 'market', label: 'Market', blurb: '波形与场景社区', Component: lazy(() => import('./modules/market')) },
];

/**
 * 说明文档。**不在应用切换器里**——它从账户菜单进入，和「账户」「软件设置」并列。
 * 文档不是一个你会「切换过去用」的应用，把它并排放进切换器会稀释那四项。
 */
export const DOCS_ROUTE: ModuleRoute = {
  id: 'docs',
  label: '说明',
  blurb: '使用说明与故障排查',
  Component: lazy(() => import('./modules/wiki')),
};

export const ALL_ROUTES: ModuleRoute[] = [...MODULES, DOCS_ROUTE];

export function moduleIdFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return ALL_ROUTES.some((m) => m.id === seg) ? seg : null;
}
