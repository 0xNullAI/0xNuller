import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pullChatRooms, rememberChatRoom } = vi.hoisted(() => ({
  pullChatRooms: vi.fn(),
  rememberChatRoom: vi.fn(),
}));
vi.mock('@0xnullai/sync', () => ({
  pullChatRooms,
  rememberChatRoom,
  forgetChatRoom: vi.fn(),
}));

import { loadKnownGroups, syncKnownGroups } from './groups';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('房间列表兼容迁移', () => {
  it('首次登录合并旧本地房间，随后以账户列表为权威', async () => {
    localStorage.setItem(
      'dg-chat-groups',
      JSON.stringify([{ code: 'legacy-room', name: '旧房间' }]),
    );
    pullChatRooms
      .mockResolvedValueOnce([{ code: 'remote-room', name: '云端房间' }])
      .mockResolvedValueOnce([
        { code: 'remote-room', name: '云端房间' },
        { code: 'legacy-room', name: '旧房间' },
      ]);
    rememberChatRoom.mockResolvedValue(true);

    await syncKnownGroups();
    expect(rememberChatRoom).toHaveBeenCalledWith('legacy-room', '旧房间');
    expect(loadKnownGroups()).toEqual([
      { code: 'remote-room', name: '云端房间' },
      { code: 'legacy-room', name: '旧房间' },
    ]);

    pullChatRooms.mockResolvedValueOnce([{ code: 'remote-room', name: '已改名' }]);
    await syncKnownGroups();
    expect(rememberChatRoom).toHaveBeenCalledTimes(1);
    expect(loadKnownGroups()).toEqual([{ code: 'remote-room', name: '已改名' }]);
  });

  it('离线时保留缓存', async () => {
    localStorage.setItem('dg-chat-groups', JSON.stringify([{ code: 'cached', name: '缓存' }]));
    pullChatRooms.mockResolvedValue(null);
    expect(await syncKnownGroups()).toBeNull();
    expect(loadKnownGroups()).toEqual([{ code: 'cached', name: '缓存' }]);
  });
});
