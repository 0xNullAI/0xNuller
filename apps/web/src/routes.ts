import type { ComponentType } from 'react';
import { lazy } from 'react';

/**
 * The module registry. Each module is the root component of its own source tree;
 * the shell only mounts them by route. lazy puts each module and its CSS into a
 * chunk of its own — only modules that were actually opened get downloaded.
 *
 * The names carry no DG prefix: the software is called 0xNuller and these are its
 * modules.
 */
export interface ModuleRoute {
  id: string;
  label: string;
  blurb: string;
  Component: ComponentType;
}

/**
 * The app switcher, in display order.
 *
 * The order is deliberate and is the order the products are meant to be
 * discovered in — direct control first, then communication and assisted control,
 * followed by content discovery and the developer playground.
 */
export const MODULES: ModuleRoute[] = [
  {
    id: 'control',
    label: 'Control',
    blurb: '直接控制自己的设备',
    Component: lazy(() => import('./modules/control')),
  },
  {
    id: 'chat',
    label: 'Chat',
    blurb: '多人房间远程控制',
    Component: lazy(() => import('./modules/chat')),
  },
  {
    id: 'agent',
    label: 'Agent',
    blurb: '对话控制设备',
    Component: lazy(() => import('./modules/agent')),
  },
  {
    id: 'voice',
    label: 'Voice',
    blurb: '实时语音通话',
    Component: lazy(() => import('./modules/voice')),
  },
  {
    id: 'video',
    label: 'Video',
    blurb: '摄像头视觉闭环场景',
    Component: lazy(() => import('./modules/video')),
  },
  {
    id: 'market',
    label: 'Market',
    blurb: '波形与场景社区',
    Component: lazy(() => import('./modules/market')),
  },
  {
    id: 'playground',
    label: 'Playground',
    blurb: '把设备接进游戏',
    Component: lazy(() => import('./modules/playground')),
  },
];

export function moduleIdFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return MODULES.some((m) => m.id === seg) ? seg : null;
}
