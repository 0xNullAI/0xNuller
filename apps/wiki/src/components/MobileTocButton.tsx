import { useEffect, useMemo, useRef, useState } from 'react';

interface TocEntry {
  id: string;
  level: 2 | 3;
  text: string;
}

/**
 * Mobile-only TOC trigger. Renders a small icon button (sized to match the
 * theme toggle next to it). Tapping it opens a dropdown anchored to the
 * button with the same h2/h3 entries the desktop sidebar shows.
 *
 * The desktop sidebar is the one that owns attaching `id`s to the
 * rendered headings (and observing visibility), so this component only
 * needs to read the same source markdown and emit anchor links.
 */
export function MobileTocButton({ content }: { content: string }) {
  const entries = useMemo(() => extract(content), [content]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  if (entries.length === 0) return null;

  return (
    <div ref={ref} className="relative lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="目录"
        title="目录"
        className="dg-button w-9 shrink-0"
        style={{ padding: '0.55em 0' }}
      >
        <span className="block w-full text-center">☰</span>
      </button>

      {open ? (
        <div
          className="absolute top-full mt-1 right-0 w-[280px] max-w-[calc(100vw-2rem)] z-40 dg-card overflow-hidden"
          style={{ boxShadow: 'var(--shadow-panel)' }}
        >
          <div className="px-4 py-2.5 border-b border-[var(--surface-border)] flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)]">
              目录 · {entries.length}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="font-mono text-[10px] text-[var(--text-faint)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
          <ul className="px-2 py-2 max-h-[60vh] overflow-y-auto">
            {entries.map((e) => (
              <li key={e.id}>
                <a
                  href={`#${e.id}`}
                  onClick={(ev) => {
                    ev.preventDefault();
                    document
                      .getElementById(e.id)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    setOpen(false);
                  }}
                  className={[
                    'block text-[13px] leading-snug py-1.5 px-2 border-l-2 border-transparent transition-colors',
                    e.level === 3 ? 'pl-6 text-[12.5px]' : '',
                    'text-[var(--text-soft)] hover:text-[var(--accent-strong)] hover:border-[var(--surface-border-strong)]',
                  ].join(' ')}
                >
                  {e.text}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function extract(md: string): TocEntry[] {
  const lines = md.split('\n');
  const out: TocEntry[] = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1]!.length as 2 | 3;
    const text = match[2]!.trim();
    out.push({
      id: slugify(text) + '-' + out.length,
      level,
      text,
    });
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}
