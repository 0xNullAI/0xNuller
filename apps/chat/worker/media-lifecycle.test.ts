import { describe, expect, it } from 'vitest';
import { handleMediaUpload } from './media';
import type { Env } from './index';

function request(): Request {
  return new Request('https://chat.example/api/upload/room-a?id=media-1', {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'x-media-token': 'live-token' },
    body: new Uint8Array([137, 80, 78, 71]),
  });
}

function fakeEnv(options?: {
  authorize?: (code: string, token: string) => Promise<boolean>;
  note?: (code: string, token: string) => Promise<void>;
}) {
  const stored = new Set<string>();
  const deleted: string[] = [];
  const env = {
    MEDIA: {
      put: async (key: string) => {
        stored.add(key);
        return null;
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          stored.delete(key);
          deleted.push(key);
        }
      },
    },
    ROOM: {
      idFromName: (code: string) => code,
      get: () => ({
        authorizeMediaUpload: options?.authorize ?? (async () => true),
        noteMediaUpload: options?.note ?? (async () => undefined),
      }),
    },
  } as unknown as Env;
  return { env, stored, deleted };
}

describe('媒体孤儿清理调度', () => {
  it('R2 写入成功后通知对应 RoomDO 安排清扫', async () => {
    const noted: string[] = [];
    const { env, stored } = fakeEnv({
      note: async (code, token) => {
        noted.push(`${code}:${token}`);
      },
    });
    const response = await handleMediaUpload(request(), env, 'room-a');
    expect(response.status).toBe(200);
    expect(noted).toEqual(['room-a:live-token']);
    expect([...stored]).toEqual(['room/room-a/media-1']);
  });

  it('无法安排清扫时补偿删除刚写入的对象', async () => {
    const { env, stored, deleted } = fakeEnv({
      note: async () => {
        throw new Error('DO unavailable');
      },
    });
    const response = await handleMediaUpload(request(), env, 'room-a');
    expect(response.status).toBe(503);
    expect(stored.size).toBe(0);
    expect(deleted).toEqual(['room/room-a/media-1']);
  });

  it('拒绝能逃出 R2 房间前缀的 code', async () => {
    const { env, stored } = fakeEnv();
    const response = await handleMediaUpload(request(), env, '../other-room');
    expect(response.status).toBe(400);
    expect(stored.size).toBe(0);
  });

  it('没有当前 WebSocket 能力令牌时在读取 body 和写 R2 前拒绝', async () => {
    const { env, stored } = fakeEnv({ authorize: async () => false });
    const response = await handleMediaUpload(request(), env, 'room-a');
    expect(response.status).toBe(403);
    expect(stored.size).toBe(0);
  });
});
