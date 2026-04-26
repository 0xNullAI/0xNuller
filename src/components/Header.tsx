import type { PageMeta } from '../lib/pages';
import { githubEditUrl, REPO_BASE } from '../lib/pages';

interface HeaderProps {
  page: PageMeta;
  isModified: boolean;
  isEditing: boolean;
  onToggleEdit: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onReset: () => void;
}

export function Header({
  page,
  isModified,
  isEditing,
  onToggleEdit,
  theme,
  onToggleTheme,
  onReset,
}: HeaderProps) {
  return (
    <header className="border-b border-[var(--surface-border)] bg-[var(--bg)] sticky top-0 z-30 backdrop-blur">
      <div className="flex items-center justify-between px-8 py-3 gap-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            dg·wiki / {page.id}
          </span>
          {isModified ? (
            <span
              className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--danger)] flex items-center gap-1.5"
              title="本地浏览器存档了你的修改"
            >
              <span
                className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]"
                style={{ animation: 'glow 1.4s ease-in-out infinite' }}
              />
              local-edit
            </span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--text-faint)]">
              read-only · localStorage 未启用
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isModified ? (
            <button
              type="button"
              onClick={onReset}
              className="font-mono text-[11px] uppercase tracking-[0.1em] px-3 py-1.5 border border-[var(--surface-border)] text-[var(--text-soft)] hover:text-[var(--danger)] hover:border-[var(--danger)] transition-colors"
              title="把本地修改丢弃，恢复随构建发布的原文"
            >
              ↺ reset
            </button>
          ) : null}

          <a
            href={githubEditUrl(page)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] uppercase tracking-[0.1em] px-3 py-1.5 border border-[var(--surface-border)] text-[var(--text-soft)] hover:text-[var(--accent-strong)] hover:border-[var(--accent-strong)] transition-colors"
            title="在 GitHub 上修改这一页（提交 PR）"
          >
            ↗ pr
          </a>

          <button
            type="button"
            onClick={onToggleEdit}
            className={[
              'font-mono text-[11px] uppercase tracking-[0.1em] px-3 py-1.5 border transition-colors',
              isEditing
                ? 'bg-[var(--accent-strong)] text-[var(--bg)] border-[var(--accent-strong)]'
                : 'border-[var(--surface-border)] text-[var(--text-soft)] hover:text-[var(--accent-strong)] hover:border-[var(--accent-strong)]',
            ].join(' ')}
          >
            {isEditing ? '✕ close' : '✎ edit'}
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="切换主题"
            className="font-mono text-xs px-3 py-1.5 border border-[var(--surface-border)] text-[var(--text-soft)] hover:text-[var(--accent-strong)] hover:border-[var(--accent-strong)] transition-colors w-8 flex items-center justify-center"
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>

          <a
            href={REPO_BASE}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] uppercase tracking-[0.1em] px-3 py-1.5 bg-[var(--text)] text-[var(--bg)] hover:bg-[var(--accent-strong)] transition-colors"
          >
            github
          </a>
        </div>
      </div>
    </header>
  );
}
