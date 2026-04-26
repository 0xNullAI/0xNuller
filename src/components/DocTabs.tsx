import type { Document, Project } from '../lib/projects';

interface Props {
  project: Project;
  activeDocId: string;
  onNavigate: (docId: string) => void;
  isModified: (docId: string) => boolean;
}

const audienceLabel: Record<Document['audience'], string> = {
  user: '用户',
  developer: '开发者',
};

/**
 * Secondary tabs that switch between documents within a single project
 * (manual / developer / faq).
 */
export function DocTabs({ project, activeDocId, onNavigate, isModified }: Props) {
  return (
    <div className="border-b border-[var(--surface-border)] bg-[var(--bg-strong)] sticky top-[57px] z-20 backdrop-blur">
      <div className="flex items-stretch px-8 gap-1 overflow-x-auto">
        {project.documents.map((doc) => {
          const isActive = doc.id === activeDocId;
          const dirty = isModified(doc.id);
          return (
            <button
              type="button"
              key={doc.id}
              onClick={() => onNavigate(doc.id)}
              className={[
                'relative flex items-center gap-2 px-4 py-2.5 transition-colors shrink-0 text-sm',
                'border-b',
                isActive
                  ? 'border-[var(--accent-strong)] text-[var(--text)]'
                  : 'border-transparent text-[var(--text-soft)] hover:text-[var(--text)]',
              ].join(' ')}
            >
              <span className="font-medium tracking-tight">{doc.label}</span>
              <span
                className={[
                  'font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5 rounded',
                  doc.audience === 'developer'
                    ? 'bg-[var(--bg)] border border-[var(--surface-border-strong)] text-[var(--text-faint)]'
                    : 'bg-[var(--accent-soft)] text-[var(--accent-strong)]',
                ].join(' ')}
              >
                {audienceLabel[doc.audience]}
              </span>
              {dirty ? (
                <span
                  className="w-1 h-1 rounded-full bg-[var(--danger)]"
                  style={{ animation: 'glow 1.4s ease-in-out infinite' }}
                  title="本地有未提交修改"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
