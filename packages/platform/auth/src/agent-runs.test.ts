import { beforeEach, expect, it, vi } from 'vitest';
import { claimAgentRunCall, finishAgentRun, getAgentRun, startAgentRun } from './agent-runs';

const auth = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));
const fetchMock = vi.fn<typeof fetch>(async () =>
  Response.json({
    item: { id: 'run-1', conversationId: 'one', requestId: 'request-1', status: 'active' },
    claimed: true,
    claimToken: 'token',
    ownerToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }),
);
beforeEach(() => {
  auth.account = 'alice';
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

it('binds start and call claims to the current account and conversation', async () => {
  expect((await startAgentRun('one', 'request-1')).claimed).toBe(true);
  await claimAgentRunCall('one', 'run-1', 'call-1', 'web_search');
  expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/auth/agent-runs?conversationId=one');
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'X-Account-Id': 'alice' },
  });
  expect(fetchMock.mock.calls[1]?.[0]).toContain('/run-1/calls/call-1?conversationId=one');
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    name: 'web_search',
    ownerToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
});

it('keeps execution rights in this window and drops them after an account round-trip', async () => {
  await startAgentRun('one', 'request-1');
  await finishAgentRun('one', 'run-1', 'completed');
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    status: 'completed',
    ownerToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  auth.account = 'bob';
  for (const listener of auth.listeners) listener();
  auth.account = 'alice';
  for (const listener of auth.listeners) listener();
  const count = fetchMock.mock.calls.length;
  await expect(claimAgentRunCall('one', 'run-1', 'another-call', 'web_search')).rejects.toThrow(
    '没有任务执行权',
  );
  expect(fetchMock).toHaveBeenCalledTimes(count);
});

// A→B: the account changes silently mid-request. A→B→A: a slow response
// must not be accepted just because the account switched away and back.
it.each([
  { path: 'A→B', switches: ['bob'], notify: false },
  { path: 'A→B→A', switches: ['bob', 'alice'], notify: true },
])(
  'rejects a response after the account changes during the request ($path)',
  async ({ switches, notify }) => {
    fetchMock.mockImplementationOnce(async () => {
      for (const account of switches) {
        auth.account = account;
        if (notify) for (const listener of auth.listeners) listener();
      }
      return Response.json({ item: { id: 'run-1' } });
    });
    await expect(getAgentRun('one', 'run-1')).rejects.toThrow('账号已切换');
  },
);
