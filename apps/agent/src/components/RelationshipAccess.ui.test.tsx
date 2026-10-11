// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelationshipAccess, type RelationshipAccessHandle } from './RelationshipAccess';

const auth = vi.hoisted(() => ({
  account: 'alice' as string | null,
  items: [] as Array<{ id: string; aiNickname: string }>,
  permission: vi.fn(() => true),
  ensure: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => auth.account,
  listCharacterRelationships: async () => ({ items: auth.items }),
  ensureCharacterRelationship: auth.ensure,
  subscribeAuthChanges: (fn: () => void) => {
    auth.listeners.add(fn);
    return () => auth.listeners.delete(fn);
  },
}));
vi.mock('@0xnullai/auth/appearance-react', () => ({
  CharacterPortrait: () => <span aria-label="角色形象" />,
  useSelectedCharacterAppearance: () => null,
  useCharacterAppearance: () => null,
}));
vi.mock('./RelationshipPanel', async () => {
  const { useState } = await import('react');
  return {
    RelationshipPanel: () => {
      const [text, setText] = useState('');
      return (
        <input aria-label="专属关系草稿" value={text} onChange={(e) => setText(e.target.value)} />
      );
    },
  };
});

vi.mock('@0xnullai/settings', () => ({
  deviceConversationAccess: () => false,
  setDeviceConversationAccess: auth.permission,
  subscribeDeviceConversationAccess: () => () => undefined,
}));
vi.mock('./MemoryReviewPanel', async () => {
  const { AdvancedSettings } = await import('./AdvancedSettings');
  return {
    MemoryReviewPanel: () => (
      <>
        <p>记忆编辑内容</p>
        <AdvancedSettings>
          <p>记忆层级内容</p>
        </AdvancedSettings>
      </>
    ),
  };
});
vi.mock('./MemoryFactTools', async () => {
  const { AdvancedSettings } = await import('./AdvancedSettings');
  return {
    MemoryFactTools: () => (
      <AdvancedSettings>
        <p>人物别名与事实纠错</p>
      </AdvancedSettings>
    ),
  };
});
vi.mock('./CompanionLifePanel', () => ({ CompanionLifePanel: () => <p>重要人物内容</p> }));
vi.mock('./CharacterAppearancePanel', () => ({
  CharacterAppearancePanel: () => <p>形象编辑内容</p>,
}));
vi.mock('./CompanionSchedulePanel', () => ({ CompanionSchedulePanel: () => <p>定时编辑内容</p> }));
vi.mock('./AgentWorkspacePanel', () => ({ AgentWorkspacePanel: () => <p>任务编辑内容</p> }));
vi.mock('./CompanionMediaPanel', () => ({ CompanionMediaPanel: () => <p>媒体编辑内容</p> }));

afterEach(() => {
  cleanup();
  auth.account = 'alice';
  auth.items = [];
  auth.permission.mockClear();
  auth.ensure.mockReset();
  auth.ensure.mockRejectedValue(new Error('not available'));
  auth.listeners.clear();
});

describe('专属关系入口', () => {
  it('账号切换清除上一账号草稿，退出登录不再显示关系编辑器', () => {
    render(<RelationshipAccess characterId="gentle" characterName="小岚" />);
    fireEvent.click(screen.getByRole('button', { name: /聊天设置/ }));
    fireEvent.click(screen.getByRole('button', { name: /^称呼与关系/ }));
    fireEvent.change(screen.getByLabelText('专属关系草稿'), { target: { value: '私人约定' } });
    act(() => {
      auth.account = 'bob';
      auth.listeners.forEach((fn) => fn());
    });
    expect(screen.queryByLabelText('专属关系草稿')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^称呼与关系/ }));
    expect((screen.getByLabelText('专属关系草稿') as HTMLInputElement).value).toBe('');
    act(() => {
      auth.account = null;
      auth.listeners.forEach((fn) => fn());
    });
    expect(screen.queryByLabelText('专属关系草稿')).toBeNull();
    expect(screen.getByText(/登录后可保存专属关系/)).toBeTruthy();
  });
});

