import { PROJECTS } from '../lib/projects';
import { Waveform } from './Waveform';

interface TabBarProps {
  active: string;
  onNavigate: (id: string) => void;
  isModified: (projectId: string) => boolean;
}

/**
 * Top-level project tabs. Each tab represents a separate project; sub-doc
 * navigation within the project lives in `<DocTabs />`.
 */
export function TabBar({ active, onNavigate, isModified }: TabBarProps) {
  return (
    <nav className="border-b border-[var(--surface-border)] bg-[var(--bg)] sticky top-[57px] z-20 backdrop-blur">
      <div className="flex items-stretch px-8 gap-1 overflow-x-auto">
        {PROJECTS.map((project) => {
          const isActive = project.id === active;
          const dirty = isModified(project.id);
          return (
            <button
              type="button"
              key={project.id}
              onClick={() => onNavigate(project.id)}
              className={[
                'group relative flex flex-col items-start py-4 px-5 gap-1 transition-colors shrink-0',
                'border-b-2',
                isActive
                  ? 'border-[var(--accent)] bg-[var(--bg-strong)]'
                  : 'border-transparent hover:bg-[var(--bg-strong)]',
              ].join(' ')}
            >
              <div className="flex items-center gap-2">
                <span
                  className={[
                    'font-display text-2xl font-extrabold tracking-tight leading-none',
                    isActive
                      ? 'text-[var(--text)]'
                      : 'text-[var(--text-soft)] group-hover:text-[var(--text)]',
                    'transition-colors',
                  ].join(' ')}
                >
                  {project.label}
                </span>
                {dirty ? (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] mt-1"
                    style={{ animation: 'glow 1.4s ease-in-out infinite' }}
                    title="本地有未提交修改"
                  />
                ) : null}
              </div>
              <span
                className={[
                  'text-[11px] tracking-tight whitespace-nowrap',
                  isActive ? 'text-[var(--text-soft)]' : 'text-[var(--text-faint)]',
                ].join(' ')}
              >
                {project.tagline}
              </span>
              {isActive ? (
                <Waveform
                  width={120}
                  height={6}
                  className="absolute bottom-0 left-5 right-5 opacity-70 h-[6px] w-[120px]"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
