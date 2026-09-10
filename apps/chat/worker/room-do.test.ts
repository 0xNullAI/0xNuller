// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { Env } from './index';
import { ROOM_IDLE_MS } from './wire';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { RoomDO } = await import('./room-do');

function room(code = 'test-room', idleSince = Date.now() - ROOM_IDLE_MS) {
  const values = new Map<string, unknown>([
    ['code', code],
    ['idleSince', idleSince],
  ]);
  const sockets: WebSocket[] = [];
  const sql = { exec: vi.fn(() => ({ toArray: () => [] })) };
  const storage = {
    sql,
    get: async (key: string) => values.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key))
        values.set(k as string, v);
    },
    delete: async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key);
    },
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const media = {
    list: vi.fn(async () => ({
      objects: [{ key: `room/${code}/image`, uploaded: new Date(0) }],
      truncated: false,
    })),
    delete: vi.fn(),
  };
  const lobby = vi.fn(async (_url: string, _options: RequestInit) => new Response('ok'));
  const instance = new RoomDO(
    { storage, getWebSockets: () => sockets } as unknown as DurableObjectState,
    {
      MEDIA: media,
      LOBBY: { idFromName: (id: string) => id, get: () => ({ fetch: lobby }) },
    } as unknown as Env,
  );
  return { instance, values, sockets, sql, storage, media, lobby };
}
afterEach(() => vi.restoreAllMocks());
it('reclaims expired history and media, unlists the room and keeps a closed tombstone', async () => {
  const r = room();
  expect(await r.instance.recycleIdleRoom(Date.now())).toBe(true);
  expect(r.values.get('closed')).toBe(true);
  expect(r.media.delete).toHaveBeenCalledWith(['room/test-room/image']);
  expect(r.sql.exec).toHaveBeenCalledWith('DELETE FROM messages');
  expect(JSON.parse(r.lobby.mock.calls[0]![1]!.body as string).listed).toBe(false);
  expect(r.storage.deleteAlarm).toHaveBeenCalled();
});
it('preserves occupied rooms, recent rooms and direct messages', async () => {
  const occupied = room();
  occupied.sockets.push({} as WebSocket);
  for (const r of [
    occupied,
    room('recent', Date.now() - ROOM_IDLE_MS + 10000),
    room('dm:' + 'a'.repeat(64)),
  ]) {
    expect(await r.instance.recycleIdleRoom(Date.now())).toBe(false);
    expect(r.media.delete).not.toHaveBeenCalled();
  }
});
it('keeps a retry alarm and history if media cleanup fails', async () => {
  const r = room();
  r.media.delete.mockRejectedValueOnce(new Error('R2 unavailable'));
  await expect(r.instance.recycleIdleRoom(Date.now())).rejects.toThrow('R2 unavailable');
  expect(r.values.get('closed')).toBe(true);
  expect(r.storage.setAlarm).toHaveBeenCalled();
  expect(r.sql.exec).not.toHaveBeenCalledWith('DELETE FROM messages');
  expect(await r.instance.recycleIdleRoom(Date.now())).toBe(true);
});
it('rejects invalid initial room names at the server boundary', async () => {
  const r = room();
  const ws = {
    deserializeAttachment: () => ({ peerId: 'peer' }),
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  await r.instance.webSocketMessage(
    ws,
    JSON.stringify({ t: 'hello', claim: true, roomName: '短' }),
  );
  expect(ws.close).toHaveBeenCalledWith(1008, '房间名必须为 4–40 个字符');
  expect(r.values.has('public')).toBe(false);
});

it('starts idle timing on disconnect and reclaims through the scheduled alarm', async () => {
  const r = room();
  r.values.delete('idleSince');
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const socket = { deserializeAttachment: () => null } as unknown as WebSocket;
  await r.instance.webSocketClose(socket);
  expect(r.values.get('idleSince')).toBe(now);
  expect(r.storage.setAlarm).toHaveBeenCalled();
  vi.mocked(Date.now).mockReturnValue(now + ROOM_IDLE_MS);
  await r.instance.alarm();
  expect(r.values.get('closed')).toBe(true);
  expect(r.sql.exec).toHaveBeenCalledWith('DELETE FROM messages');
});
