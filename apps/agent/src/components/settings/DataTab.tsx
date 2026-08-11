import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button, Checkbox } from '@0xnullai/ui';
import { formatTimestamp } from '../../utils/ui-formatters.js';

export interface ExportableSession {
  id: string;
  title: string;
  updatedAt: number;
}

export interface DataTabProps {
  sessions: ExportableSession[];
  onExport: (sessionIds: string[]) => void;
  onImport: (file: File) => void;
}

export function DataTab({ sessions, onExport, onImport }: DataTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Default to everything selected; falls back gracefully if the list changes.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(sessions.map((s) => s.id)));

  const selectableIds = sessions.map((s) => s.id);
  const selectedCount = selectableIds.filter((id) => selected.has(id)).length;
  const allSelected = sessions.length > 0 && selectedCount === sessions.length;

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] p-3 sm:p-4">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--surface-border)] pb-3">
          <h3 className="text-sm font-semibold text-[var(--text)]">聊天记录</h3>
          {sessions.length > 0 && (
            <span className="shrink-0 rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--text-faint)]">
              {selectedCount} / {sessions.length}
            </span>
          )}
        </div>
        {sessions.length === 0 ? (
          <div className="py-3 text-center text-sm text-[var(--text-faint)]">暂无聊天记录</div>
        ) : (
          <>
            <label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[var(--radius-xs)] px-2 text-[13px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              <span>全选</span>
            </label>

            <div className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto border-y border-[var(--surface-border)] py-1">
              {sessions.map((session) => (
                <label
                  key={session.id}
                  className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[var(--radius-xs)] px-2 transition-colors hover:bg-[var(--bg-soft)]"
                >
                  <Checkbox
                    checked={selected.has(session.id)}
                    onCheckedChange={() => toggle(session.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
                    {session.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--text-faint)]">
                    {formatTimestamp(session.updatedAt)}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onExport(selectableIds.filter((id) => selected.has(id)))}
            disabled={selectedCount === 0}
            className="!inline-flex whitespace-nowrap"
          >
            <Download className="h-4 w-4" />
            导出{selectedCount > 0 ? `（${selectedCount}）` : ''}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            className="!inline-flex whitespace-nowrap"
          >
            <Upload className="h-4 w-4" />
            导入
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip,application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = '';
          }}
        />
      </section>
    </div>
  );
}
