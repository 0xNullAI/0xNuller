import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSection, SidebarSectionsProvider } from '@0xnullai/ui';
import { Sidebar } from './Sidebar';

function TestSidebar({ onNavigate = vi.fn() }: { onNavigate?: (id: string | null) => void }) {
  return (
    <Sidebar
      activeId={null}
      onNavigate={onNavigate}
      user={null}
      onOpenAccount={vi.fn()}
      onOpenContacts={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenDocs={vi.fn()}
      collapsed={false}
      onToggleCollapsed={vi.fn()}
    />
  );
}

describe('Sidebar 默认入口', () => {
  it('首次打开时直接显示新对话、房间和公开大厅', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarSectionsProvider>
        <TestSidebar onNavigate={onNavigate} />
      </SidebarSectionsProvider>,
    );

    expect(screen.getByRole('heading', { name: '对话' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '房间' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(onNavigate).toHaveBeenCalledWith('agent');
    fireEvent.click(screen.getByRole('button', { name: /公开大厅/ }));
    expect(onNavigate).toHaveBeenCalledWith('chat');
  });

  it('模块打开后由完整列表接管同一分组', async () => {
    render(
      <SidebarSectionsProvider>
        <TestSidebar />
        <SidebarSection id="conversations" title="对话">
          <button type="button">模块会话列表</button>
        </SidebarSection>
        <SidebarSection id="rooms" title="房间">
          <button type="button">模块房间列表</button>
        </SidebarSection>
      </SidebarSectionsProvider>,
    );

    expect(await screen.findByRole('button', { name: '模块会话列表' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '模块房间列表' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: /公开大厅/ })).toBeNull();
  });
});
