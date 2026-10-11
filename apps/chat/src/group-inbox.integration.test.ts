import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  account: 'alice',
  listeners: new Set<() => void>(),
  ticket: vi.fn(async () => ({ ticket: 'chat-ticket' })),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  getChatTicket: state.ticket,
  subscribeAuthChanges: (fn: () => void) => {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },
}));
vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => '' }));
import { loadGroupInbox, markGroupRead } from './group-inbox';
afterEach(() => {
  state.account = 'alice';
  vi.unstubAllGlobals();
});
it('uses fresh scoped membership acknowledgement and ignores late A-B-A responses', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ accountId: 'alice', conversations: [{ room: 'group', readTicket: 'scoped' }] }),
  );
  vi.stubGlobal('fetch', fetcher);
  await markGroupRead('alice', 'group', 4);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/groups/read',
    expect.objectContaining({ body: '{"ticket":"scoped","sequence":4}' }),
  );
  fetcher.mockImplementation(async () => {
    state.account = 'bob';
    for (const fn of state.listeners) fn();
    state.account = 'alice';
    return Response.json({ accountId: 'alice', conversations: [] });
  });
  await expect(loadGroupInbox('alice', ['group'])).rejects.toThrow('账户已切换');
});
it('acknowledges only the displayed server message using a newly verified scoped ticket', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      accountId: 'alice',
      conversations: [{ room: 'group', readTicket: 'fresh-scoped', lastSequence: 99 }],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await markGroupRead('alice', 'group', 'visible-message', () => true);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/groups/read',
    expect.objectContaining({ body: '{"ticket":"fresh-scoped","messageId":"visible-message"}' }),
  );
});
it('cancels when hidden during membership verification and when membership disappears', async () => {
  let visible = true;
  const fetcher = vi.fn(async () => {
    visible = false;
    return Response.json({
      accountId: 'alice',
      conversations: [{ room: 'group', readTicket: 'scoped' }],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(markGroupRead('alice', 'group', 'visible-message', () => visible)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => Response.json({ accountId: 'alice', conversations: [] }));
  await expect(markGroupRead('alice', 'group', 'visible-message')).rejects.toThrow(
    '群成员资格已失效',
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects A-B-A during automatic reading and a membership-version revocation at final write', async () => {
  const fetcher = vi.fn(async () => {
    state.account = 'bob';
    for (const fn of state.listeners) fn();
    state.account = 'alice';
    return Response.json({
      accountId: 'alice',
      conversations: [{ room: 'group', readTicket: 'scoped' }],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(markGroupRead('alice', 'group', 'visible-message')).rejects.toThrow('账户已切换');
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () =>
    Response.json({ accountId: 'alice', conversations: [{ room: 'group', readTicket: 'scoped' }] }),
  );
  fetcher
    .mockResolvedValueOnce(
      Response.json({
        accountId: 'alice',
        conversations: [{ room: 'group', readTicket: 'scoped' }],
      }),
    )
    .mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 }));
  await expect(markGroupRead('alice', 'group', 'visible-message')).rejects.toThrow('标为已读失败');
});
it.each([51, 120])(
  'loads every saved group in stable bounded batches (%i groups)',
  async (count) => {
    const rooms = Array.from({ length: count }, (_, index) => `group-${index}`);
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as { rooms: string[] };
      return Response.json({
        accountId: 'alice',
        conversations: [...body.rooms].reverse().map((room) => ({
          room,
          unread: null,
          lastMessageAt: null,
          lastSequence: 0,
          readSequence: null,
          preview: '',
          membershipVersion: 1,
          readTicket: 'scoped',
        })),
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await loadGroupInbox('alice', [...rooms, rooms[0]!]);
    expect(result.conversations.map((row) => row.room)).toEqual(rooms);
    expect(result.failedRooms).toEqual([]);
    expect(
      fetcher.mock.calls.map(
        (call) => (JSON.parse(String(call[1]?.body)) as { rooms: string[] }).rooms.length,
      ),
    ).toEqual(count === 51 ? [50, 1] : [50, 50, 20]);
  },
);
it('keeps successful batches and distinguishes failed batches from revoked/legacy memberships', async () => {
  const rooms = Array.from({ length: 120 }, (_, index) => `group-${index}`);
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const batch = (JSON.parse(String(options?.body)) as { rooms: string[] }).rooms;
    if (batch[0] === 'group-50')
      return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
    return Response.json({
      accountId: 'alice',
      conversations: batch
        .filter((room) => room !== 'group-0' && room !== 'group-119')
        .map((room) => ({ room, unread: null })),
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await loadGroupInbox('alice', rooms);
  expect(result.failedRooms).toEqual(rooms.slice(50, 100));
  expect(result.conversations).toHaveLength(68);
  expect(result.failedRooms).not.toContain('group-0');
  expect(result.conversations.some((row) => row.room === 'group-119')).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('aborts remaining batches on A-B-A rather than returning a partial old-account result', async () => {
  let batch = 0;
  const fetcher = vi.fn<typeof fetch>(async () => {
    batch++;
    if (batch === 2) {
      state.account = 'bob';
      for (const fn of state.listeners) fn();
      state.account = 'alice';
      for (const fn of state.listeners) fn();
    }
    return Response.json({ accountId: 'alice', conversations: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(
    loadGroupInbox(
      'alice',
      Array.from({ length: 120 }, (_, index) => `group-${index}`),
    ),
  ).rejects.toThrow('账户已切换');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});
