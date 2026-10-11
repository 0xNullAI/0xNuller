import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthUser } from '@0xnullai/auth';
import { UnifiedInbox, currentInboxRowId } from './UnifiedInbox';

const state = vi.hoisted(() => ({
  account: 'alice' as string | null,
  list: vi.fn(),
  read: vi.fn(),
  chat: vi.fn(),
  partial: null as string | null,
  groupCursor: null as string | null,
  groupPageFailed: false,
  dmLoadFailed: false,
  selectAi: vi.fn(),
  newAi: vi.fn(),
  selectChat: vi.fn(),
  authChanged: null as (() => void) | null,
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  subscribeAuthChanges: (listener: () => void) => {
    state.authChanged = listener;
    return () => {
      state.authChanged = null;
    };
  },
  listPrivateConversationSummaries: state.list,
  markPrivateConversationRead: state.read,
  selectAgentInboxConversation: state.selectAi,
  requestNewAgentInboxConversation: state.newAi,
}));
vi.mock('../../chat/src/inbox', () => ({
  loadChatInboxDisplayWithStatus: async (groupPages: number) => ({
    entries: await state.chat(groupPages),
    partialError: state.partial,
    nextGroupCursor: state.groupCursor,
    groupPageFailed: state.groupPageFailed,
    dmLoadFailed: state.dmLoadFailed,
  }),
  selectChatInboxConversation: state.selectChat,
}));

const user = (id: string) => ({ id, username: id, displayName: id }) as AuthUser;

beforeEach(() => {
  state.account = 'alice';
  state.partial = null;
  state.groupCursor = null;
  state.groupPageFailed = false;
  state.dmLoadFailed = false;
  state.list.mockReset();
  state.chat.mockReset();
  state.selectAi.mockReset();
  state.newAi.mockReset();
  state.selectChat.mockReset();
  state.list.mockResolvedValue({
    items: [
      {
        id: 'ai-1',
        deleted: false,
        metadata: { sessionTitle: '小星' },
        preview: '晚安',
        updatedAt: 20,
        lastMessageAt: 20,
      },
    ],
  });
  state.chat.mockResolvedValue([
    {
      id: 'group:g',
      kind: 'group',
      title: '朋友们',
      unread: 2,
      updatedAt: 10,
      selection: { kind: 'group', code: 'g' },
    },
  ]);
});

it('loads more human groups only on request and does not call the first page an empty inbox', async () => {
  state.list.mockResolvedValue({ items: [] });
  state.groupCursor = 'next';
  state.chat.mockImplementation(async (pages: number) => {
    if (pages === 1) return [];
    state.groupCursor = null;
    return [
      {
        id: 'group:older',
        kind: 'group',
        title: '较早群聊',
        unread: null,
        updatedAt: 0,
        selection: { kind: 'group', code: 'older' },
      },
    ];
  });
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  expect(await screen.findByText('还有群聊未加载')).toBeTruthy();
  expect(state.chat).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getByRole('button', { name: '加载更多群聊' }));
  expect(await screen.findByText('较早群聊')).toBeTruthy();
  expect(state.chat).toHaveBeenCalledWith(2);
});

