import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrateLegacyKnownGroups } from './groups';

const remote = vi.hoisted(() => ({
  pull: vi.fn(),
  remember: vi.fn(),
}));
vi.mock('@0xnullai/sync', () => ({
  pullChatRooms: remote.pull,
  rememberChatRoom: remote.remember,
  forgetChatRoom: vi.fn(),
  closeChatRoom: vi.fn(),
}));

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  remote.pull.mockReset();
  remote.remember.mockReset();
  remote.remember.mockResolvedValue(true);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('does not enumerate all account groups when there is no local legacy cache to migrate', async () => {
  await migrateLegacyKnownGroups();
  expect(remote.pull).not.toHaveBeenCalled();
  expect(values.get('dg-chat-groups-account-migrated-v1')).toBe('1');
});

it('performs the complete legacy comparison only once when old local groups exist', async () => {
  values.set('dg-chat-groups', JSON.stringify([{ code: 'legacy', name: '旧群' }]));
  remote.pull
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ code: 'legacy', name: '旧群', updatedAt: 1 }]);
  await migrateLegacyKnownGroups();
  await migrateLegacyKnownGroups();
  expect(remote.pull).toHaveBeenCalledTimes(2);
  expect(remote.remember).toHaveBeenCalledOnce();
  expect(remote.remember).toHaveBeenCalledWith('legacy', '旧群');
});
