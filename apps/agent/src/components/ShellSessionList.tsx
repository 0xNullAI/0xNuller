import { Plus, Trash2 } from 'lucide-react';
import type { SessionSnapshot } from '@dg-agent/core';
import { getSessionTitle } from '@agent/utils/ui-formatters';

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
  onDelete: (id: string) => void;
  onCreate: () => void;
}

export function ShellSessionList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onCreate,
}: ShellSessionListProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
      >
        <Plus className="h-4 w-4 shrink-0" />
        新对话
      </button>

      {sessions.map((session) => (
        <div
          key={session.id}
          className={
            'group flex items-center gap-1 rounded-[10px] pr-1 transition-colors ' +
            (session.id === activeId ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-soft)]')
          }
        >
          <button
            type="button"
            onClick={() => onSelect(session.id)}
            className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
            title={getSessionTitle(session)}
          >
            {getSessionTitle(session)}
          </button>
          <button
            type="button"
            onClick={() => onDelete(session.id)}
            aria-label={`删除 ${getSessionTitle(session)}`}
            // Always showing it would make the list look like a row of delete buttons;
            // it only appears on hover/focus, but keyboard users still reach it through
            // focus-visible.
            className="shrink-0 rounded-[8px] p-1.5 text-[var(--text-faint)] opacity-0 transition-opacity hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {sessions.length === 0 && (
        <p className="px-2 py-3 text-xs text-[var(--text-faint)]">还没有保存的会话</p>
      )}
    </div>
  );
}
