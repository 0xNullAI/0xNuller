import type { SessionSnapshot } from '@dg-agent/core';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SidebarSection,
} from '@0xnullai/ui';
import { X } from 'lucide-react';
import { SessionPanel } from './SessionPanel.js';
import { ShellSessionList } from './ShellSessionList.js';

interface SessionNavigationCallbacks {
  sessions: SessionSnapshot[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string | null) => void;
  onDelete: (sessionId: string) => void;
  onCreate: () => void;
}

type SessionNavigationProps = SessionNavigationCallbacks &
  (
    | {
        variant: 'mobile';
        open: boolean;
        onOpenChange: (open: boolean) => void;
        onOpenSettings: () => void;
      }
    | {
        variant: 'desktop';
        collapsed: boolean;
        onToggleCollapsed: () => void;
        onOpenSettings: () => void;
      }
    | {
        variant: 'shell';
      }
  );

/**
 * Owns the three visual projections of Agent conversation navigation.
 *
 * Session lifecycle and device-stop ordering remain in App; this component only
 * adapts the same callbacks to the mobile drawer, standalone desktop sidebar,
 * or shell-owned sidebar section.
 */
export function SessionNavigation(props: SessionNavigationProps) {
  const { sessions, activeSessionId, onSelect, onRename, onDelete, onCreate } = props;

  if (props.variant === 'shell') {
    return (
      <SidebarSection id="conversations" title="对话">
        <ShellSessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onCreate={onCreate}
        />
      </SidebarSection>
    );
  }

  if (props.variant === 'desktop') {
    return (
      <aside className="dg-sidebar-shell hidden min-h-0 overflow-hidden border-r border-[var(--surface-border)] lg:block">
        <SessionPanel
          savedSessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelect}
          onRenameSession={onRename}
          onDeleteSession={onDelete}
          onCreateSession={onCreate}
          onOpenSettings={props.onOpenSettings}
          collapsed={props.collapsed}
          onToggleCollapsed={props.onToggleCollapsed}
          detached={false}
        />
      </aside>
    );
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="left"
        className="dg-sidebar-sheet flex h-full w-screen max-w-none flex-col overflow-hidden bg-[var(--bg-elevated)] p-0 pt-[env(safe-area-inset-top)] sm:max-w-[420px] [&>button]:hidden"
      >
        <SheetHeader className="px-5 pt-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle>历史记录</SheetTitle>
              <SheetDescription className="sr-only">
                选择历史对话，或者新建一条会话
              </SheetDescription>
            </div>
            <SheetClose className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-ctl)] border border-[var(--surface-border)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 sm:h-9 sm:w-9">
              <X className="h-5 w-5" />
              <span className="sr-only">关闭</span>
            </SheetClose>
          </div>
        </SheetHeader>
        <div className="mt-1 min-h-0 flex-1">
          <SessionPanel
            savedSessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelect}
            onRenameSession={onRename}
            onDeleteSession={onDelete}
            onCreateSession={onCreate}
            onOpenSettings={props.onOpenSettings}
            detached={true}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
