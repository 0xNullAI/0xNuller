import { currentAuthUserId } from '@0xnullai/auth';
import { importMarketSceneOnline } from '@0xnullai/scenes';
import { openSceneChat } from '@0xnullai/scenes/start-chat';
import { promptKind, type ScenarioContent } from '../shared/schema';
import { fetchItem, markDownloaded } from './api';

/**
 * Start a chat in a public scene with no character. The scene is imported online and selected,
 * then the shared library flow opens its scene-only conversation.
 */
export async function startSceneChat(itemId: string): Promise<void> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录后开始聊天');
  const item = await fetchItem(itemId);
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开场景');
  if (item.type !== 'scenario' || promptKind(item.content as ScenarioContent) !== 'scene')
    throw new Error('这张公开卡不是场景');
  const library = await importMarketSceneOnline(item, { restoreDeleted: true });
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开场景');
  const sceneId = `market-${item.id}`;
  if (library.selectedId !== sceneId) throw new Error('场景导入失败，请稍后重试');
  if (!(await openSceneChat(sceneId))) throw new Error('账号已切换，请重新打开场景');
  void markDownloaded(item.id).catch(() => undefined);
}