it('keeps a previously displayed group but removes its stale unread action when refresh verification fails', async () => {
  state.list.mockResolvedValue({ items: [] });
  const group = {
    id: 'group:known',
    kind: 'group',
    title: '原群',
    unread: 2,
    updatedAt: 20,
    markRead: vi.fn(async () => {}),
    selection: { kind: 'group', code: 'known' },
  };
  state.chat.mockResolvedValueOnce([group]).mockResolvedValueOnce([]);
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  await screen.findByRole('button', { name: '原群标为已读' });
  state.partial = '群聊列表暂不可用';
  state.groupPageFailed = true;
  act(() => {
    window.dispatchEvent(new Event('0xnullai:conversation-updated'));
  });
  expect(await screen.findByText('群聊暂未重新验证，请重试')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '原群标为已读' })).toBeNull();
});
it('keeps private and AI conversations available after transient source failures without stale read actions', async () => {
  const markRead = vi.fn(async () => {});
  state.list.mockResolvedValueOnce({
    items: [
      {
        id: 'ai-1',
        metadata: { sessionTitle: '小星' },
        preview: '晚安',
        lastMessageAt: 20,
        lastSequence: 8,
        unread: 3,
      },
    ],
  });
  state.chat.mockResolvedValueOnce([
    {
      id: 'dm:friend',
      kind: 'dm',
      title: '好友',
      preview: '新消息',
      unread: 2,
      updatedAt: 30,
      markRead,
      selection: { kind: 'dm', peer: { accountId: 'friend' } },
    },
  ]);
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  await screen.findByRole('button', { name: '小星标为已读' });
  expect(screen.getByRole('button', { name: '好友标为已读' })).toBeTruthy();
  state.list.mockRejectedValueOnce(new Error('AI unavailable'));
  state.chat.mockResolvedValueOnce([]);
  state.partial = '私人聊天摘要暂不可用';
  state.dmLoadFailed = true;
  act(() => {
    window.dispatchEvent(new Event('0xnullai:conversation-updated'));
  });
  // Both the AI chat and the personal chat stay listed with a retry hint.
  expect(await screen.findAllByText('聊天暂未重新验证，请重试')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '小星标为已读' })).toBeNull();
  expect(screen.queryByRole('button', { name: '好友标为已读' })).toBeNull();
  expect(markRead).not.toHaveBeenCalled();
});
afterEach(cleanup);

it('identifies the open AI, private, or group conversation from its route', () => {
  expect(currentInboxRowId('/agent', '?conversation=ai-1')).toBe('ai:ai-1');
  expect(currentInboxRowId('/chat', '?dm=friend')).toBe('dm:friend');
  expect(currentInboxRowId('/chat', '?room=g')).toBe('group:g');
  expect(currentInboxRowId('/market', '?room=g')).toBeNull();
  expect(currentInboxRowId('/chat', '?create=1')).toBeNull();
});

it('marks only the conversation selected by the route, including after browser navigation', async () => {
  const original = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, '', '/agent?conversation=ai-1');
  state.chat.mockResolvedValue([
    {
      id: 'dm:opaque-private-room',
      kind: 'dm',
      title: '好友',
      preview: '你好',
      unread: 0,
      updatedAt: 30,
      selection: { kind: 'dm', peer: { accountId: 'friend' } },
    },
    {
      id: 'group:g',
      kind: 'group',
      title: '朋友们',
      preview: '周末见',
      unread: 0,
      updatedAt: 10,
      selection: { kind: 'group', code: 'g' },
    },
  ]);
  try {
    const view = render(
      <UnifiedInbox
        user={user('alice')}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );
    const ai = await screen.findByRole('button', { name: /小星.*晚安/ });
    const dm = screen.getByRole('button', { name: /好友.*你好/ });
    const group = screen.getByRole('button', { name: /朋友们.*周末见/ });
    expect(ai.getAttribute('aria-current')).toBe('page');
    expect(dm.getAttribute('aria-current')).toBeNull();
    window.history.replaceState(null, '', '/chat?dm=friend');
    view.rerender(
      <UnifiedInbox
        user={user('alice')}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );
    expect(ai.getAttribute('aria-current')).toBeNull();
    expect(dm.getAttribute('aria-current')).toBe('page');
    expect(group.getAttribute('aria-current')).toBeNull();
  } finally {
    window.history.replaceState(null, '', original);
  }
});

