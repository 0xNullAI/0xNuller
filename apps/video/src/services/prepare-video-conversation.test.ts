import { afterEach, expect, it, vi } from 'vitest';
import { prepareVideoConversation } from './prepare-video-conversation.js';

const auth = vi.hoisted(() => ({
  prepare: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => null,
  preparePrivateConversation: auth.prepare,
}));

afterEach(() => {
  auth.prepare.mockReset();
});

it('loads a character relationship before camera use', async () => {
  const prepared = { channel: {}, context: 'relationship memory' };
  auth.prepare.mockResolvedValue(prepared);

  await expect(
    prepareVideoConversation(
      { id: 'market-character', name: '朋友', prompt: '朋友', kind: 'character' },
      [],
    ),
  ).resolves.toEqual({ ...prepared, scene: null });
  expect(auth.prepare).toHaveBeenCalledWith('market-character');
});

it('does not create a conversation whose identity is only a scene', async () => {
  await expect(
    prepareVideoConversation(
      { id: 'market-scene', name: '雨夜', prompt: '雨夜', kind: 'scene' },
      [],
    ),
  ).rejects.toThrow('场景只提供环境');
  expect(auth.prepare).not.toHaveBeenCalled();
});

it('layers only the scene bound to the server conversation onto the character', async () => {
  const channel = { dispose: vi.fn() };
  const scene = { id: 'rain', name: '雨夜', prompt: '窗外下雨', kind: 'scene' as const };
  auth.prepare.mockResolvedValue({ channel, context: 'private memory', sceneId: 'rain' });

  await expect(
    prepareVideoConversation({ id: 'friend', name: '朋友', prompt: '朋友', kind: 'character' }, [
      scene,
      { id: 'other', name: '海边', prompt: '海风', kind: 'scene' },
    ]),
  ).resolves.toEqual({ channel, context: 'private memory', sceneId: 'rain', scene });
  expect(auth.prepare).toHaveBeenCalledWith('friend');
  expect(channel.dispose).not.toHaveBeenCalled();
});

it('refuses a server-bound scene that is missing or is another character', async () => {
  const channel = { dispose: vi.fn() };
  auth.prepare.mockResolvedValue({ channel, context: 'private memory', sceneId: 'rain' });

  await expect(
    prepareVideoConversation({ id: 'friend', name: '朋友', prompt: '朋友', kind: 'character' }, [
      { id: 'rain', name: '同名角色', prompt: '角色', kind: 'character' },
    ]),
  ).rejects.toThrow('场景尚未在当前账户导入');
  expect(channel.dispose).toHaveBeenCalledOnce();
});
