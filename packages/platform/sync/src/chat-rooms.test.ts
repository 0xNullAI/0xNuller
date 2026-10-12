import { afterEach, expect, it, vi } from 'vitest';
import { pullChatRooms, pullChatRoomsPage } from './index';

afterEach(() => vi.unstubAllGlobals());

function setupToken() {
  let token = 'alice-token';
  vi.stubGlobal('localStorage', { getItem: () => token });
  return (next: string) => {
    token = next;
  };
}

it('loads every server page without truncating the account group list', async () => {
  setupToken();
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'https://example.test');
      requested.push(url.searchParams.get('cursor') ?? 'first');
      const start = url.searchParams.get('cursor') ? 100 : 0;
      return Response.json({
        rooms: Array.from({ length: start ? 21 : 100 }, (_, n) => ({
          code: `group-${start + n}`,
          name: '',
          joinedAt: 1,
          updatedAt: 1,
        })),
        nextCursor: start ? null : 'page-two',
      });
    }),
  );
  expect((await pullChatRooms())?.map((room) => room.code)).toHaveLength(121);
  expect(requested).toEqual(['first', 'page-two']);
});

it('rejects a failed, repeated, or account-switched page instead of returning an incomplete prefix', async () => {
  const setToken = setupToken();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      new URL(input, 'https://example.test').searchParams.has('cursor')
        ? new Response(null, { status: 503 })
        : Response.json({ rooms: [{ code: 'first' }], nextCursor: 'next' }),
    ),
  );
  expect(await pullChatRooms()).toBeNull();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ rooms: [{ code: 'first' }], nextCursor: 'same' })),
  );
  expect(await pullChatRooms()).toBeNull();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      setToken('bob-token');
      return Response.json({ rooms: [{ code: 'alice' }], nextCursor: null });
    }),
  );
  expect(await pullChatRooms()).toBeNull();
});

it('exposes one page for on-demand callers', async () => {
  const setToken = setupToken();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      expect(new URL(input, 'https://example.test').searchParams.get('cursor')).toBe('opaque');
      return Response.json({ rooms: [], nextCursor: null });
    }),
  );
  expect(await pullChatRoomsPage('opaque')).toEqual({ rooms: [], nextCursor: null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      setToken('other-account');
      return Response.json({ rooms: [{ code: 'alice-private' }], nextCursor: null });
    }),
  );
  expect(await pullChatRoomsPage()).toBeNull();
});
