import {
  currentAuthUserId,
  ensureCharacterRelationship,
  listPrivateConversationSummaries,
  requestNewAgentInboxConversation,
  selectAgentInboxConversation,
} from '@0xnullai/auth';
import { importMarketSceneOnline } from '@0xnullai/scenes';
import { promptKind, type ScenarioContent } from '../shared/schema';
import { fetchItem, markDownloaded, recordCharacterStart } from './api';

/** Turn a visible public card into this account's pinned scene and private relationship. */
export async function startCharacterChat(itemId: string): Promise<void> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录后开始聊天');
  const item = await fetchItem(itemId);
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开角色');
  if (item.type !== 'scenario') throw new Error('这张公开卡暂时无法用于聊天');
  const scene = item.content as ScenarioContent;
  if (promptKind(scene) !== 'character')
    throw new Error('场景只提供环境设定，不能作为角色开始聊天');
  if (!scene.prompt?.trim()) throw new Error('这张公开卡暂时无法用于聊天');
  const characterId = `market-${item.id}`;
  await ensureCharacterRelationship(characterId);
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开公开内容');
  // Starting a chat is an explicit request for this card, even if it was deleted before.
  const library = await importMarketSceneOnline(item, { restoreDeleted: true });
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开公开内容');
  if (library.selectedId !== characterId) throw new Error('角色导入失败，请稍后重试');
  // Like a contact, a character has one ongoing conversation: reopen the latest one
  // instead of piling up empty chats. A failed lookup falls back to a new chat.
  const existing = await listPrivateConversationSummaries({ limit: 50 })
    .then((page) => page.items.find((entry) => entry.metadata.promptPresetId === characterId))
    .catch(() => undefined);
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开公开内容');
  if (existing) selectAgentInboxConversation(existing.id);
  else requestNewAgentInboxConversation();
  void recordCharacterStart(item.id).catch(() => undefined);
  void markDownloaded(item.id).catch(() => undefined);
}
