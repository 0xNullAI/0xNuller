import { beforeEach, expect, it, vi } from 'vitest';
import { listMediaJobs, mediaJobBlob } from './media-jobs';

const auth = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));

beforeEach(() => {
  auth.account = 'alice';
  auth.listeners.clear();
});

it('binds media list requests to the signed-in account and conversation', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(listMediaJobs('chat/one')).resolves.toEqual({ items: [] });
  expect(fetchMock.mock.calls[0]?.[0]).toContain('conversationId=chat%2Fone');
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    credentials: 'include',
    cache: 'no-store',
    headers: { 'X-Account-Id': 'alice' },
  });
});

it('discards an old-account media list when account changes during response parsing', async () => {
  let finish!: (value: { items: [] }) => void;
  const parsed = new Promise<{ items: [] }>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: () => parsed }) as Response),
  );
  const pending = listMediaJobs('chat-one');
  await vi.waitFor(() => expect(typeof finish).toBe('function'));
  auth.account = 'bob';
  finish({ items: [] });
  await expect(pending).rejects.toThrow('账号已切换');
});

it('reads older media pages in order for a long conversation', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).includes('before=20%3Ajob_00020')
        ? { items: [{ id: 'job_00010' }], nextBefore: null }
        : { items: [{ id: 'job_00020' }], nextBefore: '20:job_00020' },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(listMediaJobs('chat-one')).resolves.toEqual({
    items: [{ id: 'job_00020' }, { id: 'job_00010' }],
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[0]).toContain('before=20%3Ajob_00020');
  expect(auth.listeners.size).toBe(0);
});

it('rejects all pages if the account switches away and back between page responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => {
      auth.account = 'bob';
      for (const listener of auth.listeners) listener();
      auth.account = 'alice';
      for (const listener of auth.listeners) listener();
      return Response.json({ items: [], nextBefore: null });
    }),
  );
  await expect(listMediaJobs('chat-one')).rejects.toThrow('账号已切换');
  expect(auth.listeners.size).toBe(0);
});

it('discards old-account generated image bytes when account changes during blob read', async () => {
  let finish!: (blob: Blob) => void;
  const parsed = new Promise<Blob>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: () => parsed }) as Response),
  );
  const pending = mediaJobBlob('image-one');
  await vi.waitFor(() => expect(typeof finish).toBe('function'));
  auth.account = 'bob';
  for (const listener of auth.listeners) listener();
  auth.account = 'alice';
  for (const listener of auth.listeners) listener();
  finish(new Blob(['private image']));
  await expect(pending).rejects.toThrow('账号已切换');
  expect(auth.listeners.size).toBe(0);
});
