import type { ComponentType } from 'react';
import { lazy } from 'react';

/**
 * 模块注册表。
 *
 * 每个模块是自己源码树里的一个根组件，这里只负责「按路由挂载」。它们各自的内部
 * 结构、chrome 和状态管理都保持原样——外壳只接管模块切换、设备状态与账号入口。
 *
 * 用 lazy 是为了让每个模块连同它的 CSS 单独成块：只有真正打开过的模块才会被下载。
 */

export interface ModuleRoute {
  /** URL 路径前缀，同时是模块 id。 */
  id: string;
  /** 导航栏上的名字。 */
  label: string;
  /** 一句话说明它解决什么问题，用于首页与移动端长按提示。 */
  blurb: string;
  Component: ComponentType;
}

export const MODULES: ModuleRoute[] = [
  {
    id: 'agent',
    label: 'Agent',
    blurb: '用自然语言对话，AI 通过工具调用控制设备',
    Component: lazy(() => import('./modules/agent')),
  },
  {
    id: 'chat',
    label: 'Chat',
    blurb: '多人房间，把设备控制权交给房间里的伙伴',
    Component: lazy(() => import('./modules/chat')),
  },
  {
    id: 'voice',
    label: 'Voice',
    blurb: '像打电话一样跟 AI 保持连线',
    Component: lazy(() => import('./modules/voice')),
  },
  {
    id: 'market',
    label: 'Market',
    blurb: '社区波形与场景，一键带进其余模块',
    Component: lazy(() => import('./modules/market')),
  },
  {
    id: 'wiki',
    label: 'Wiki',
    blurb: '文档',
    Component: lazy(() => import('./modules/wiki')),
  },
];

/** 从 pathname 解析当前模块 id；根路径返回 null（显示首页）。 */
export function moduleIdFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return MODULES.some((m) => m.id === seg) ? seg : null;
}
