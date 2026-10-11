import { afterEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));
import {
  consumeAgentInboxSelection,
  requestNewAgentInboxConversation,
  selectAgentInboxConversation,
  subscribeAgentInboxSelection,
  listPrivateConversationSummaries,
  markPrivateConversationRead,
} from './conversation-inbox';
afterEach(() => {
  consumeAgentInboxSelection();
  auth.account = 'alice';
  vi.unstubAllGlobals();
});
it('queues before lazy mounting, consumes once and drops on A-B-A account switch', () => {
  selectAgentInboxConversation('s1');
  expect(consumeAgentInboxSelection()).toEqual({ kind: 'conversation', id: 's1' });
  expect(consumeAgentInboxSelection()).toBeNull();
  const listener = vi.fn();
  const unsubscribe = subscribeAgentInboxSelection(listener);
  selectAgentInboxConversation('s2');
  expect(listener).toHaveBeenCalledOnce();
  auth.account = 'bob';
  for (const fn of auth.listeners) fn();
  auth.account = 'alice';
  for (const fn of auth.listeners) fn();
  expect(consumeAgentInboxSelection()).toBeNull();
  unsubscribe();
});
it('queues a fresh AI chat as an explicit intent', () => {
  requestNewAgentInboxConversation();
  expect(consumeAgentInboxSelection()).toEqual({ kind: 'new' });
  expect(consumeAgentInboxSelection()).toBeNull();
});
it('requests summary-only with account binding and rejects in-flight identity change', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ items: [], nextCursor: null, migrationErrors: [] }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await listPrivateConversationSummaries({ limit: 10 })).toMatchObject({ items: [] });
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('summary=1');
  fetcher.mockImplementation(async () => {
    auth.account = 'bob';
    for (const fn of auth.listeners) fn();
    auth.account = 'alice';
    return Response.json({ items: [] });
  });
  await expect(listPrivateConversationSummaries()).rejects.toThrow('账户已切换');
});

it('pins read acknowledgement and rejects late account changes', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await markPrivateConversationRead('s', 4);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'PUT',
    headers: { 'X-Account-Id': 'alice' },
    body: '{"sequence":4}',
  });
  fetcher.mockImplementation(async () => {
    auth.account = 'bob';
    for (const fn of auth.listeners) fn();
    auth.account = 'alice';
    return new Response('{}');
  });
  await expect(markPrivateConversationRead('s', 4)).rejects.toThrow('账户已切换');
});
