import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  markDmRead,
  loadChatInbox,
  loadChatInboxWithStatus,
  loadChatInboxDisplayWithStatus,
  selectChatInboxConversation,
  subscribeChatInboxSelection,
} from './inbox';
const state = vi.hoisted(() => ({
  account: 'one',
  rooms: vi.fn(),
  pages: vi.fn(),
  groups: vi.fn(),
  dms: vi.fn(),
  ticket: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  dmConversations: state.dms,
  dmTicket: state.ticket,
  subscribeAuthChanges: (fn: () => void) => {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },
}));
vi.mock('./group-inbox', () => ({
  loadGroupInbox: state.groups,
  markGroupRead: vi.fn(),
}));
vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => '' }));
vi.mock('@0xnullai/sync', () => ({ pullChatRooms: state.rooms, pullChatRoomsPage: state.pages }));
beforeEach(() => {
  state.pages.mockReset();
  state.groups.mockResolvedValue({ conversations: [], failedRooms: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        accountId: state.account,
        conversations: [{ room: 'dm-room', lastMessageAt: 3, preview: '真实消息', unread: null }],
      }),
    ),
  );
});

it('loads only the requested group pages, keeps cursor order and de-duplicates a boundary row', async () => {
  state.dms.mockResolvedValue({ conversations: [], ticket: 'signed' });
  state.pages
    .mockResolvedValueOnce({
      rooms: Array.from({ length: 100 }, (_, index) => ({ code: `g${index}`, name: `群${index}` })),
      nextCursor: 'same-millisecond:g99',
    })
    .mockResolvedValueOnce({
      rooms: [
        { code: 'g99', name: '群99' },
        { code: 'g100', name: '群100' },
      ],
      nextCursor: null,
    });
  const first = await loadChatInboxDisplayWithStatus();
  expect(first.entries).toHaveLength(100);
  expect(first.nextGroupCursor).toBe('same-millisecond:g99');
  expect(state.pages).toHaveBeenCalledOnce();
  state.pages.mockReset();
  state.pages
    .mockResolvedValueOnce({
      rooms: Array.from({ length: 100 }, (_, index) => ({ code: `g${index}`, name: `群${index}` })),
      nextCursor: 'same-millisecond:g99',
    })
    .mockResolvedValueOnce({
      rooms: [
        { code: 'g99', name: '群99' },
        { code: 'g100', name: '群100' },
      ],
      nextCursor: null,
    });
  const expanded = await loadChatInboxDisplayWithStatus(2);
  expect(expanded.entries).toHaveLength(101);
  expect(expanded.nextGroupCursor).toBeNull();
  expect(state.pages).toHaveBeenNthCalledWith(2, 'same-millisecond:g99');
  expect(state.groups).toHaveBeenCalledWith('one', ['g99', 'g100'], expect.any(Function));
});

it('reports a later group page failure without treating the loaded prefix as the complete list', async () => {
  state.dms.mockResolvedValue({ conversations: [], ticket: 'signed' });
  state.pages
    .mockResolvedValueOnce({ rooms: [{ code: 'recent', name: '最近' }], nextCursor: 'next' })
    .mockResolvedValueOnce(null);
  const result = await loadChatInboxDisplayWithStatus(2);
  expect(result.entries.map((entry) => entry.id)).toEqual(['group:recent']);
  expect(result.nextGroupCursor).toBe('next');
  expect(result.groupPageFailed).toBe(true);
  expect(result.partialError).toContain('群聊列表');
});

it('discards every displayed page after an A-B-A account transition between requests', async () => {
  state.dms.mockResolvedValue({ conversations: [], ticket: 'signed' });
  state.pages
    .mockResolvedValueOnce({ rooms: [{ code: 'private', name: '秘密' }], nextCursor: 'next' })
    .mockImplementationOnce(async () => {
      state.account = 'two';
      for (const listener of state.listeners) listener();
      state.account = 'one';
      return { rooms: [{ code: 'second', name: '秘密2' }], nextCursor: null };
    });
  expect((await loadChatInboxDisplayWithStatus(2)).entries).toEqual([]);
});
afterEach(() => {
  state.account = 'one';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it('merges authorized conversations without exposing owner credentials', async () => {
  state.rooms.mockResolvedValue([{ code: 'group', name: '群', updatedAt: 2, ownerKey: 'secret' }]);
  state.dms.mockResolvedValue({
    conversations: [{ id: 'peer', room: 'dm-room', username: 'person', startedAt: 999 }],
    ticket: 'signed',
  });
  const result = await loadChatInbox();
  expect(result.map((x) => x.kind)).toEqual(['dm', 'group']);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result[0]).toMatchObject({ updatedAt: 3, preview: '真实消息', unread: null });
  expect(result[1]).toMatchObject({ updatedAt: 0, unread: null, timestampKind: 'unavailable' });
});
it('drops delayed list results and pending selections after an account switch', async () => {
  state.rooms.mockImplementation(async () => {
    state.account = 'two';
    return [];
  });
  state.dms.mockResolvedValue({ conversations: [], ticket: 'signed' });
  selectChatInboxConversation({ kind: 'group', code: 'private' });
  expect(await loadChatInbox()).toEqual([]);
  const listener = vi.fn();
  const stop = subscribeChatInboxSelection(listener);
  await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
  stop();
});
it('delivers a pending selection once, to the subscription that survives mounting', async () => {
  selectChatInboxConversation({ kind: 'group', code: 'group' });
  const first = vi.fn();
  const second = vi.fn();
  // StrictMode: subscribe, clean up, subscribe again.
  subscribeChatInboxSelection(first)();
  const stop = subscribeChatInboxSelection(second);
  await Promise.resolve();
  stop();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledWith({ kind: 'group', code: 'group' });
});

it('never derives unread from browser read marks and reports failed server summaries', async () => {
  state.rooms.mockResolvedValue([]);
  state.dms.mockResolvedValue({
    conversations: [{ id: 'peer', room: 'dm-room' }],
    ticket: 'signed',
  });
  const getItem = vi.fn(() => {
    throw new Error('local read forbidden');
  });
  vi.stubGlobal('localStorage', { getItem });
  expect((await loadChatInbox())[0]?.unread).toBeNull();
  expect(getItem).not.toHaveBeenCalled();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 403 })),
  );
  await expect(loadChatInbox()).rejects.toThrow('摘要暂不可用');
});

