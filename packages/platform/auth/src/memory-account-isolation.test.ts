import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  account: 'alice',
  listeners: new Set<(user: { id: string } | null) => void>(),
}));
vi.mock('./index', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: (user: { id: string } | null) => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));

import { getMemoryContext } from './memory-context';
import { exportPersonalMemories, listPersonalMemories } from './personal-memory';
import { getAutoMemorySettings } from './auto-memory';
import { getConversationDigestPreference } from './conversation-digest-preference';
import { correctMemoryFact, listMemoryPeople } from './memory-facts';

afterEach(() => {
  auth.account = 'alice';
  auth.listeners.clear();
  vi.unstubAllGlobals();
});

it.each([
  ['conversation context', () => getMemoryContext('conversation')],
  ['personal memories', () => listPersonalMemories()],
  ['personal memory export', () => exportPersonalMemories()],
  ['automatic memory settings', () => getAutoMemorySettings('relationship')],
  ['long conversation digest setting', () => getConversationDigestPreference('relationship')],
  ['relationship person aliases', () => listMemoryPeople('relationship')],
  [
    'relationship fact correction',
    () =>
      correctMemoryFact(
        { id: 'old', version: 2 },
        { kind: 'preference', title: '称呼', content: '叫我小林' },
      ),
  ],
])('discards stale %s after an A-B-A account switch', async (_name, request) => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    expect((init?.headers as Record<string, string>)['X-Account-Id']).toBe('alice');
    auth.account = 'bob';
    for (const listener of auth.listeners) listener({ id: 'bob' });
    auth.account = 'alice';
    for (const listener of auth.listeners) listener({ id: 'alice' });
    return Response.json({ items: [], relationshipId: 'relationship' });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(request()).rejects.toThrow('已切换');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(auth.listeners.size).toBe(0);
});

it('sends a fact correction with the old version and only the new user-authored content', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ item: {}, replacesId: 'old' }));
  vi.stubGlobal('fetch', fetcher);
  await correctMemoryFact(
    { id: 'old', version: 2 },
    { kind: 'preference', title: '称呼', content: '叫我小林' },
  );
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain('/api/auth/memory-facts/old/correct');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({
    version: 2,
    kind: 'preference',
    title: '称呼',
    content: '叫我小林',
  });
});
