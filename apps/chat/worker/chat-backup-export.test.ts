// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleChatBackupExport } from './chat-backup-export';
import type { Env } from './index';

const secret = 'backup-secret-kept-outside-product-code';
function setup() {
  const exportBackupMessages = vi.fn(async () => ({
    room: 'room-1',
    exists: true,
    messages: [{ id: 'm1', body: '{"x":"hi"}', ts: 1 }],
    before: null,
    totalMessages: 1,
  }));
  const list = vi.fn(async () => ({
    objects: [{ key: 'room/room-1/picture', size: 3, etag: 'abc', uploaded: new Date(0) }],
    truncated: false,
  }));
  const get = vi.fn(async () => ({ body: 'abc', etag: 'abc' }));
  const roomIndex = {
    list: vi.fn(async () => ({
      rooms: [{ code: 'room-1', kind: 'group', source: 'admission' }],
      cursor: null,
    })),
    register: vi.fn(async () => {}),
    listAccountTombstones: vi.fn(async () => ({
      accounts: [{ account_id: 'alice' }],
      cursor: null,
    })),
  };
  const env = {
    CHAT_BACKUP_TOKEN: secret,
    ROOM: { idFromName: (code: string) => code, get: () => ({ exportBackupMessages }) },
    MEDIA: { list, get },
    ROOM_INDEX: { idFromName: (name: string) => name, get: () => roomIndex },
  } as unknown as Env;
  const call = (path: string, body: unknown, token = secret) =>
    handleChatBackupExport(
      new Request(`https://chat.test${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { env, call, exportBackupMessages, list, get, roomIndex };
}

it('fails closed without a separate backup capability', async () => {
  const test = setup();
  expect((await test.call('/api/groups/backup/messages', { room: 'room-1' }, 'wrong')).status).toBe(
    403,
  );
  test.env.CHAT_BACKUP_TOKEN = '';
  expect((await test.call('/api/groups/backup/media-list', {})).status).toBe(403);
  expect(test.exportBackupMessages).not.toHaveBeenCalled();
  expect(test.list).not.toHaveBeenCalled();
});

it('restricts room enumeration and explicit historical backfill to the backup capability', async () => {
  const test = setup();
  expect((await test.call('/api/groups/backup/rooms', {}, 'wrong')).status).toBe(403);
  const listed = await test.call('/api/groups/backup/rooms', {});
  expect(await listed.json()).toMatchObject({
    coverage: 'observed-and-explicit-hints',
    rooms: [{ code: 'room-1' }],
  });
  expect((await test.call('/api/groups/backup/rooms', { after: '../' })).status).toBe(400);
  expect(
    (
      await test.call('/api/groups/backup/rooms/backfill', {
        rooms: [
          { code: 'room-old', kind: 'group' },
          { code: 'dm:legacy', kind: 'dm' },
        ],
      })
    ).status,
  ).toBe(200);
  expect(test.roomIndex.register).toHaveBeenCalledWith('room-old', 'group', 'historical-hint');
  expect(await (await test.call('/api/groups/backup/account-tombstones', {})).json()).toMatchObject(
    { accounts: [{ account_id: 'alice' }] },
  );
  expect(
    (
      await test.call('/api/groups/backup/rooms/backfill', {
        rooms: [{ code: 'x', kind: 'unknown' }],
      })
    ).status,
  ).toBe(400);
});

it('exports only a named room and forwards its bounded cursor', async () => {
  const test = setup();
  const response = await test.call('/api/groups/backup/messages', {
    room: 'room-1',
    before: { ts: 2, id: 'm2' },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ messages: [{ id: 'm1' }] });
  expect(test.exportBackupMessages).toHaveBeenCalledWith('room-1', { ts: 2, id: 'm2' });
  expect((await test.call('/api/groups/backup/messages', { room: '../other' })).status).toBe(400);
  expect(
    (
      await test.call('/api/groups/backup/messages', {
        room: 'room-1',
        before: { ts: -1, id: 'm' },
      })
    ).status,
  ).toBe(400);
});

it('rejects a historical hint that does not identify an existing RoomDO', async () => {
  const test = setup();
  test.exportBackupMessages.mockResolvedValueOnce({
    room: 'room-1',
    exists: false,
    messages: [],
    before: null,
    totalMessages: 0,
  });
  const response = await test.call('/api/groups/backup/messages', { room: 'room-1' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'room identity not found' });
});

it('enumerates R2 pages and reads only room media keys', async () => {
  const test = setup();
  const listing = await test.call('/api/groups/backup/media-list', {});
  expect(await listing.json()).toMatchObject({
    objects: [{ key: 'room/room-1/picture' }],
    cursor: null,
  });
  const media = await test.call('/api/groups/backup/media', { key: 'room/room-1/picture' });
  expect(await media.text()).toBe('abc');
  expect(media.headers.get('Cache-Control')).toBe('no-store');
  expect((await test.call('/api/groups/backup/media', { key: 'secret/file' })).status).toBe(400);
  expect(test.get).toHaveBeenCalledTimes(1);
});

it('exports private DM media without accepting malformed room keys', async () => {
  const test = setup();
  const key = `room/dm:${'a'.repeat(64)}/voice`;
  const media = await test.call('/api/groups/backup/media', { key });
  expect(media.status).toBe(200);
  expect(await media.text()).toBe('abc');
  expect(test.get).toHaveBeenCalledWith(key);
  expect(
    (await test.call('/api/groups/backup/media', { key: 'room/dm:legacy/voice' })).status,
  ).toBe(400);
  expect((await test.call('/api/groups/backup/media', { key: 'room/../voice' })).status).toBe(400);
});
