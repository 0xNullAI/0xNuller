import { MobileTocButton } from './MobileTocButton';
import { ProjectPicker } from './ProjectPicker';

interface HeaderProps {
  isModified: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  isProjectModified: (projectId: string) => boolean;
  /** Markdown source used to build the mobile TOC popover. */
  tocContent: string;
}

/**
 * Top bar — intentionally minimal: wordmark + project picker + theme toggle.
 * All page-level actions (edit / pr / github / reset) live in the bottom
 * action bar so the header stays clean on mobile.
 */
export function Header({
  isModified,
  theme,
  onToggleTheme,
  activeProjectId,
  onSelectProject,
  isProjectModified,
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
            isModified={isProjectModified}
          />

          {isModified ? (
            <span
              className="hidden sm:flex font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--danger)] items-center gap-1.5"
              title="本地浏览器存档了你的修改"
            >
              <span
                className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]"
                style={{ animation: 'glow 1.4s ease-in-out infinite' }}
              />
              local-edit
            </span>
          ) : null}
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
