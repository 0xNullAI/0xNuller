import { currentAuthUserId } from '@0xnullai/auth';
import { importMarketSceneOnline } from '@0xnullai/scenes';
import { promptKind, type ScenarioContent } from '../shared/schema';
import { fetchItem, markDownloaded } from './api';

/** Import a public environment without replacing the selected chat character. */
export async function importSceneCard(itemId: string): Promise<void> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录后导入场景');
  const item = await fetchItem(itemId);
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开场景');
  if (item.type !== 'scenario' || promptKind(item.content as ScenarioContent) !== 'scene')
    throw new Error('这张公开卡不是场景');
  await importMarketSceneOnline(item, { select: false, restoreDeleted: true });
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开场景');
  void markDownloaded(item.id).catch(() => undefined);
}
