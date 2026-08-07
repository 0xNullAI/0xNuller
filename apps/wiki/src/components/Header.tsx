import { MobileTocButton } from './MobileTocButton';
import { ProjectPicker } from './ProjectPicker';

interface HeaderProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  /** Markdown source used to build the mobile TOC popover. */
  tocContent: string;
}

/**
 * Top bar — intentionally minimal: wordmark + project picker + theme toggle.
 * 页面级操作（在仓库里改这一页 / 看源码）放在底部操作栏
 * action bar so the header stays clean on mobile.
 */
export function Header({
  theme,
  onToggleTheme,
  activeProjectId,
  onSelectProject,
  tocContent,
}: HeaderProps) {
  return (
    <header>
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-[var(--text)] leading-none">
              DG·WIKI
            </span>
            <span className="hidden md:inline font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
              docs hub
            </span>
          </div>

          <span className="hidden sm:inline text-[var(--text-faint)] text-sm">/</span>

          <ProjectPicker
            activeId={activeProjectId}
            onSelect={onSelectProject}
          />

        </div>

        <div className="flex items-center gap-2 shrink-0">
          <MobileTocButton content={tocContent} />
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="切换主题"
            className="dg-button w-9"
            style={{ padding: '0.55em 0' }}
          >
            <span className="block w-full text-center">{theme === 'dark' ? '☾' : '☀'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
