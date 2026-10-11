import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';
import type { PersonalMemory } from './personal-memory';

export interface HumanMemoryConversation {
  kind: 'dm' | 'group';
  id: string;
  name: string;
}
export interface HumanMemoryPageCursor {
  dmOffset: number | null;
  groupOffset: number | null;
}
export interface HumanMemoryShare {
  memoryId: string;
  enabled: boolean;
  version: number;
  updatedAt: number;
}
export interface ReceivedHumanMemory {
  ownerId: string;
  ownerName: string;
  memory: Pick<PersonalMemory, 'id' | 'kind' | 'title' | 'content' | 'version' | 'updatedAt'>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let changed = false;
  const stop = subscribeAuthChanges(() => {
    changed = true;
  });
  try {
    const response = await fetch(`${apiBaseUrl()}/api/auth/human-memory${path}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...authRequestHeaders(),
        'X-Account-Id': account,
      },
    });
    const data = (await response.json()) as T & { error?: string };
    if (changed || currentAuthUserId() !== account)
      throw new Error('账户已切换，请重新打开记忆共享');
    if (!response.ok) throw new Error(data.error ?? '记忆共享暂不可用');
    return data;
  } finally {
    stop();
  }
}

function query(chat: HumanMemoryConversation): string {
  return `?kind=${encodeURIComponent(chat.kind)}&id=${encodeURIComponent(chat.id)}`;
}

export function listHumanMemoryConversations(next?: HumanMemoryPageCursor): Promise<{
  conversations: HumanMemoryConversation[];
  next: HumanMemoryPageCursor | null;
}> {
  return request(
    `/conversations${next ? `?dmOffset=${next.dmOffset ?? -1}&groupOffset=${next.groupOffset ?? -1}` : ''}`,
  );
}
export function listHumanMemoryShares(
  chat: HumanMemoryConversation,
): Promise<{ shares: HumanMemoryShare[] }> {
  return request(`/shares${query(chat)}`);
}
export function listReceivedHumanMemories(
  chat: HumanMemoryConversation,
  offset = 0,
): Promise<{
  items: ReceivedHumanMemory[];
  nextOffset: number | null;
}> {
  return request(`/received${query(chat)}&offset=${offset}`);
}
export function setHumanMemoryShare(
  chat: HumanMemoryConversation,
  memory: Pick<PersonalMemory, 'id' | 'version'>,
  grant: Pick<HumanMemoryShare, 'enabled' | 'version'>,
): Promise<{ share: HumanMemoryShare }> {
  return request(`/shares/${encodeURIComponent(memory.id)}${query(chat)}`, {
    method: 'PUT',
    body: JSON.stringify({
      enabled: grant.enabled,
      version: grant.version,
      memoryVersion: memory.version,
    }),
  });
}
