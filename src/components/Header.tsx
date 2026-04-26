import { ProjectPicker } from './ProjectPicker';
import type { Document } from '../lib/projects';
import { githubEditUrl, REPO_BASE } from '../lib/projects';

interface HeaderProps {
  doc: Document;
  isModified: boolean;
  isEditing: boolean;
  onToggleEdit: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onReset: () => void;
  // Project picker hooks
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  isProjectModified: (projectId: string) => boolean;
}

export function Header({
  doc,
  isModified,
  isEditing,
  onToggleEdit,
  theme,
  onToggleTheme,
  onReset,
  activeProjectId,
  onSelectProject,
  isProjectModified,
}: HeaderProps) {
  return (
    <header className="border-b border-[var(--surface-border)] bg-[var(--bg)] sticky top-0 z-30 backdrop-blur">
      <div className="flex items-center justify-between px-8 py-3 gap-6">
        {/* Brand + project picker */}
        <div className="flex items-center gap-5 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl font-extrabold tracking-tight text-[var(--text)] leading-none">
              DG·WIKI
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
              docs hub
            </span>
          </div>

          <span className="text-[var(--text-faint)] text-sm">/</span>

          <ProjectPicker
            activeId={activeProjectId}
            onSelect={onSelectProject}
            isModified={isProjectModified}
          />

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
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isModified ? (
            <button
              type="button"
              onClick={onReset}
              className="dg-button"
              title="把本地修改丢弃，恢复随构建发布的原文"
            >
              ↺ reset
            </button>
          ) : null}

          <a
            href={githubEditUrl(doc)}
            target="_blank"
            rel="noreferrer"
            className="dg-button"
            title="在 GitHub 上修改这一页（提交 PR）"
          >
            ↗ pr
          </a>

          <button
            type="button"
            onClick={onToggleEdit}
            className={['dg-button', isEditing ? 'is-active' : ''].join(' ')}
          >
            {isEditing ? '✕ close' : '✎ edit'}
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="切换主题"
            className="dg-button w-9"
            style={{ padding: '0.55em 0' }}
          >
            <span className="block w-full text-center">{theme === 'dark' ? '☾' : '☀'}</span>
          </button>

          <a href={REPO_BASE} target="_blank" rel="noreferrer" className="dg-button is-primary">
            github
          </a>
        </div>
      </div>
    </header>
  );
}
