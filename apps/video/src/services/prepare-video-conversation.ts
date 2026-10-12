import { preparePrivateConversation } from '@0xnullai/auth';
import { savedPromptKind, type SavedScene } from '@0xnullai/scenes';

/** Characters recall their relationship; only a server-bound scene can layer onto that identity. */
export async function prepareVideoConversation(
  card: SavedScene,
  savedCards: readonly SavedScene[],
) {
  if (savedPromptKind(card) !== 'character') {
    throw new Error('场景只提供环境，请先从 Market 导入角色并打开角色聊天。');
  }
  const prepared = await preparePrivateConversation(card.id);
  const scene = prepared.sceneId
    ? savedCards.find(
        (candidate) => candidate.id === prepared.sceneId && savedPromptKind(candidate) === 'scene',
      )
    : null;
  if (prepared.sceneId && !scene) {
    prepared.channel.dispose();
    throw new Error('此聊天绑定的场景尚未在当前账户导入，请先从 Market 导入。');
  }
  return { ...prepared, scene: scene ?? null };
}
