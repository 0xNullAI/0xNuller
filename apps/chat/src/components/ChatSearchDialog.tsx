import { Overlay } from '@0xnullai/ui';
import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatSearchHit } from '../hooks/use-peer-room';

interface ChatSearchDialogProps {
  onSearch: (query: string) => Promise<ChatSearchHit[]>;
  onPick: (id: string) => void;
  onClose: () => void;
}

function formatHitTime(ts: number): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Mark every case-insensitive occurrence of the query inside a short excerpt. */
function highlight(text: string, query: string): React.ReactNode {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const first = lower.indexOf(needle);
  // Long messages start just before the first match so the match is visible.
  const start = first > 24 ? first - 12 : 0;
  const excerpt = (start ? '…' : '') + text.slice(start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const haystack = excerpt.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, cursor)) {
    if (at > cursor) parts.push(excerpt.slice(cursor, at));
    parts.push(
      <mark key={at} className="rounded bg-[var(--accent-soft)] text-[var(--text)]">
        {excerpt.slice(at, at + needle.length)}
      </mark>,
    );
    cursor = at + needle.length;
  }
  parts.push(excerpt.slice(cursor));
  return parts;
}

export function ChatSearchDialog({ onSearch, onPick, onClose }: ChatSearchDialogProps) {
  const [query, setQuery] = useState('');
  // Results are tagged with their query so a stale answer is never shown for a newer one.
  const [result, setResult] = useState<{
    query: string;
    hits: ChatSearchHit[] | null;
    error: string | null;
  } | null>(null);
  const trimmed = query.trim();
  // The caller's function is recreated on every render; only the query should re-run a search.
  const searchRef = useRef(onSearch);
  useEffect(() => {
    searchRef.current = onSearch;
  });

  useEffect(() => {
    if (!trimmed) return;
    let current = true;
    const timer = window.setTimeout(() => {
      searchRef.current(trimmed).then(
        (hits) => {
          if (current) setResult({ query: trimmed, hits, error: null });
        },
        (reason: unknown) => {
          if (current)
            setResult({
              query: trimmed,
              hits: null,
              error: reason instanceof Error ? reason.message : '搜索失败',
            });
        },
      );
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed]);
  const shown = trimmed && result?.query === trimmed ? result : null;
  const hits = shown?.hits ?? null;
  const error = shown?.error ?? null;

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-label="搜索聊天记录"
        className="flex max-h-[80dvh] w-[min(480px,100%)] flex-col gap-3 rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4"
      >
        <div className="flex items-center gap-2 rounded-lg border border-[var(--surface-border)] bg-[var(--bg)] px-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
          <input
            autoFocus
            value={query}
            maxLength={64}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索聊天记录"
            aria-label="搜索聊天记录"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ui-press -mr-1 rounded-full p-1 text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <p className="px-1 text-sm text-[var(--danger)]">{error}</p>}
          {hits?.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-[var(--text-faint)]">没有找到</p>
          )}
          {hits?.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={() => onPick(hit.id)}
              className="ui-press block w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--bg-soft)]"
            >
              <span className="flex items-baseline justify-between gap-2 text-xs text-[var(--text-faint)]">
                <span className="truncate">{hit.fromSelf ? '我' : hit.senderName || '对方'}</span>
                <span className="shrink-0">{formatHitTime(hit.timestamp)}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-sm whitespace-pre-wrap">
                {highlight(hit.text, trimmed)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
