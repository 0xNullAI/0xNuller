import { useState } from 'react';
import { X } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DOCS } from './docs';

/**
 * 说明。和设置一样是弹窗，不是一个模块。
 *
 * 和设置面板共用同一副外壳（尺寸、圆角、导航列、关闭按钮的位置都一样）——用户
 * 从同一个菜单点进这两个东西，长得不一样只会让人以为自己进错了地方。
 *
 * 正文排版刻意平淡。之前用的是文档站那套：每个二级标题前面一个 `§`、代码块右上角
 * 一个 `◉ output` 角标、加粗文字带荧光笔底色、列表点是 `▸`、h1 clamp 到 3.6rem。
 * 那是一个独立站点的视觉身份，放进「我卡住了，来查一下怎么办」的弹窗里全是噪音，
 * 而且第一屏只装得下一个标题。
 */

export function DocsDialog({ onClose }: { onClose: () => void }) {
  const [docId, setDocId] = useState(DOCS[0]!.id);
  const doc = DOCS.find((d) => d.id === docId) ?? DOCS[0]!;

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="说明"
        className="flex h-[min(680px,calc(100vh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] sm:flex-row"
      >
        {/* 窄屏：目录横排在顶部。竖排的导航列在手机上会吃掉一半宽度。 */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)] p-2 sm:w-[196px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          <h2 className="hidden px-2 pb-2 pt-1 text-sm font-semibold sm:block">说明</h2>
          {DOCS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDocId(d.id)}
              aria-current={d.id === docId ? 'page' : undefined}
              className={
                'shrink-0 rounded-[10px] px-3 py-2 text-left transition-colors ' +
                (d.id === docId
                  ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              <span className="block text-sm font-medium">{d.label}</span>
              {/* 一句话说明只在宽屏出现：窄屏是横排 tab，多一行会把目录撑成两层。 */}
              <span className="hidden text-xs leading-snug text-[var(--text-faint)] sm:block">
                {d.blurb}
              </span>
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
          {/* key 让换文档时滚动位置回到顶部——不加的话点开第二篇是从上一篇的位置开始的。 */}
          <article key={docId} className="docs-body min-h-0 flex-1 overflow-y-auto px-6 pb-8">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.markdown}</ReactMarkdown>
          </article>
        </div>
      </div>
    </Overlay>
  );
}
