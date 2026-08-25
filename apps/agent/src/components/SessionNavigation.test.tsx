// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import type { ReactNode } from 'react';
import type * as UiModule from '@0xnullai/ui';
import { SessionNavigation } from './SessionNavigation.js';

vi.mock('@0xnullai/ui', async () => {
  const actual = await vi.importActual<typeof UiModule>('@0xnullai/ui');
  return {
    ...actual,
    Sheet: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) =>
      open ? (
        <div data-testid="mobile-sheet">
          <button type="button" onClick={() => onOpenChange(false)}>
            dismiss sheet
          </button>
          {children}
        </div>
      ) : null,
    SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SheetClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
    SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
    SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    SidebarSection: ({
      id,
      title,
      children,
    }: {
      id: string;
      title: string;
      children: ReactNode;
    }) => (
      <section data-testid={`shell-${id}`} aria-label={title}>
        {children}
      </section>
    ),
  };
});

const session: SessionSnapshot = {
  id: 'session-1',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'message-1', role: 'user', content: 'Session One', createdAt: 1 }],
  deviceState: createEmptyDeviceState(),
};

afterEach(cleanup);

describe('SessionNavigation', () => {
  it('adapts the standalone desktop sidebar controls without owning session lifecycle', () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onOpenSettings = vi.fn();
    const onToggleCollapsed = vi.fn();

    render(
      <SessionNavigation
        variant="desktop"
        sessions={[session]}
        activeSessionId={session.id}
        collapsed={false}
        onToggleCollapsed={onToggleCollapsed}
        onSelect={onSelect}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreate={onCreate}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByText('Session One'));
    fireEvent.click(screen.getByText('新对话'));
    fireEvent.click(screen.getByText('设置'));
    fireEvent.click(screen.getByLabelText('收起侧边栏'));

    expect(onSelect).toHaveBeenCalledWith(session.id);
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it('shows the detached mobile history only while open and delegates dismissal', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <SessionNavigation
        variant="mobile"
        sessions={[session]}
        activeSessionId={session.id}
        open={false}
        onOpenChange={onOpenChange}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('mobile-sheet')).toBeNull();
    rerender(
      <SessionNavigation
        variant="mobile"
        sessions={[session]}
        activeSessionId={session.id}
        open={true}
        onOpenChange={onOpenChange}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('历史记录')).not.toBeNull();
    fireEvent.click(screen.getByText('dismiss sheet'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('projects the shell list under conversations and preserves its actions', () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const onCreate = vi.fn();

    render(
      <SessionNavigation
        variant="shell"
        sessions={[session]}
        activeSessionId={session.id}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
        onCreate={onCreate}
      />,
    );

    expect(screen.getByTestId('shell-conversations').getAttribute('aria-label')).toBe('对话');
    fireEvent.click(screen.getByText('Session One'));
    fireEvent.click(screen.getByText('新对话'));
    fireEvent.click(screen.getByLabelText('删除 Session One'));

    expect(onSelect).toHaveBeenCalledWith(session.id);
    expect(onRename).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith(session.id);
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
