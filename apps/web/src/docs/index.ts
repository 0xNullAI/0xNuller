import intro from './intro.md?raw';
import control from './control.md?raw';
import agent from './agent.md?raw';
import chat from './chat.md?raw';
import voice from './voice.md?raw';
import playground from './playground.md?raw';
import market from './market.md?raw';

/**
 * Documentation.
 *
 * One flat level: an intro up front, then one page per app, in the same order
 * as the app switcher. No project grouping, no developer docs.
 *
 * It used to be "three projects x three to five pages" (main line / Kit / MCP,
 * each group split further into user / developer) — a projection of the five-repo
 * era. What the user faces is one piece of software, not a group of repos; and Kit
 * and MCP are npm packages for external developers, unrelated to "how do I use
 * this software". Keeping them here only makes people think they have to
 * understand them before they can start.
 *
 * The safety notice lives inside the intro rather than as its own page: it is
 * something everyone must see first, and making it an entry the user has to click
 * open means nobody reads it by default.
 */

export interface Doc {
  id: string;
  label: string;
  /** One-line blurb in the contents list, so you know which page to read without opening it. */
  blurb: string;
  markdown: string;
}

export const DOCS: Doc[] = [
  { id: 'intro', label: '介绍', blurb: '安全与开始使用', markdown: intro },
  { id: 'control', label: 'Control', blurb: '自己控制自己的设备', markdown: control },
  { id: 'agent', label: 'Agent', blurb: '打字，AI 帮你操作', markdown: agent },
  { id: 'voice', label: 'Voice', blurb: '说话代替打字', markdown: voice },
  { id: 'chat', label: 'Chat', blurb: '房间与私聊', markdown: chat },
  { id: 'playground', label: 'Playground', blurb: '把设备接进游戏', markdown: playground },
  { id: 'market', label: 'Market', blurb: '现成的波形和场景', markdown: market },
];
