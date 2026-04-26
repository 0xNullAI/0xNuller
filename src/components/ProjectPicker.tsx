import { useEffect, useRef, useState } from 'react';
import { PROJECTS } from '../lib/projects';

interface Props {
  activeId: string;
  onSelect: (id: string) => void;
  isModified: (projectId: string) => boolean;
}

/**
 * Compact dropdown that replaces the old top-level project tabs. Lives in
 * the header so the wiki has a single horizontal bar instead of two.
 */
export function ProjectPicker({ activeId, onSelect, isModified }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = PROJECTS.find((p) => p.id === activeId) ?? PROJECTS[0]!;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)] transition-colors"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-faint)]">
          project
        </span>
        <span className="font-display text-base font-bold tracking-tight text-[var(--text)] leading-none">
          {active.label}
        </span>
        <span
          className={`text-[10px] text-[var(--text-faint)] transition-transform ${open ? 'rotate-180' : ''}`}
        >
          ▼
        </span>
      </button>

      {open ? (
        <div
          className="absolute top-full mt-1 left-0 min-w-[280px] z-40 dg-card overflow-hidden"
          style={{ boxShadow: 'var(--shadow-panel)' }}
        >
          {PROJECTS.map((p) => {
            const isActive = p.id === activeId;
            const dirty = isModified(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
                className={[
                  'w-full text-left flex items-start gap-2 px-4 py-3 transition-colors border-l-2',
                  isActive
                    ? 'border-[var(--accent)] bg-[var(--bg-strong)]'
                    : 'border-transparent hover:bg-[var(--bg-strong)]',
                ].join(' ')}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-display text-lg font-extrabold tracking-tight text-[var(--text)] leading-none">
                      {p.label}
                    </span>
                    {dirty ? (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]"
                        style={{ animation: 'glow 1.4s ease-in-out infinite' }}
                        title="本地有未提交修改"
                      />
                    ) : null}
                  </div>
                  <div className="text-[11px] text-[var(--text-soft)] mt-0.5 leading-snug">
                    {p.tagline}
                  </div>
                </div>
                {isActive ? (
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--accent-strong)] shrink-0">
                    ●
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
