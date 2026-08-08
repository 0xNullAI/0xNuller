import { Plus, Trash2 } from 'lucide-react';
import type { SessionSnapshot } from '@dg-agent/core';
import { getSessionTitle } from '@agent/utils/ui-formatters';

/**
 * 会话列表在**外壳侧边栏**里的形态。
 *
 * 和 `SessionPanel` 的区别不只是样式：那个是模块自己那条侧栏的完整外壳（含标题、
 * 折叠、设置入口），这个只是一段列表——标题、分区、折叠都归外壳统一掌握。三个模块
 * 各画各的列表就又回到了「五套 UI」。
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
            // 常显会让列表看起来像一排删除按钮；只在悬停/聚焦时出现，但键盘用户
            // 靠 focus-visible 一样能拿到它。
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