it('把 AI 与真人群聊放在同一列表，并从一行进入原有 owner', async () => {
  const navigate = vi.fn();
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={navigate}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  const ai = await screen.findByRole('button', { name: /小星.*晚安/ });
  const group = screen.getByRole('button', { name: /朋友们.*群聊/ });
  expect(ai.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  fireEvent.click(ai);
  expect(state.selectAi).toHaveBeenCalledWith('ai-1');
  expect(navigate).toHaveBeenCalledWith('agent?conversation=ai-1');
  fireEvent.click(group);
  expect(state.selectChat).toHaveBeenCalledWith({ kind: 'group', code: 'g' });
  expect(navigate).toHaveBeenCalledWith('chat?room=g');
  fireEvent.click(screen.getByRole('button', { name: '新聊天' }));
  fireEvent.click(screen.getByRole('button', { name: '与 AI 聊天' }));
  expect(state.newAi).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenLastCalledWith('agent');
});

it('offers AI and personal chat from the same new-chat entry and labels conversation kinds', async () => {
  state.chat.mockResolvedValue([
    {
      id: 'dm:friend',
      kind: 'dm',
      title: '好友',
      preview: '你好',
      unread: 0,
      updatedAt: 30,
      selection: { kind: 'dm', peer: { accountId: 'friend' } },
    },
    {
      id: 'group:g',
      kind: 'group',
      title: '朋友们',
      preview: '周末见',
      unread: 0,
      updatedAt: 10,
      selection: { kind: 'group', code: 'g' },
    },
  ]);
  const navigate = vi.fn();
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={navigate}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  // Character and personal chats read like contacts; only groups carry a kind tag.
  expect(await screen.findByRole('button', { name: /小星.*晚安/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /小星.*AI.*晚安/ })).toBeNull();
  expect(screen.getByRole('button', { name: /好友.*你好/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /朋友们.*群聊.*周末见/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '新聊天' }));
  fireEvent.click(screen.getByRole('button', { name: '找联系人聊天' }));
  expect(navigate).toHaveBeenCalledWith('people');
  expect(state.newAi).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '与 AI 聊天' })).toBeNull();
});

it('真人私聊保留可刷新定位的对象 ID，仍由原 Chat owner 验证准入', async () => {
  state.chat.mockResolvedValueOnce([
    {
      id: 'dm:peer-1',
      kind: 'dm',
      title: '好友',
      preview: '你好',
      unread: 0,
      updatedAt: 30,
      selection: { kind: 'dm', peer: { accountId: 'peer-1' } },
    },
  ]);
  const navigate = vi.fn();
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={navigate}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: /好友.*你好/ }));
  expect(state.selectChat).toHaveBeenCalledWith({
    kind: 'dm',
    peer: { accountId: 'peer-1' },
  });
  expect(navigate).toHaveBeenCalledWith('chat?dm=peer-1');
});

it('账号切换时立即隐藏旧列表，并忽略旧账号迟到的响应', async () => {
  let resolveAlice: (value: unknown) => void = () => undefined;
  state.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAlice = resolve;
      }),
  );
  const props = {
    onNavigate: vi.fn(),
    onOpenAccount: vi.fn(),
    onCreateRoom: vi.fn(),
  };
  const view = render(<UnifiedInbox user={user('alice')} {...props} />);
  state.account = null;
  view.rerender(<UnifiedInbox user={null} {...props} />);
  expect(screen.queryByText('小星')).toBeNull();
  await act(async () => {
    resolveAlice({
      items: [
        {
          id: 'ai-1',
          deleted: false,
          metadata: { sessionTitle: '小星' },
          preview: '秘密',
          updatedAt: 20,
          lastMessageAt: 20,
        },
      ],
    });
  });
  expect(screen.queryByText('秘密')).toBeNull();
  state.account = 'bob';
  state.list.mockResolvedValueOnce({ items: [] });
  state.chat.mockResolvedValueOnce([]);
  view.rerender(<UnifiedInbox user={user('bob')} {...props} />);
  expect(await screen.findByText('暂无聊天')).toBeTruthy();
  expect(screen.queryByText('小星')).toBeNull();
});
it('loads AI summary pages and orders actual DM activity ahead of unknown group metadata', async () => {
  state.list
    .mockResolvedValueOnce({
      items: [
        { id: 'old', metadata: { sessionTitle: '旧AI' }, lastMessageAt: 1, preview: '旧消息' },
      ],
      nextCursor: 'page2',
    })
    .mockResolvedValueOnce({
      items: [
        { id: 'new', metadata: { sessionTitle: '新AI' }, lastMessageAt: 30, preview: '新消息' },
      ],
    });
  state.chat.mockResolvedValue([
    {
      id: 'dm:1',
      kind: 'dm',
      title: '好友',
      updatedAt: 40,
      preview: '真实私聊内容',
      unread: null,
      selection: { kind: 'dm', peer: {} },
    },
    {
      id: 'group:1',
      kind: 'group',
      title: '群',
      updatedAt: 0,
      preview: '群消息摘要暂不可用',
      unread: null,
      selection: { kind: 'group', code: '1' },
    },
  ]);
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  const dm = await screen.findByRole('button', { name: /好友.*真实私聊内容/ });
  expect(screen.queryByText('新AI')).toBeNull();
  expect(state.list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '加载更多 AI 聊天' }));
  const latest = await screen.findByRole('button', { name: /新AI.*新消息/ });
  const group = screen.getByRole('button', { name: /群.*摘要暂不可用/ });
  expect(dm.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(latest.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(state.list).toHaveBeenNthCalledWith(2, { limit: 100, cursor: 'page2' });
});

