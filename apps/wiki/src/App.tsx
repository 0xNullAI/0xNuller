import { useEffect, useMemo, useState } from 'react';
import { DocTabs } from './components/DocTabs';
import { Header } from './components/Header';
import { MarkdownView } from './components/MarkdownView';
import { EditPanel } from './components/EditPanel';
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
      {/* Single sticky shell so the two bars always travel together — no gap. */}
      <div className="sticky top-0 z-30 bg-[var(--bg)]/85 backdrop-blur border-b border-[var(--surface-border)]">
        <Header
          isModified={isModified}
          theme={theme}
          onToggleTheme={toggleTheme}
          activeProjectId={route.projectId}
          onSelectProject={navigateProject}
          isProjectModified={projectIsModified}
          tocContent={content}
        />
        <DocTabs
          project={project}
          activeDocId={route.docId}
          onNavigate={navigateDoc}
          isModified={docIsModified}
        />
      </div>

      {isEditing ? (
        <EditPanel
          doc={doc}
          content={content}
          onChange={setContent}
          onClose={() => setIsEditing(false)}
        />
      ) : (
        <main className="flex-1 flex gap-8 lg:gap-12 px-4 sm:px-6 lg:px-12 xl:px-16 py-6 sm:py-10 max-w-[1400px] w-full mx-auto">
          <TableOfContents content={content} />

          <div className="flex-1 min-w-0">
            <DocHero project={project} docLabel={doc.label} />
            <MarkdownView content={content} />

            <PageActions
              doc={doc}
              project={project}
              isModified={isModified}
              onEdit={() => setIsEditing(true)}
              onReset={reset}
            />
          </div>
        </main>
      )}
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
 * page-level actions (edit / open PR / view repo / reset local edits) so
 * the top bar stays clean and the layout works on narrow screens.
 */
function PageActions({
  doc,
  project,
  isModified,
  onEdit,
  onReset,
}: {
  doc: Document;
  project: Project;
  isModified: boolean;
  onEdit: () => void;
  onReset: () => void;
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
            {isModified ? (
              <span className="ml-2 text-[var(--danger)]">· local-edit</span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
          <a href={REPO_BASE} target="_blank" rel="noreferrer" className="dg-button">
            ↗ github
          </a>
          <button type="button" onClick={onEdit} className="dg-button is-primary">
            ✎ edit
          </button>
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
