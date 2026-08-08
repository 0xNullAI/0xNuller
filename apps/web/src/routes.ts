import type { ComponentType } from 'react';
import { lazy } from 'react';

/**
 * 模块注册表。每个模块是自己源码树里的根组件，外壳只负责按路由挂载。
 * lazy 让每个模块连同它的 CSS 单独成块——只有真正打开过的模块才会被下载。
 */
export interface ModuleRoute {
  id: string;
  label: string;
  blurb: string;
  Component: ComponentType;
}

export const MODULES: ModuleRoute[] = [
  { id: 'agent',  label: 'Agent',  blurb: '对话控制设备',            Component: lazy(() => import('./modules/agent')) },
  { id: 'chat',   label: 'Chat',   blurb: '多人房间远程控制',        Component: lazy(() => import('./modules/chat')) },
  { id: 'voice',  label: 'Voice',  blurb: '实时语音通话',            Component: lazy(() => import('./modules/voice')) },
  { id: 'market', label: 'Market', blurb: '波形与场景社区',          Component: lazy(() => import('./modules/market')) },
  { id: 'wiki',   label: 'Wiki',   blurb: '文档',                    Component: lazy(() => import('./modules/wiki')) },
];

export function moduleIdFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return MODULES.some((m) => m.id === seg) ? seg : null;
}
