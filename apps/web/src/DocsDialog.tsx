import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PROJECTS } from '../../wiki/src/lib/projects';

/**
 * 说明。和设置一样是弹窗，不是一个模块。
 *
 * 合并前它是独立的文档站（DG-Wiki），有自己的路由、自己的顶栏、自己的主题按钮和
 * 项目选择器——那是「五个仓库」时代的形态。用户点开「说明」只是想查一件事，不是要
 * 切换到另一个应用；给它一个模块槽位意味着它会出现在应用切换器里，稀释真正的四项。
 *
 * 排版刻意从简：左边一列目录，右边正文。原来那套 breadcrumb + 波形装饰 + 目录浮层
 * 是给一个独立站点做的门面，塞进弹窗里只剩噪音。
 */

/** 只取主线那一组。Kit 与 MCP 是给外部开发者的，不属于「这个软件怎么用」。 */
const GUIDE = PROJECTS.find((p) => p.id === 'guide')!;

export function DocsDialog({ onClose }: { onClose: () => void }) {
  const [docId, setDocId] = useState(GUIDE.documents[0]!.id);
  const doc = useMemo(
    () => GUIDE.documents.find((d) => d.id === docId) ?? GUIDE.documents[0]!,
    [docId],
  );

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="说明"
        className="flex h-[min(680px,calc(100vh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] sm:flex-row"
      >
        {/* 窄屏：目录横排在顶部。竖排的导航列在手机上会吃掉一半宽度。 */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)] p-2 sm:w-[180px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          <h2 className="hidden px-2 pb-2 pt-1 text-sm font-semibold sm:block">说明</h2>
          {GUIDE.documents.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDocId(d.id)}
              aria-current={d.id === docId ? 'page' : undefined}
              className={
                'shrink-0 rounded-[10px] px-3 py-2 text-left text-sm transition-colors ' +
                (d.id === docId
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              {d.label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-end p-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭说明"
              className="rounded-[10px] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <article className="markdown-body docs-in-dialog min-h-0 flex-1 overflow-y-auto px-5 pb-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.defaultMd}</ReactMarkdown>
          </article>
        </div>
      </div>
    </Overlay>
  );
}
