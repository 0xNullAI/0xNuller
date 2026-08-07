import { useEffect, useMemo, useState } from 'react';
import { DocTabs } from './components/DocTabs';
import { Header } from './components/Header';
import { MarkdownView } from './components/MarkdownView';
import { TableOfContents } from './components/TableOfContents';
import { Waveform } from './components/Waveform';
import {
  findDocument,
  findProject,
  githubEditUrl,
  PROJECTS,
  REPO_BASE,
  type Document,
  type Project,
} from './lib/projects';
import { usePageContent } from './hooks/use-page-content';
import { useTheme } from './hooks/use-theme';

interface Route {
  projectId: string;
  docId: string;
}

function readRouteFromHash(): Route {
  if (typeof window === 'undefined') return { projectId: 'agent', docId: 'manual' };
  const cleaned = window.location.hash.replace(/^#\/?/, '');
  const [projectId = 'agent', docId = ''] = cleaned.split('/');
  const project = PROJECTS.find((p) => p.id === projectId) ?? PROJECTS[1]!;
  const doc = project.documents.find((d) => d.id === docId) ?? project.documents[0]!;
  return { projectId: project.id, docId: doc.id };
}

export function App() {
  const [route, setRoute] = useState<Route>(readRouteFromHash);

  const project = useMemo(() => findProject(route.projectId), [route.projectId]);
  const doc = useMemo(() => findDocument(project, route.docId), [project, route.docId]);

  const { theme, toggle: toggleTheme } = useTheme();
  const { content } = usePageContent(project.id, doc);

  useEffect(() => {
    const sync = () => setRoute(readRouteFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigateProject = (projectId: string) => {
    const next = PROJECTS.find((p) => p.id === projectId)!;
    const docId = next.documents[0]!.id;
    window.location.hash = `/${projectId}/${docId}`;
    setRoute({ projectId, docId });
    window.scrollTo({ top: 0 });
  };

  const navigateDoc = (docId: string) => {
    window.location.hash = `/${route.projectId}/${docId}`;
    setRoute({ projectId: route.projectId, docId });
    window.scrollTo({ top: 0 });
  };



  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* Single sticky shell so the two bars always travel together — no gap. */}
      <div className="sticky top-0 z-30 bg-[var(--bg)]/85 backdrop-blur border-b border-[var(--surface-border)]">
        <Header
          theme={theme}
          onToggleTheme={toggleTheme}
          activeProjectId={route.projectId}
          onSelectProject={navigateProject}
          tocContent={content}
        />
        <DocTabs
          project={project}
          activeDocId={route.docId}
          onNavigate={navigateDoc}
        />
      </div>

        <main className="flex-1 flex gap-8 lg:gap-12 px-4 sm:px-6 lg:px-12 xl:px-16 py-6 sm:py-10 max-w-[1400px] w-full mx-auto">
          <TableOfContents content={content} />

          <div className="flex-1 min-w-0">
            <DocHero project={project} docLabel={doc.label} />
            <MarkdownView content={content} />

            <PageActions doc={doc} project={project} />
          </div>
        </main>
    </div>
  );
}

function DocHero({ project, docLabel }: { project: Project; docLabel: string }) {
  return (
    <div className="mb-8 sm:mb-10 reveal">
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-[var(--text-faint)] truncate">
          {project.label} / {docLabel}
        </span>
        <Waveform
          width={140}
          height={20}
          className="opacity-50 hidden sm:block w-[140px] h-[20px] shrink-0"
        />
      </div>
      <div className="border-b border-[var(--surface-border)]" />
    </div>
  );
}

/**
 * Bottom action bar — replaces the header's button cluster. Centralizes
 * page-level actions（在仓库里改这一页 / 看源码）so
 * the top bar stays clean and the layout works on narrow screens.
 */
function PageActions({
  doc,
  project,
}: {
  doc: Document;
  project: Project;
}) {
  return (
    <section className="mt-16 sm:mt-20 pt-8 border-t border-[var(--surface-border)]">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1.5">
            page actions
          </div>
          <div className="font-mono text-[12px] text-[var(--text-soft)] truncate">
            {project.id}/{doc.id}.md
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={githubEditUrl(doc)}
            target="_blank"
            rel="noreferrer"
            className="dg-button"
            title="在 GitHub 上修改这一页（提交 PR）"
          >
            ↗ pr
          </a>
          <a href={REPO_BASE} target="_blank" rel="noreferrer" className="dg-button">
            ↗ github
          </a>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between text-[var(--text-faint)] font-mono text-[10px] uppercase tracking-[0.15em]">
        <span>eof</span>
        <span className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full"
            style={{ animation: 'glow 2s ease-in-out infinite' }}
          />
          end of file
        </span>
      </div>
    </section>
  );
}
