import homeMd from '../content/home.md?raw';
import kitMd from '../content/kit.md?raw';
import agentMd from '../content/agent.md?raw';
import chatMd from '../content/chat.md?raw';
import mcpMd from '../content/mcp.md?raw';
import aboutMd from '../content/about.md?raw';

export interface PageMeta {
  /** URL slug + localStorage key */
  id: string;
  /** Sidebar label (Chinese) */
  label: string;
  /** Optional kicker shown above the label */
  kicker?: string;
  /** Visual accent — picks one of cyan / magenta / amber for hover/active states */
  accent: 'cyan' | 'magenta' | 'amber';
  /** Default markdown shipped with the build */
  defaultMd: string;
  /** Path of the source file in the DG-Wiki repo (used to build a "edit on GitHub" link) */
  sourcePath: string;
}

export const PAGES: PageMeta[] = [
  {
    id: 'home',
    label: '总览',
    kicker: '00 / index',
    accent: 'cyan',
    defaultMd: homeMd,
    sourcePath: 'src/content/home.md',
  },
  {
    id: 'kit',
    label: 'DG-Kit',
    kicker: '01 / 中台',
    accent: 'cyan',
    defaultMd: kitMd,
    sourcePath: 'src/content/kit.md',
  },
  {
    id: 'agent',
    label: 'DG-Agent',
    kicker: '02 / Agent',
    accent: 'magenta',
    defaultMd: agentMd,
    sourcePath: 'src/content/agent.md',
  },
  {
    id: 'chat',
    label: 'DG-Chat',
    kicker: '03 / Chat',
    accent: 'magenta',
    defaultMd: chatMd,
    sourcePath: 'src/content/chat.md',
  },
  {
    id: 'mcp',
    label: 'DG-MCP',
    kicker: '04 / MCP',
    accent: 'amber',
    defaultMd: mcpMd,
    sourcePath: 'src/content/mcp.md',
  },
  {
    id: 'about',
    label: '关于',
    kicker: '99 / about',
    accent: 'cyan',
    defaultMd: aboutMd,
    sourcePath: 'src/content/about.md',
  },
];

export function findPage(id: string | null): PageMeta {
  return PAGES.find((p) => p.id === id) ?? PAGES[0]!;
}

export const REPO_BASE = 'https://github.com/0xNullAI/DG-Wiki';

export function githubEditUrl(page: PageMeta): string {
  return `${REPO_BASE}/edit/main/${page.sourcePath}`;
}
