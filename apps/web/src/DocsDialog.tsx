import { useState } from 'react';
import { X } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DOCS } from './docs';

/**
 * Docs. Like settings, this is a dialog, not a module.
 *
 * It shares the same shell as the settings panel (same size, corner radius, nav
 * column, close-button position) — the user reaches both from the same menu, so
 * looking different would only make them think they ended up in the wrong place.
 *
 * The body typography is deliberately plain. It used to use the doc site's style:
 * a `§` before every h2, a `◉ output` badge in the top-right corner of code blocks,
 * highlighter backgrounds behind bold text, `▸` as the list bullet, h1 clamped to
 * 3.6rem. That is the visual identity of a standalone site; inside an "I'm stuck,
 * let me look up what to do" dialog it is all noise, and the first screenful only
 * fits a single heading.
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
        className="flex h-[min(680px,calc(100vh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] sm:flex-row"
      >
        {/* Narrow screens: the contents run horizontally along the top. A vertical nav
            column eats half the width on a phone. */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)] p-2 sm:w-[196px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          <h2 className="hidden px-2 pb-2 pt-1 text-sm font-semibold sm:block">说明</h2>
          {DOCS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDocId(d.id)}
              aria-current={d.id === docId ? 'page' : undefined}
              className={
                'shrink-0 rounded-[var(--radius-ctl)] px-3 py-2 text-left transition-colors ' +
                (d.id === docId
                  ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              <span className="block text-sm font-medium">{d.label}</span>
              {/* The blurb only shows on wide screens: narrow screens use horizontal tabs,
                  and an extra line would stretch the contents into two rows. */}
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
              className="rounded-[var(--radius-ctl)] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* The key sends the scroll position back to the top when the doc changes —
              without it, opening the second page starts at the previous page's offset. */}
          <article key={docId} className="docs-body min-h-0 flex-1 overflow-y-auto px-6 pb-8">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.markdown}</ReactMarkdown>
          </article>
        </div>
      </div>
    </Overlay>
  );
}
