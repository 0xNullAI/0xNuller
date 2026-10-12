import {
  currentAuthUserId,
  listPrivateConversationSummaries,
  requestNewAgentInboxConversation,
  selectAgentInboxConversation,
} from '@0xnullai/auth';
import { importMarketSceneOnline } from '@0xnullai/scenes';
import { promptKind, type ScenarioContent } from '../shared/schema';
import { fetchItem, markDownloaded } from './api';

/**
 * Start a chat in a scene with no character: the AI narrates the place and plays its cast.
 * The scene is imported online and selected, then a new conversation opens on it. A scene has
 * no relationship, so nothing here creates one or any memory.
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
  // Like a character, a scene reopens its latest scene-only chat instead of piling up new ones.
  const existing = await listPrivateConversationSummaries({ limit: 50 })
    .then((page) =>
      page.items.find(
        (entry) =>
          entry.metadata.sceneId === sceneId &&
          (!entry.metadata.promptPresetId || entry.metadata.promptPresetId === sceneId),
      ),
    )
    .catch(() => undefined);
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开场景');
  if (existing) selectAgentInboxConversation(existing.id);
  else requestNewAgentInboxConversation();
  void markDownloaded(item.id).catch(() => undefined);
}
