import guideStart from '../content/guide/start.md?raw';
import guideSafety from '../content/guide/safety.md?raw';
import guideModules from '../content/guide/modules.md?raw';
import guideFaq from '../content/guide/faq.md?raw';
import guideDeveloper from '../content/guide/developer.md?raw';

import kitOverview from '../content/kit/overview.md?raw';
import kitDeveloper from '../content/kit/developer.md?raw';
import kitApi from '../content/kit/api.md?raw';

import mcpManual from '../content/mcp/manual.md?raw';
import mcpDeveloper from '../content/mcp/developer.md?raw';
import mcpFaq from '../content/mcp/faq.md?raw';

/**
 * 说明文档的结构。
 *
 * 合并前是「五个仓 × 三篇」（DG-Kit / DG-Agent / DG-Chat / DG-Voice / DG-MCP），
 * 那是仓库结构的投影而不是用户的心智模型——用户面对的是一个软件，不是五个项目。
 * 现在主线是一套连贯的说明（上手 / 安全 / 模块 / FAQ / 开发），另外保留 Kit 与 MCP
 * 两组：它们确实是给外部开发者用的独立产物，不属于「这个软件怎么用」。
 */

export type Audience = 'user' | 'developer';
export type Accent = 'cyan' | 'magenta' | 'amber';

export interface Document {
  /** URL 里的 slug：#/<project>/<doc> */
  id: string;
  label: string;
  audience: Audience;
  defaultMd: string;
  /** 源文件路径，用于 GitHub 编辑链接。 */
  sourcePath: string;
}

export interface Project {
  id: string;
  label: string;
  tagline: string;
  accent: Accent;
  repo: string;
  documents: Document[];
}

export const PROJECTS: Project[] = [
  {
    id: 'guide',
    label: '0xNuller',
    tagline: '一个软件，四个模块 · 上手 / 安全 / 使用说明',
    accent: 'amber',
    repo: '0xNuller',
    documents: [
      {
        id: 'start',
        label: '快速开始',
        audience: 'user',
        defaultMd: guideStart,
        sourcePath: 'src/content/guide/start.md',
      },
      {
        id: 'safety',
        label: '安全模型',
        audience: 'user',
        defaultMd: guideSafety,
        sourcePath: 'src/content/guide/safety.md',
      },
      {
        id: 'modules',
        label: '四个模块',
        audience: 'user',
        defaultMd: guideModules,
        sourcePath: 'src/content/guide/modules.md',
      },
      {
        id: 'faq',
        label: '常见问题',
        audience: 'user',
        defaultMd: guideFaq,
        sourcePath: 'src/content/guide/faq.md',
      },
      {
        id: 'developer',
        label: '开发者文档',
        audience: 'developer',
        defaultMd: guideDeveloper,
        sourcePath: 'src/content/guide/developer.md',
      },
    ],
  },
  {
    id: 'kit',
    label: 'Kit',
    tagline: '共享 TypeScript 中台 · 协议 / 波形 / 工具定义',
    accent: 'cyan',
    repo: '0xNuller',
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
    id: 'mcp',
    label: 'MCP',
    tagline: '把设备接进任意 MCP 客户端',
    accent: 'magenta',
    repo: '0xNuller',
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
];

export const REPO_BASE = 'https://github.com/0xNullAI/0xNuller';

export function findProject(id: string | null): Project {
  // 缺省是主线说明，不是某个子项目——用户打开「说明」想看的是这个软件怎么用。
  return PROJECTS.find((p) => p.id === id) ?? PROJECTS[0]!;
}

export function findDocument(project: Project, docId: string | null): Document {
  return project.documents.find((d) => d.id === docId) ?? project.documents[0]!;
}

export function pageKey(projectId: string, docId: string): string {
  return `${projectId}/${docId}`;
}

export function githubEditUrl(doc: Document): string {
  return `${REPO_BASE}/edit/main/apps/wiki/${doc.sourcePath}`;
}
