import type { Document, Project } from '../lib/projects';

interface Props {
  project: Project;
  activeDocId: string;
  onNavigate: (docId: string) => void;
}

const audienceLabel: Record<Document['audience'], string> = {
  user: '用户',
  developer: '开发者',
};

/**
 * Secondary navigation: switches between documents within the active project
 * (manual / developer / faq). Lives in the same sticky shell as the header
 * so there is no gap between the two bars.
 */
export function DocTabs({ project, activeDocId, onNavigate }: Props) {
  return (
    <nav className="border-t border-[var(--surface-border)] bg-[var(--bg-strong)]/60">
      <div className="flex items-stretch px-4 sm:px-6 lg:px-8 gap-0 overflow-x-auto no-scrollbar">
        {project.documents.map((doc) => {
          const isActive = doc.id === activeDocId;
          const dirty = false;
          return (
            <button
              type="button"
              key={doc.id}
              onClick={() => onNavigate(doc.id)}
              className={[
                'relative flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 transition-colors shrink-0 text-[13px] sm:text-sm border-b-2',
                isActive
                  ? 'border-[var(--accent-strong)] text-[var(--text)]'
                  : 'border-transparent text-[var(--text-soft)] hover:text-[var(--text)]',
              ].join(' ')}
            >
              <span className="font-medium tracking-tight whitespace-nowrap">{doc.label}</span>
              <span
                className={[
                  'hidden sm:inline font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5 rounded',
                  doc.audience === 'developer'
                    ? 'bg-[var(--bg)] border border-[var(--surface-border-strong)] text-[var(--text-faint)]'
                    : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]',
                ].join(' ')}
              >
                {audienceLabel[doc.audience]}
              </span>
              {dirty ? (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]"
                  style={{ animation: 'glow 1.4s ease-in-out infinite' }}
                  title="本地有未提交修改"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
