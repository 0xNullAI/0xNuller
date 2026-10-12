import type { ReactNode } from 'react';

/**
 * The Markdown subset the legal texts are written in: `##`/`###` headings, `- ` lists, `> `
 * notes, paragraphs (single line breaks kept) and `**bold**`. Small on purpose — the texts are
 * our own constants, and a full Markdown library would be a dependency for two pages.
 */
export type LegalBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'paragraph'; lines: string[] };

export function parseLegalMarkdown(source: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  for (const chunk of source.split(/\n\s*\n/)) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    const first = lines[0]!;
    if (first.startsWith('### ')) blocks.push({ kind: 'heading', level: 3, text: first.slice(4) });
    else if (first.startsWith('## '))
      blocks.push({ kind: 'heading', level: 2, text: first.slice(3) });
    else if (first.startsWith('> '))
      blocks.push({ kind: 'note', text: lines.map((line) => line.replace(/^>\s?/, '')).join('') });
    else if (first.startsWith('- '))
      blocks.push({ kind: 'list', items: lines.map((line) => line.replace(/^-\s+/, '')) });
    else blocks.push({ kind: 'paragraph', lines });
  }
  return blocks;
}

function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part, index) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={index} className="font-semibold text-[var(--text)]">
          {part.slice(2, -2)}
        </strong>
      ) : (
        part
      ),
    );
}

export function LegalMarkdown({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-6 text-[var(--text-soft)]">
      {parseLegalMarkdown(source).map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return block.level === 2 ? (
              <h3 key={index} className="mt-3 text-base font-semibold text-[var(--text)]">
                {inline(block.text)}
              </h3>
            ) : (
              <h4 key={index} className="mt-1 text-sm font-semibold text-[var(--text)]">
                {inline(block.text)}
              </h4>
            );
          case 'list':
            return (
              <ul key={index} className="flex list-disc flex-col gap-1.5 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'note':
            return (
              <p
                key={index}
                role="note"
                className="rounded-xl bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--text)]"
              >
                {inline(block.text)}
              </p>
            );
          case 'paragraph':
            return (
              <p key={index}>
                {block.lines.map((line, lineIndex) => (
                  <span key={lineIndex} className="block">
                    {inline(line)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
