import { useEffect, useMemo, useState } from 'react';

interface TocEntry {
  id: string;
  level: 2 | 3;
  text: string;
}

/**
 * Auto-generated table of contents from the rendered Markdown's `<h2>` and
 * `<h3>` headings. Live-updates as the user scrolls to highlight the
 * currently visible section.
 */
export function TableOfContents({ content }: { content: string }) {
  const entries = useMemo(() => extract(content), [content]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // After the markdown re-renders, attach `id` attributes to the headings so
  // anchor jumps work, then watch which one is in view.
  useEffect(() => {
    const root = document.querySelector('.markdown-body');
    if (!root) return;

    const headings = root.querySelectorAll('h2, h3');
    headings.forEach((h, i) => {
      const e = entries[i];
      if (!e) return;
      h.id = e.id;
    });

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((r) => r.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) {
          setActiveId(visible.target.id);
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [content, entries]);

  if (entries.length === 0) {
    return null;
  }

  return (
    <aside className="hidden lg:block w-[220px] shrink-0 sticky top-[120px] self-start max-h-[calc(100vh-200px)] overflow-y-auto pr-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-3 pl-2">
        ── 目录
      </div>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              onClick={(ev) => {
                ev.preventDefault();
                document.getElementById(e.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setActiveId(e.id);
              }}
              className={[
                'block text-[12.5px] leading-snug py-1 px-2 border-l-2 transition-colors',
                e.level === 3 ? 'pl-5' : '',
                activeId === e.id
                  ? 'border-[var(--accent)] text-[var(--text)] bg-[var(--bg-strong)]'
                  : 'border-transparent text-[var(--text-soft)] hover:text-[var(--accent-strong)] hover:border-[var(--surface-border-strong)]',
              ].join(' ')}
            >
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
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
