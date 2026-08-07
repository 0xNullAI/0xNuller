import { useMemo } from 'react';
import type { Document } from '../lib/projects';

/**
 * 读取文档正文。
 *
 * 原先这里还有一层 localStorage 覆盖，用于网页端的在线编辑器——编辑器已下线，
 * 文档改为只走官方发布（正文随构建打包，贡献走仓库 PR）。保留这个 hook 是为了
 * 让调用方形态不变，同时给未来的按需加载留一个收口。
 */
export function usePageContent(_projectId: string, doc: Document): { content: string } {
  return useMemo(() => ({ content: doc.defaultMd }), [doc.defaultMd]);
}
