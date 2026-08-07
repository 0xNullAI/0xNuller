import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot } from '@dg-agent/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTimestamp, getSessionPreview, getSessionTitle } from '../utils/ui-formatters.js';

interface SessionSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSnapshot[];
  onSelectSession: (sessionId: string) => void;
}

export function SessionSearchDialog({
  open,
  onOpenChange,
  sessions,
  onSelectSession,
}: SessionSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return sessions.filter((session) => {
      const title = getSessionTitle(session).toLowerCase();
      if (title.includes(trimmed)) return true;
      return session.messages.some(
        (msg) => typeof msg.content === 'string' && msg.content.toLowerCase().includes(trimmed),
      );
    });
  }, [sessions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [results.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      onSelectSession(results[activeIndex].id);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/38 backdrop-blur-[1.5px] animate-in fade-in-0 duration-150" />
        <DialogPrimitive.Content
          className="fixed inset-x-4 top-[max(env(safe-area-inset-top),9vh)] z-50 mx-auto max-w-[500px] overflow-hidden rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-soft)] animate-in fade-in-0 slide-in-from-top-2 duration-200"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onKeyDown={handleKeyDown}
        >
          <DialogPrimitive.Title className="sr-only">搜索历史对话</DialogPrimitive.Title>

          <div className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div className="text-sm font-semibold tracking-[0.01em] text-[var(--text-faint)]">
                搜索历史对话
              </div>
              <DialogPrimitive.Close className="scale-90 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">
                <X className="h-4 w-4" />
                <span className="sr-only">关闭</span>
              </DialogPrimitive.Close>
            </div>
            <div className="flex h-8 items-center gap-2 rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3">
              <Search className="h-4 w-4 shrink-0 text-[var(--text-faint)] mt-[0.1em]" />
              <input
                ref={inputRef}
                type="text"
                placeholder="历史对话内容"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 pl-0.5 !text-xs leading-none text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-faint)] focus:border-0 focus:shadow-none"
                style={{
                  paddingTop: 0,
                  paddingRight: 0,
                  paddingBottom: 0,
                  paddingLeft: '2px',
                  border: 0,
                  background: 'transparent',
                  boxShadow: 'none',
                }}
              />
            </div>
          </div>

          {/* Results */}
          <div className="max-h-[min(50vh,360px)] overflow-y-auto border-t border-[var(--surface-border)]">
            {query.trim() && results.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-[var(--text-faint)]">
                <Search className="h-7 w-7 opacity-30" />
                <span className="text-sm">没有匹配的对话</span>
              </div>
            )}
            {!query.trim() && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-[var(--text-faint)]">
                <span className="text-sm">输入关键词搜索历史对话</span>
              </div>
            )}
            {results.length > 0 && (
              <div className="p-1.5">
                {results.map((session, index) => (
                  <button
                    key={session.id}
                    type="button"
                    className={cn(
                      'w-full rounded-[8px] px-3 py-2 text-left transition-colors',
                      index === activeIndex
                        ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                        : 'text-[var(--text)] hover:bg-[var(--bg-soft)]',
                    )}
                    onClick={() => onSelectSession(session.id)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">
                          {getSessionTitle(session)}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                          {getSessionPreview(session)}
                        </div>
                      </div>
                      <div className="shrink-0 pt-0.5 text-[11px] text-[var(--text-faint)]">
                        {formatTimestamp(session.updatedAt)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
