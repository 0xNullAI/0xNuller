import { useState } from 'react';
import { MarkdownView } from './MarkdownView';
import { PublishDialog } from './PublishDialog';
import type { Document } from '../lib/projects';

interface Props {
  doc: Document;
  content: string;
  onChange: (next: string) => void;
}

/**
 * Split-screen Markdown editor. Left = textarea; right = live preview.
 * The "↗ publish" button opens a modal that pushes the change to GitHub
 * as a PR using a personal access token saved in localStorage.
 */
export function EditPanel({ doc, content, onChange }: Props) {
  const lineCount = content.split('\n').length;
  const [showPublish, setShowPublish] = useState(false);

  return (
    <div className="grid grid-cols-2 gap-0 border-t border-[var(--surface-border)] reveal">
      <div className="border-r border-[var(--surface-border)] flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--surface-border)] bg-[var(--bg-strong)]">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            ✎ markdown
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tabular-nums text-[var(--text-soft)]">
              {lineCount}L · {content.length}c
            </span>
            <button
              type="button"
              onClick={() => setShowPublish(true)}
              className="dg-button is-primary"
              style={{ padding: '0.25em 0.7em', fontSize: '10.5px' }}
              title="把当前内容作为 PR 提交到 GitHub"
            >
              ↗ publish
            </button>
          </div>
        </div>
        <textarea
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="flex-1 w-full px-6 py-4 bg-[var(--bg)] text-[var(--text)] font-mono text-sm leading-relaxed resize-none outline-none focus:bg-[var(--bg-strong)] transition-colors"
          style={{ minHeight: '70vh' }}
        />
      </div>

      <div className="flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--surface-border)] bg-[var(--bg-strong)]">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            ◉ preview
          </span>
          <span
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--accent-strong)]"
            style={{ animation: 'scan-blink 4s ease-in-out infinite' }}
          >
            live
          </span>
        </div>
        <div className="px-6 py-6 overflow-y-auto" style={{ maxHeight: '70vh' }}>
          <MarkdownView content={content} />
        </div>
      </div>

      {showPublish ? (
        <PublishDialog doc={doc} content={content} onClose={() => setShowPublish(false)} />
      ) : null}
    </div>
  );
}
