import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSection, SidebarSectionsProvider } from '@0xnullai/ui';
import { Sidebar } from './Sidebar';

function TestSidebar({
  onNavigate = vi.fn(),
  signedIn = false,
}: {
  onNavigate?: (id: string | null) => void;
  signedIn?: boolean;
}) {
  return (
    <Sidebar
      activeId={null}
      onNavigate={onNavigate}
      user={signedIn ? { id: 'u1', username: 'alice', displayName: 'Alice' } : null}
      onOpenAccount={vi.fn()}
      onOpenContacts={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenDocs={vi.fn()}
      onCreateRoom={vi.fn()}
      collapsed={false}
      onToggleCollapsed={vi.fn()}
    />
  );
}

describe('Sidebar 默认入口', () => {
  it('未登录时显示新对话，但 Chat 入口要求登录', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarSectionsProvider>
        <TestSidebar onNavigate={onNavigate} />
      </SidebarSectionsProvider>,
    );

    expect(screen.getByRole('heading', { name: '对话' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeTruthy();
    expect(screen.queryByText('本项目仅供学习交流使用，请遵守当地法律法规。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(onNavigate).toHaveBeenCalledWith('agent');
    expect(screen.getByRole('button', { name: '登录后使用' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /公开大厅/ })).toBeNull();
  });

  it('登录后显示私聊与建房间入口', () => {
    render(
      <SidebarSectionsProvider>
        <TestSidebar signedIn />
      </SidebarSectionsProvider>,
    );
    expect(screen.getByRole('heading', { name: '私聊' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '建房间' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /公开大厅/ })).toBeTruthy();
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
