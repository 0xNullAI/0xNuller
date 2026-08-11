import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, SESSION_TITLE_METADATA_KEY } from '@dg-agent/core';
import type { SessionSnapshot } from '@dg-agent/core';
import { ShellSessionList } from '../../agent/src/components/ShellSessionList';

function session(id: string, content?: string, customTitle?: string): SessionSnapshot {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    deviceState: createEmptyDeviceState(),
    messages: content ? [{ id: `${id}-m1`, role: 'user', content, createdAt: 1 }] : [],
    metadata: customTitle ? { [SESSION_TITLE_METADATA_KEY]: customTitle } : undefined,
  };
}

function renderList(sessions: SessionSnapshot[], onRename = vi.fn(), onDelete = vi.fn()) {
  render(
    <ShellSessionList
      sessions={sessions}
      activeId={sessions[0]?.id ?? null}
      onSelect={vi.fn()}
      onRename={onRename}
      onDelete={onDelete}
      onCreate={vi.fn()}
    />,
  );
  return { onRename, onDelete };
}

describe('Agent 统一侧边栏会话', () => {
  it('支持在侧边栏直接重命名', () => {
    const onRename = vi.fn();
    renderList([session('s1', '原始标题')], onRename);

    fireEvent.click(screen.getByRole('button', { name: '重命名 原始标题' }));
    const input = screen.getByRole('textbox', { name: '重命名 原始标题' });
    fireEvent.change(input, { target: { value: '新的标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('s1', '新的标题');
  });

  it('删除最后一条后不把承接输入的空会话伪装成历史对话', () => {
    const { rerender } = render(
      <ShellSessionList
        sessions={[session('last', '最后一条')]}
        activeId="last"
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByText('最后一条')).toBeTruthy();

    rerender(
      <ShellSessionList
        sessions={[session('empty-replacement')]}
        activeId="empty-replacement"
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '删除 新对话' })).toBeNull();
    expect(screen.getByText('暂无会话')).toBeTruthy();
  });

  it('保留显式命名的空会话', () => {
    renderList([session('named-empty', undefined, '稍后继续')]);
    expect(screen.getByText('稍后继续')).toBeTruthy();
  });
});