it('keeps group rows when private-message summaries fail', async () => {
  state.rooms.mockResolvedValue([{ code: 'group', name: '朋友们' }]);
  state.groups.mockResolvedValue({ conversations: [], failedRooms: [] });
  state.dms.mockResolvedValue({
    conversations: [{ id: 'peer', room: 'dm-room' }],
    ticket: 'signed',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 503 })),
  );
  const result = await loadChatInboxWithStatus();
  expect(result.partialError).toBe('私人聊天摘要暂不可用');
  expect(result.dmLoadFailed).toBe(true);
  expect(result.entries.map((entry) => entry.id)).toEqual(['group:group']);
});

it('keeps private-message rows when the group room list fails', async () => {
  state.rooms.mockResolvedValue(null);
  state.dms.mockResolvedValue({
    conversations: [{ id: 'peer', room: 'dm-room', username: '好友' }],
    ticket: 'signed',
  });
  const result = await loadChatInboxWithStatus();
  expect(result.partialError).toBe('群聊列表暂不可用');
  expect(result.entries.map((entry) => entry.id)).toEqual(['dm:dm-room']);
});

it('rejects A-B-A read acknowledgement before sending and uses fresh membership ticket', async () => {
  state.ticket.mockImplementation(async () => {
    state.account = 'two';
    for (const fn of state.listeners) fn();
    state.account = 'one';
    return { room: 'dm-room', ticket: 'signed' };
  });
  await expect(markDmRead('one', 'peer', 'dm-room', 3)).rejects.toThrow('账户已切换');
  expect(fetch).not.toHaveBeenCalled();
  state.ticket.mockResolvedValue({ room: 'dm-room', ticket: 'signed' });
  await markDmRead('one', 'peer', 'dm-room', 3);
  expect(fetch).toHaveBeenCalledWith(
    '/api/dm/read',
    expect.objectContaining({ body: '{"ticket":"signed","sequence":3}' }),
  );
});
it('acknowledges an actually rendered message ID and rechecks visibility after obtaining a ticket', async () => {
  state.ticket.mockResolvedValue({ room: 'dm-room', ticket: 'signed' });
  await markDmRead('one', 'peer', 'dm-room', 'server-message');
  expect(fetch).toHaveBeenCalledWith(
    '/api/dm/read',
    expect.objectContaining({ body: '{"ticket":"signed","messageId":"server-message"}' }),
  );
  vi.mocked(fetch).mockClear();
  let visible = true;
  state.ticket.mockImplementation(async () => {
    visible = false;
    return { room: 'dm-room', ticket: 'signed' };
  });
  await expect(
    markDmRead('one', 'peer', 'dm-room', 'server-message', () => visible),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps group batch errors explicit and never invents unread for revoked or old bookmarked rooms', async () => {
  state.rooms.mockResolvedValue([
    { code: 'failed', name: '失败' },
    { code: 'old', name: '旧书签' },
    { code: 'known', name: '有效' },
  ]);
  state.dms.mockResolvedValue({ conversations: [], ticket: 'signed' });
  state.groups.mockResolvedValue({
    conversations: [
      { room: 'known', lastMessageAt: 10, preview: '服务器消息', lastSequence: 2, unread: 1 },
    ],
    failedRooms: ['failed'],
  });
  const result = await loadChatInbox();
  expect(result[0]).toMatchObject({ id: 'group:known', summaryStatus: 'available', unread: 1 });
  expect(result.find((row) => row.id === 'group:failed')).toMatchObject({
    summaryStatus: 'failed',
    unread: null,
    updatedAt: 0,
  });
  expect(result.find((row) => row.id === 'group:old')).toMatchObject({
    summaryStatus: 'unverified',
    unread: null,
    updatedAt: 0,
  });
  expect(result.find((row) => row.id === 'group:failed')?.markRead).toBeUndefined();
});