it('loads AI history only on demand and keeps the next server cursor', async () => {
  state.chat.mockResolvedValue([]);
  state.list.mockImplementation(async ({ cursor }: { cursor?: string }) => {
    const page = cursor ? Number(cursor.slice(1)) : 1;
    return {
      items: [
        {
          id: `ai-${page}`,
          metadata: { sessionTitle: `会话 ${page}` },
          preview: `消息 ${page}`,
          lastMessageAt: page,
        },
      ],
      nextCursor: page < 3 ? `p${page + 1}` : null,
    };
  });
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  await screen.findByText('会话 1');
  expect(screen.queryByText('会话 2')).toBeNull();
  expect(state.list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '加载更多 AI 聊天' }));
  expect(await screen.findByText('会话 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '加载更多 AI 聊天' }));
  expect(await screen.findByText('会话 3')).toBeTruthy();
  expect(state.list).toHaveBeenLastCalledWith({ limit: 100, cursor: 'p3' });
  expect(screen.queryByRole('button', { name: '加载更多 AI 聊天' })).toBeNull();
  act(() => {
    window.dispatchEvent(new Event('0xnullai:conversation-updated'));
  });
  expect(await screen.findByText('会话 3')).toBeTruthy();
  await vi.waitFor(() => expect(state.list).toHaveBeenLastCalledWith({ limit: 100, cursor: 'p3' }));
});

it('clears already rendered private rows immediately on an auth event before parent props catch up', async () => {
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  await screen.findByText('小星');
  await act(async () => {
    state.account = 'bob';
    state.authChanged?.();
  });
  expect(screen.queryByText('小星')).toBeNull();
  expect(screen.queryByText('朋友们')).toBeNull();
});

it('shows server unread and explicitly acknowledges only the returned sequence', async () => {
  state.read.mockResolvedValue(undefined);
  state.list.mockResolvedValue({
    items: [
      {
        id: 'ai-1',
        metadata: { sessionTitle: '小星' },
        preview: '消息',
        lastMessageAt: 20,
        lastSequence: 8,
        readSequence: 5,
        unread: 3,
      },
    ],
  });
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  const unreadAction = await screen.findByRole('button', { name: '小星标为已读' });
  expect(unreadAction.textContent).toBe('3');
  fireEvent.click(unreadAction);
  expect(state.read).toHaveBeenCalledWith('ai-1', 8);
});
it('uses the same explicit server acknowledgement action for a human DM', async () => {
  const markRead = vi.fn(async () => {});
  state.chat.mockResolvedValue([
    {
      id: 'dm:test',
      title: '朋友',
      kind: 'dm',
      preview: '新消息',
      unread: 2,
      updatedAt: 30,
      markRead,
      selection: { kind: 'dm', peer: { accountId: 'friend' } },
    },
  ]);
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '朋友标为已读' }));
  expect(markRead).toHaveBeenCalledOnce();
});

