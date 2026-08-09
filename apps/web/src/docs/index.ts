import intro from './intro.md?raw';
import agent from './agent.md?raw';
import chat from './chat.md?raw';
import voice from './voice.md?raw';
import market from './market.md?raw';

/**
 * 说明文档。
 *
 * 一层结构：开头一篇介绍，然后四个软件各一篇。没有项目分组，没有开发者文档。
 *
 * 之前是「三个项目 × 三到五篇」（主线 / Kit / MCP，每组还分 user / developer）——
 * 那是五个仓库时代的投影。用户面对的是一个软件，不是一个仓库群；而 Kit 与 MCP 是
 * 给外部开发者用的 npm 包，跟「这个软件怎么用」无关，放在这里只会让人以为自己
 * 需要读懂它们才能开始。
 *
 * 安全须知在介绍里，不单独成篇：它是每个人都必须先看到的东西，做成一个需要用户
 * 主动点开的条目就等于默认没人看。
 */

export interface Doc {
  id: string;
  label: string;
  /** 目录里的一句话说明，让人不用点开就知道该看哪篇。 */
  blurb: string;
  markdown: string;
}

export const DOCS: Doc[] = [
  { id: 'intro', label: '介绍', blurb: '这是什么 · 安全须知 · 第一次使用', markdown: intro },
  { id: 'agent', label: 'Agent', blurb: '打字，AI 帮你操作', markdown: agent },
  { id: 'chat', label: 'Chat', blurb: '多人房间，别人可以控制你', markdown: chat },
  { id: 'voice', label: 'Voice', blurb: '说话代替打字', markdown: voice },
  { id: 'market', label: 'Market', blurb: '现成的波形和场景', markdown: market },
];
