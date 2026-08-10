import type { ComponentType } from 'react';
import { lazy } from 'react';

/**
 * The game catalogue.
 *
 * Playground is the home for anything that drives the device from game state
 * rather than from a conversation — snake now, the 剧本杀 mode that used to
 * live inside Chat's roleplay later.
 *
 * `status` is honest on purpose: a card that says 敬请期待 is better than a
 * playable-looking tile that opens an empty screen.
 */
export interface GameEntry {
  id: string;
  name: string;
  blurb: string;
  /** How the device is involved, shown before you start. */
  deviceUse: string;
  status: 'ready' | 'planned';
  Component?: ComponentType;
}

export const GAMES: GameEntry[] = [
  {
    id: 'snake',
    name: '贪吃蛇',
    blurb: '经典贪吃蛇，撞墙或碰到自己即结束',
    deviceUse: '吃到食物时短反馈，结束时加强反馈',
    status: 'ready',
    Component: lazy(() => import('./games/snake/SnakeGame')),
  },
  {
    id: 'scripted-mystery',
    name: '剧本杀',
    blurb: '多人角色扮演推理，按剧本推进。',
    deviceUse: '按剧情节点触发，具体由剧本决定。',
    status: 'planned',
  },
];
