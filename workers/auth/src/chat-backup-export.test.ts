import { expect, test } from 'vitest';
import { handleAuthChatBackupExport } from './chat-backup-export';

const token = 'a'.repeat(40);
const key = 'users/u1/conversations/c1/attachments/a1';

function setup(rows = [{ object_key: key, size: 3, mime: 'image/png', status: 'ready' }]) {
  const env = {
    AUTH_BACKUP_TOKEN: token,
    DB: {
      prepare() {
        return {
          bind(after: string) {
            return {
              async all() {
                return {
                  results: rows
                    .filter((row) => row.status === 'ready' && row.object_key > after)
                    .sort((a, b) => a.object_key.localeCompare(b.object_key))
                    .slice(0, 101),
                };
              },
              async first() {
                const row = rows.find(
                  (candidate) => candidate.object_key === after && candidate.status === 'ready',
                );
                return row ? { size: row.size, mime: row.mime } : null;
              },
            };
          },
        };
      },
    },
    PHOTOS: {
      async get(requested: string) {
        if (requested !== key) return null;
        return { body: new Response('abc').body, size: 3, etag: 'etag-1' };
      },
      async head(requested: string) {
        if (requested !== key) return null;
        return { size: 3, etag: 'etag-1' };
      },
    },
  };
  return async (route: string, body: unknown, credential = token) =>
    handleAuthChatBackupExport(
      new Request(`https://example.test/api/auth/backup/attachments/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}` },
        body: JSON.stringify(body),
      }),
      env as never,
    );
}

test('Auth private media backup requires independent operator token and only lists ready rows', async () => {
  const call = setup([
    {
      object_key: key,
      size: 3,
      mime: 'image/png',
      status: 'ready',
    },
    {
      object_key: 'users/u1/conversations/c1/attachments/a2',
      size: 3,
      mime: 'image/png',
      status: 'pending',
    },
  ]);
  expect((await call('list', {}, 'wrong'))?.status).toBe(403);
  expect(await (await call('list', {}))?.json()).toEqual({
    objects: [{ key, size: 3, mime: 'image/png' }],
    cursor: null,
  });
  expect((await call('content', { key: 'users/u1/conversations/c1/attachments/a2' }))?.status).toBe(
    404,
  );
});

test('Auth private media backup checks key, DB readiness and object size before returning bytes', async () => {
  const call = setup();
  expect((await call('content', { key: '../bad' }))?.status).toBe(400);
  const response = await call('content', { key });
  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe('abc');
  expect(response?.headers.get('X-Backup-Size')).toBe('3');
  expect(response?.headers.get('Cache-Control')).toBe('no-store');
  expect(await (await call('head', { key }))?.json()).toEqual({
    key,
    size: 3,
    mime: 'image/png',
    etag: 'etag-1',
  });
});

test('Auth private media list uses a stable object-key cursor', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    object_key: `users/u1/conversations/c1/attachments/a${String(index).padStart(3, '0')}`,
    size: 3,
    mime: 'image/png',
    status: 'ready',
  }));
  const call = setup(rows);
  const first = (await (await call('list', {}))?.json()) as {
    objects: { key: string }[];
    cursor: string;
  };
  expect(first.objects).toHaveLength(100);
  expect(first.cursor).toBe(rows[99]!.object_key);
  const second = (await (await call('list', { after: first.cursor }))?.json()) as {
    objects: { key: string }[];
    cursor: null;
  };
  expect(second.objects.map((item) => item.key)).toEqual([rows[100]!.object_key]);
  expect(second.cursor).toBeNull();
});
