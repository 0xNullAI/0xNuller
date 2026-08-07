import kitOverview from '../content/kit/overview.md?raw';
import kitDeveloper from '../content/kit/developer.md?raw';
import kitApi from '../content/kit/api.md?raw';

import agentManual from '../content/agent/manual.md?raw';
import agentDeveloper from '../content/agent/developer.md?raw';
import agentFaq from '../content/agent/faq.md?raw';

import chatManual from '../content/chat/manual.md?raw';
import chatDeveloper from '../content/chat/developer.md?raw';
import chatFaq from '../content/chat/faq.md?raw';

import mcpManual from '../content/mcp/manual.md?raw';
import mcpDeveloper from '../content/mcp/developer.md?raw';
import mcpFaq from '../content/mcp/faq.md?raw';

import voiceManual from '../content/voice/manual.md?raw';
import voiceDeveloper from '../content/voice/developer.md?raw';
import voiceFaq from '../content/voice/faq.md?raw';

export type Audience = 'user' | 'developer';
export type Accent = 'cyan' | 'magenta' | 'amber';

export interface Document {
  /** Slug used in URL: #/<project>/<doc> */
  id: string;
  /** Tab label */
  label: string;
  /** "user" 或 "developer"，用于 UI 上加角标 */
  audience: Audience;
  /** Markdown shipped with build */
  defaultMd: string;
  /** Path of the source .md inside DG-Wiki repo (for the GitHub edit link) */
  sourcePath: string;
}

export interface Project {
  /** URL slug */
  id: string;
  /** Display name (used as tab label) */
  label: string;
  /** Tagline shown on the active tab */
  tagline: string;
  /** Accent color used to tint hover/active states for this project */
  accent: Accent;
  /** Linked GitHub repo */
  repo: string;
  /** Sub-documents */
  documents: Document[];
}

export const PROJECTS: Project[] = [
  {
    id: 'kit',
    label: 'DG-Kit',
    tagline: '共享 TypeScript 中台 · 协议 / 波形 / 工具定义',
    accent: 'cyan',
    repo: 'DG-Kit',
    documents: [
      {
        id: 'overview',
        label: '项目概述',
        audience: 'user',
        defaultMd: kitOverview,
        sourcePath: 'src/content/kit/overview.md',
      },
      {
        id: 'developer',
        label: '开发者文档',
        audience: 'developer',
        defaultMd: kitDeveloper,
        sourcePath: 'src/content/kit/developer.md',
      },
      {
        id: 'api',
        label: 'API 参考',
        audience: 'developer',
        defaultMd: kitApi,
        sourcePath: 'src/content/kit/api.md',
      },
    ],
  },
  {
    id: 'agent',
    label: 'DG-Agent',
    tagline: '浏览器版 AI 控制器 · 自然语言驱动设备',
    accent: 'magenta',
    repo: 'DG-Agent',
    documents: [
      {
        id: 'manual',
        label: '使用手册',
        audience: 'user',
        defaultMd: agentManual,
        sourcePath: 'src/content/agent/manual.md',
      },
      {
        id: 'developer',
        label: '开发者文档',
        audience: 'developer',
        defaultMd: agentDeveloper,
        sourcePath: 'src/content/agent/developer.md',
      },
      {
        id: 'faq',
        label: 'FAQ / 故障排查',
        audience: 'user',
        defaultMd: agentFaq,
        sourcePath: 'src/content/agent/faq.md',
      },
    ],
  },
  {
    id: 'chat',
    label: 'DG-Chat',
    tagline: '多人 P2P 房间 · 远程控制队友设备',
    accent: 'magenta',
    repo: 'DG-Chat',
    documents: [
      {
        id: 'manual',
        label: '使用手册',
        audience: 'user',
        defaultMd: chatManual,
        sourcePath: 'src/content/chat/manual.md',
      },
      {
        id: 'developer',
        label: '开发者文档',
        audience: 'developer',
        defaultMd: chatDeveloper,
        sourcePath: 'src/content/chat/developer.md',
      },
      {
        id: 'faq',
        label: 'FAQ / 故障排查',
        audience: 'user',
        defaultMd: chatFaq,
        sourcePath: 'src/content/chat/faq.md',
      },
    ],
  },
  {
    id: 'mcp',
    label: 'DG-MCP',
    tagline: 'MCP 服务器 · 接 Claude Desktop 等客户端',
    accent: 'amber',
    repo: 'DG-MCP',
    documents: [
      {
        id: 'manual',
        label: '使用手册',
        audience: 'user',
        defaultMd: mcpManual,
        sourcePath: 'src/content/mcp/manual.md',
      },
      {
        id: 'developer',
        label: '开发者文档',
        audience: 'developer',
        defaultMd: mcpDeveloper,
        sourcePath: 'src/content/mcp/developer.md',
      },
      {
        id: 'faq',
        label: 'FAQ / 故障排查',
        audience: 'user',
        defaultMd: mcpFaq,
        sourcePath: 'src/content/mcp/faq.md',
      },
    ],
  },
  {
    id: 'voice',
    label: 'DG-Voice',
    tagline: '实时语音 Agent · 打开即通话，AI 自主决定何时调用工具',
    accent: 'amber',
    repo: 'DG-Voice',
    documents: [
      {
        id: 'manual',
        label: '使用手册',
        audience: 'user',
        defaultMd: voiceManual,
        sourcePath: 'src/content/voice/manual.md',
      },
      {
        id: 'developer',
        label: '开发者文档',
        audience: 'developer',
        defaultMd: voiceDeveloper,
        sourcePath: 'src/content/voice/developer.md',
      },
      {
        id: 'faq',
        label: 'FAQ / 故障排查',
        audience: 'user',
        defaultMd: voiceFaq,
        sourcePath: 'src/content/voice/faq.md',
      },
    ],
  },
];

export const REPO_BASE = 'https://github.com/0xNullAI/DG-Wiki';

export function findProject(id: string | null): Project {
  return PROJECTS.find((p) => p.id === id) ?? PROJECTS[1]!; // default = DG-Agent
}

export function findDocument(project: Project, docId: string | null): Document {
  return project.documents.find((d) => d.id === docId) ?? project.documents[0]!;
}

export function pageKey(projectId: string, docId: string): string {
  return `${projectId}/${docId}`;
}

export function githubEditUrl(doc: Document): string {
  return `${REPO_BASE}/edit/main/${doc.sourcePath}`;
}