it.each([
  {
    label: 'partial group results',
    partial: null,
    groups: [
      {
        id: 'group:failed',
        title: '未加载的群',
        kind: 'group',
        unread: null,
        updatedAt: 0,
        summaryStatus: 'failed',
        preview: '群摘要加载失败，可重新加载',
        selection: { kind: 'group', code: 'failed' },
      },
      {
        id: 'group:ok',
        title: '已加载的群',
        kind: 'group',
        unread: 2,
        updatedAt: 20,
        summaryStatus: 'available',
        selection: { kind: 'group', code: 'ok' },
      },
    ],
    visible: () => [screen.getByText('未加载的群'), screen.getByText('已加载的群')],
  },
  {
    label: 'the other human source failing',
    partial: '私人聊天摘要暂不可用',
    groups: [
      {
        id: 'group:working',
        title: '朋友们',
        kind: 'group',
        preview: '周末见',
        unread: 1,
        updatedAt: 30,
        selection: { kind: 'group', code: 'working' },
      },
    ],
    visible: () => [screen.getByRole('button', { name: /朋友们.*周末见/ })],
  },
])(
  'keeps available conversations visible and labels the incomplete load after $label',
  async ({ partial, groups, visible }) => {
    if (partial) state.partial = partial;
    state.chat.mockResolvedValue(groups);
    render(
      <UnifiedInbox
        user={user('alice')}
        onNavigate={vi.fn()}
        onOpenAccount={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('部分聊天');
    for (const element of visible()) expect(element).toBeTruthy();
  },
);

it('keeps AI and people in one searchable list and filters unread locally', async () => {
  state.list.mockResolvedValue({
    items: [
      {
        id: 'ai-1',
        metadata: { sessionTitle: '小星' },
        preview: '晚安',
        lastMessageAt: 20,
        unread: 0,
      },
    ],
  });
  state.chat.mockResolvedValue([
    {
      id: 'dm:friend',
      title: '好友',
      kind: 'dm',
      preview: '周末见',
      unread: 2,
      updatedAt: 30,
      selection: { kind: 'dm', peer: { accountId: 'friend' } },
    },
  ]);
  render(
    <UnifiedInbox
      presentation="page"
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  await screen.findByText('好友');
  expect(screen.getByText('小星')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '未读' }));
  expect(screen.queryByText('小星')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索聊天' }), {
    target: { value: '晚安' },
  });
  expect(screen.getByText('小星')).toBeTruthy();
  expect(screen.queryByText('好友')).toBeNull();
});

it('shows only account entry when signed out and opens contacts from the signed-in toolbar', async () => {
  const onOpenAccount = vi.fn();
  const onNavigate = vi.fn();
  const props = { onNavigate, onOpenAccount, onCreateRoom: vi.fn(), presentation: 'page' as const };
  const view = render(<UnifiedInbox user={null} {...props} />);
  expect(screen.getByText('登录后继续聊天')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '新聊天' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));
  expect(onOpenAccount).toHaveBeenCalledOnce();
  view.rerender(<UnifiedInbox user={user('alice')} {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '新聊天' }));
  fireEvent.click(screen.getByRole('button', { name: '找联系人聊天' }));
  expect(onNavigate).toHaveBeenCalledWith('people');
});

it('formats chat-list times the way messaging apps do', async () => {
  const { formatInboxTime } = await import('./UnifiedInbox');
  const now = new Date(2026, 9, 11, 15, 30).getTime();
  expect(formatInboxTime(new Date(2026, 9, 11, 9, 5).getTime(), now)).toBe('09:05');
  expect(formatInboxTime(new Date(2026, 9, 10, 23, 0).getTime(), now)).toBe('昨天');
  expect(formatInboxTime(new Date(2026, 2, 3).getTime(), now)).toBe('3月3日');
  expect(formatInboxTime(new Date(2025, 11, 31).getTime(), now)).toBe('2025/12/31');
});

it('does not list an AI conversation that has no messages yet', async () => {
  state.list.mockResolvedValueOnce({
    items: [
      { id: 'empty', metadata: { sessionTitle: '空会话' }, preview: '', lastSequence: 0 },
      {
        id: 'talked',
        metadata: { sessionTitle: '聊过' },
        preview: '你好',
        lastSequence: 2,
        lastMessageAt: 5,
      },
    ],
  });
  render(
    <UnifiedInbox
      user={user('alice')}
      onNavigate={vi.fn()}
      onOpenAccount={vi.fn()}
      onCreateRoom={vi.fn()}
    />,
  );
  expect(await screen.findByText('聊过')).toBeTruthy();
  expect(screen.queryByText('空会话')).toBeNull();
});
