import { useEffect, useMemo, useState } from 'react';
import { DocTabs } from './components/DocTabs';
import { Header } from './components/Header';
import { MarkdownView } from './components/MarkdownView';
import { EditPanel } from './components/EditPanel';
import { TableOfContents } from './components/TableOfContents';
import { Waveform } from './components/Waveform';
import { findDocument, findProject, PROJECTS } from './lib/projects';
import { isContentModified, usePageContent } from './hooks/use-page-content';
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
  const [isEditing, setIsEditing] = useState(false);

  const project = useMemo(() => findProject(route.projectId), [route.projectId]);
  const doc = useMemo(() => findDocument(project, route.docId), [project, route.docId]);

  const { theme, toggle: toggleTheme } = useTheme();
  const { content, isModified, setContent, reset } = usePageContent(project.id, doc);

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
    setIsEditing(false);
    window.scrollTo({ top: 0 });
  };

  const navigateDoc = (docId: string) => {
    window.location.hash = `/${route.projectId}/${docId}`;
    setRoute({ projectId: route.projectId, docId });
    setIsEditing(false);
    window.scrollTo({ top: 0 });
  };

  const projectIsModified = (projectId: string) =>
    PROJECTS.find((p) => p.id === projectId)?.documents.some((d) =>
      isContentModified(projectId, d.id),
    ) ?? false;

  const docIsModified = (docId: string) => isContentModified(route.projectId, docId);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <Header
        doc={doc}
        isModified={isModified}
        isEditing={isEditing}
        onToggleEdit={() => setIsEditing((v) => !v)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onReset={reset}
        activeProjectId={route.projectId}
        onSelectProject={navigateProject}
        isProjectModified={projectIsModified}
      />

      <DocTabs
        project={project}
        activeDocId={route.docId}
        onNavigate={navigateDoc}
        isModified={docIsModified}
      />

      {isEditing ? (
        <EditPanel doc={doc} content={content} onChange={setContent} />
      ) : (
        <main className="flex-1 flex gap-12 px-6 lg:px-12 xl:px-16 py-10 max-w-[1400px] w-full mx-auto">
          {/* Left rail: TOC */}
          <TableOfContents content={content} />

          {/* Content */}
          <div className="flex-1 min-w-0">
            <DocHero project={project} docLabel={doc.label} />
            <MarkdownView content={content} />

            <div className="mt-20 pt-6 border-t border-[var(--surface-border)] flex items-center justify-between text-[var(--text-faint)] font-mono text-[11px] uppercase tracking-[0.15em]">
              <span>
                end of file · {project.id}/{doc.id}.md
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full"
                  style={{ animation: 'glow 2s ease-in-out infinite' }}
                />
                eof
              </span>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

function DocHero({
  project,
  docLabel,
}: {
  project: import('./lib/projects').Project;
  docLabel: string;
}) {
  return (
    <div className="mb-10 reveal">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-[var(--text-faint)]">
          {project.label} / {docLabel}
        </span>
        <Waveform width={140} height={20} className="opacity-50 w-[140px] h-[20px]" />
      </div>
      <div className="border-b border-[var(--surface-border)] mb-2" />
    </div>
  );
}
