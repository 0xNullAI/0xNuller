import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { SessionSnapshot } from '@dg-agent/core';
import { getSessionTitle, isSessionListEntry } from '@agent/utils/ui-formatters';

/**
 * The session list as it looks inside the **shell sidebar**.
 *
 * The difference from `SessionPanel` is more than styling: that one is the full
 * chrome of the module's own sidebar (title, collapse, settings entry), this one
 * is just a list — title, section and collapsing are all owned by the shell.
 * Three modules each drawing their own list is how we end up back at "five
 * separate UIs".
 */

export interface ShellSessionListProps {
  sessions: SessionSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string | null) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}

export function ShellSessionList({
  sessions,
  activeId,
  onSelect,
  onRename,
  onDelete,
  onCreate,
}: ShellSessionListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const visibleSessions = sessions.filter(isSessionListEntry);

  const startRename = (session: SessionSnapshot) => {
    setRenamingId(session.id);
    setRenameDraft(getSessionTitle(session));
  };

  const finishRename = (session: SessionSnapshot) => {
    const normalized = renameDraft.trim();
    if (normalized !== getSessionTitle(session)) {
      onRename(session.id, normalized || null);
    }
    setRenamingId(null);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-2 rounded-[var(--radius-ctl)] px-2 py-1.5 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
      >
        <Plus className="h-4 w-4 shrink-0" />
        新对话
      </button>

      {visibleSessions.map((session) => (
        <div
          key={session.id}
          className={
            'group flex items-center gap-1 rounded-[var(--radius-ctl)] pr-1 transition-colors ' +
            (session.id === activeId ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-soft)]')
          }
        >
          {renamingId === session.id ? (
            <input
              autoFocus
              value={renameDraft}
              maxLength={60}
              aria-label={`重命名 ${getSessionTitle(session)}`}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={() => finishRename(session)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  finishRename(session);
                } else if (event.key === 'Escape') {
                  setRenamingId(null);
                }
              }}
              className="min-w-0 flex-1 rounded-[var(--radius-xs)] border border-[var(--accent)] bg-[var(--bg)] px-2 py-1 text-sm outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => startRename(session)}
              className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
              title={getSessionTitle(session)}
            >
              {getSessionTitle(session)}
            </button>
          )}
          <button
            type="button"
            onClick={() => startRename(session)}
            aria-label={`重命名 ${getSessionTitle(session)}`}
            className={
              'shrink-0 rounded-[var(--radius-xs)] p-1.5 text-[var(--text-faint)] transition-opacity hover:bg-[var(--bg-strong)] hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100 ' +
              (session.id === activeId ? 'opacity-60' : 'opacity-0')
            }
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(session.id)}
            aria-label={`删除 ${getSessionTitle(session)}`}
            // Keep actions discoverable on the active row, including touch screens.
            // Inactive rows reveal them on hover/focus to keep the list quiet.
            className={
              'shrink-0 rounded-[var(--radius-xs)] p-1.5 text-[var(--text-faint)] transition-opacity hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100 ' +
              (session.id === activeId ? 'opacity-60' : 'opacity-0')
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {visibleSessions.length === 0 && (
        <p className="px-2 py-3 text-xs text-[var(--text-faint)]">暂无会话</p>
      )}
    </div>
  );
}