it('分组入口保留所有功能，只挂载当前二级页并可返回', async () => {
  auth.items = [{ id: 'r', aiNickname: '小星' }];
  await act(async () =>
    render(
      <RelationshipAccess characterId="gentle" characterName="小岚" conversationId="session" />,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: /聊天设置/ }));
  for (const name of [
    '称呼与关系',
    '记忆',
    '头像与形象',
    '定时消息',
    '任务与文件',
    '图片与视频',
    '设备权限',
  ])
    expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy();
  expect(document.querySelector('details')).toBeNull();
  expect(screen.queryByText('记忆编辑内容')).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^记忆/ })));
  expect(screen.getByText('记忆编辑内容')).toBeTruthy();
  expect(screen.getByText('重要人物内容')).toBeTruthy();
  // Core rows first, then one flat 高级 section that every panel on the page fills.
  const advanced = screen.getAllByRole('region', { name: '高级' });
  expect(advanced).toHaveLength(1);
  expect(within(advanced[0]!).getByText('记忆层级内容')).toBeTruthy();
  expect(within(advanced[0]!).getByText('人物别名与事实纠错')).toBeTruthy();
  expect(within(advanced[0]!).queryByText('重要人物内容')).toBeNull();
  expect(document.querySelector('details')).toBeNull();
  expect(screen.queryByText('形象编辑内容')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回聊天设置' }));
  expect(screen.queryByText('记忆编辑内容')).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: /^头像与形象/ })),
  );
  expect(screen.getByText('形象编辑内容')).toBeTruthy();
});

it('generation request opens the media detail directly and settings returns to overview', async () => {
  auth.items = [{ id: 'r', aiNickname: '小星' }];
  const ref = createRef<RelationshipAccessHandle>();
  render(
    <RelationshipAccess
      ref={ref}
      characterId="gentle"
      characterName="小岚"
      conversationId="session"
    />,
  );
  await act(async () => {
    ref.current?.openMedia();
  });
  expect(screen.getByText('媒体编辑内容')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回聊天设置' }));
  expect(screen.queryByText('媒体编辑内容')).toBeNull();
  expect(screen.getByRole('button', { name: /^图片与视频/ })).toBeTruthy();
});
it('设备权限在二级页仍绑定当前账户和会话，缺少关系的入口保留条件提示', () => {
  render(<RelationshipAccess characterId="gentle" characterName="小岚" conversationId="session" />);
  fireEvent.click(screen.getByRole('button', { name: /聊天设置/ }));
  expect(
    (screen.getByRole('button', { name: /^头像与形象/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^设备权限/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: '允许这段聊天控制设备' }));
  expect(auth.permission).toHaveBeenCalledWith('alice', 'ai', 'session', true);
  expect(screen.getByText(/停止始终可用/)).toBeTruthy();
});

it('opens chat settings from the name and picks a scene there', () => {
  const onSceneChange = vi.fn();
  render(
    <RelationshipAccess
      characterId="gentle"
      characterName="小岚"
      conversationId="session"
      scenes={[
        { id: 'forest', name: '森林' },
        { id: 'city', name: '城市' },
      ]}
      sceneId="forest"
      onSceneChange={onSceneChange}
    />,
  );
  expect(screen.getAllByRole('button', { name: /聊天设置/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '小岚 · 聊天设置' }));
  fireEvent.click(screen.getByRole('button', { name: /场景.*森林/ }));
  fireEvent.click(screen.getByRole('button', { name: '城市' }));
  expect(onSceneChange).toHaveBeenCalledWith('city');
  fireEvent.click(screen.getByRole('button', { name: '无场景' }));
  expect(onSceneChange).toHaveBeenLastCalledWith(null);
});
