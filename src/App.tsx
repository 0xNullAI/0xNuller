import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { MarkdownView } from './components/MarkdownView';
import { EditPanel } from './components/EditPanel';
import { Waveform } from './components/Waveform';
import { findPage, PAGES } from './lib/pages';
import { usePageContent } from './hooks/use-page-content';
import { useTheme } from './hooks/use-theme';

const STORAGE_PREFIX = 'dg-wiki:content:';

function readActiveFromHash(): string {
  if (typeof window === 'undefined') return 'home';
  const id = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return PAGES.some((p) => p.id === id) ? id : 'home';
}

export function App() {
  const [activeId, setActiveId] = useState<string>(readActiveFromHash);
  const [isEditing, setIsEditing] = useState(false);

  const page = useMemo(() => findPage(activeId), [activeId]);
  const { theme, toggle: toggleTheme } = useTheme();
  const { content, isModified, setContent, reset } = usePageContent(page);

  useEffect(() => {
    const sync = () => setActiveId(readActiveFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = (id: string) => {
    window.location.hash = `/${id}`;
    setActiveId(id);
    setIsEditing(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const isModifiedFor = (id: string) =>
    typeof window !== 'undefined' && localStorage.getItem(STORAGE_PREFIX + id) !== null;

  return (
    <div className="min-h-screen flex bg-[var(--bg)] text-[var(--text)] scanline-overlay">
      <Sidebar active={activeId} onNavigate={navigate} isModified={isModifiedFor} />

      <main className="flex-1 min-w-0 flex flex-col">
        <Header
          page={page}
          isModified={isModified}
          isEditing={isEditing}
          onToggleEdit={() => setIsEditing((v) => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
          onReset={reset}
        />

        {isEditing ? (
          <EditPanel page={page} content={content} onChange={setContent} />
        ) : (
          <div className="px-10 lg:px-16 xl:px-24 py-10 max-w-none">
            <PageHero page={page} />
            <MarkdownView content={content} />

            <div className="mt-20 pt-6 border-t border-[var(--surface-border)] flex items-center justify-between text-[var(--text-faint)] font-mono text-[11px] uppercase tracking-[0.15em]">
              <span>end of file · {page.id}.md</span>
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-[var(--accent-strong)] rounded-full" style={{ animation: 'glow 2s ease-in-out infinite' }} />
                eof
              </span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function PageHero({ page }: { page: import('./lib/pages').PageMeta }) {
  return (
    <div className="mb-10 reveal">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-[var(--text-faint)]">
          {page.kicker}
        </span>
        <Waveform width={140} height={20} className="opacity-50 w-[140px] h-[20px]" />
      </div>
      <div className="border-b border-[var(--surface-border)] mb-2" />
    </div>
  );
}
