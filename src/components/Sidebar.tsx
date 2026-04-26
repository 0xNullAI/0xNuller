import { PAGES, type PageMeta } from '../lib/pages';
import { Waveform } from './Waveform';

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  isModified: (id: string) => boolean;
}

const accentClass: Record<PageMeta['accent'], string> = {
  cyan: 'group-hover:text-[var(--accent-strong)]',
  magenta: 'group-hover:text-[var(--danger)]',
  amber: 'group-hover:text-[var(--highlight)]',
};

const accentBar: Record<PageMeta['accent'], string> = {
  cyan: 'bg-[var(--accent-strong)]',
  magenta: 'bg-[var(--danger)]',
  amber: 'bg-[var(--highlight)]',
};

export function Sidebar({ active, onNavigate, isModified }: SidebarProps) {
  return (
    <aside className="w-[260px] shrink-0 border-r border-[var(--surface-border)] bg-[var(--bg)] flex flex-col">
      {/* Header — wordmark + tagline + waveform */}
      <header className="px-6 py-7 border-b border-[var(--surface-border)] reveal">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            wiki
          </span>
          <span className="font-mono text-[10px] text-[var(--accent-strong)]" style={{ animation: 'glow 2s ease-in-out infinite' }}>
            ●
          </span>
        </div>
        <h1
          className="font-display font-black tracking-tight leading-none mb-3"
          style={{ fontSize: '2.4rem' }}
        >
          DG·WIKI
        </h1>
        <Waveform width={210} height={20} className="w-full h-5" />
        <p className="font-mono text-[11px] text-[var(--text-soft)] mt-3 leading-snug">
          四个项目，一份手册。<br />
          <span className="text-[var(--text-faint)]">documentation hub for the dg ecosystem</span>
        </p>
      </header>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4">
        <div className="px-6 mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
          ── pages
        </div>
        <ul className="flex flex-col">
          {PAGES.map((page) => {
            const isActive = page.id === active;
            const dirty = isModified(page.id);
            return (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(page.id)}
                  className={[
                    'group relative w-full text-left pl-6 pr-4 py-3 transition-colors',
                    'border-l-2',
                    isActive
                      ? 'border-[var(--accent-strong)] bg-[var(--bg-strong)]'
                      : 'border-transparent hover:bg-[var(--bg-strong)]',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-[10px] tracking-[0.15em] text-[var(--text-faint)]">
                        {page.kicker}
                      </span>
                      <span
                        className={[
                          'font-display text-xl font-bold tracking-wide leading-none',
                          isActive ? '' : accentClass[page.accent],
                          'transition-colors',
                        ].join(' ')}
                      >
                        {page.label.toUpperCase()}
                      </span>
                    </div>
                    {dirty ? (
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${accentBar[page.accent]}`}
                        style={{ animation: 'glow 1.4s ease-in-out infinite' }}
                        title="本地有未提交的修改"
                      />
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <footer className="px-6 py-4 border-t border-[var(--surface-border)]">
        <div className="font-mono text-[10px] text-[var(--text-faint)] space-y-1">
          <div className="flex justify-between">
            <span>build</span>
            <span className="text-[var(--text-soft)]">v0.1.0</span>
          </div>
          <div className="flex justify-between">
            <span>license</span>
            <span className="text-[var(--text-soft)]">MIT</span>
          </div>
          <div className="flex justify-between">
            <span>maintained</span>
            <a
              className="text-[var(--accent-strong)] hover:text-[var(--danger)]"
              href="https://github.com/0xNullAI"
              target="_blank"
              rel="noreferrer"
            >
              0xNullAI
            </a>
          </div>
        </div>
      </footer>
    </aside>
  );
}
