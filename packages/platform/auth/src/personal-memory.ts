import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export type PersonalMemoryKind = 'preference' | 'person' | 'event' | 'note';

export interface PersonalMemory {
  id: string;
  kind: PersonalMemoryKind;
  title: string;
  content: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  scope?: 'account' | 'relationship';
  relationshipId?: string | null;
  tier?: 'long' | 'medium' | 'history';
  state?: 'suggested' | 'active';
  effectiveState?: 'suggested' | 'active' | 'superseded';
  sourceConversationId?: string | null;
  sourceMessageIds?: string[];
  sourceRefs?: Array<{ conversationId: string; messageId: string }>;
  expiresAt?: number | null;
  confidence?: number | null;
  supersededById?: string | null;
  personId?: string | null;
}

async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges((user) => {
    if (user?.id !== accountId) changed = true;
  });
  try {
    const response = await fetch(`${apiBaseUrl()}/api/auth/personal-memories${path}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...authRequestHeaders(),
        'X-Account-Id': accountId,
      },
    });
    const data = (await response.json()) as T & { error?: string };
    if (changed || currentAuthUserId() !== accountId)
      throw new Error('账户已切换，请重新打开个人记忆');
    if (!response.ok) throw new Error(data.error ?? '个人记忆暂时不可用，请稍后重试');
    return data;
  } finally {
    unsubscribe();
  }
}

/** No local persistence or public-profile projection. */
export function listPersonalMemories(
  relationshipId?: string,
): Promise<{ items: PersonalMemory[]; limit: number }> {
  return request(
    relationshipId
      ? `?scope=relationship&relationshipId=${encodeURIComponent(relationshipId)}`
      : '',
  );
}

export function savePersonalMemory(
  memory: Pick<PersonalMemory, 'id' | 'kind' | 'title' | 'content' | 'version'> &
    Partial<Pick<PersonalMemory, 'scope' | 'relationshipId' | 'tier' | 'state'>>,
): Promise<{ item: PersonalMemory }> {
  const { id, ...body } = memory;
  return request(`/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function deletePersonalMemory(id: string, version: number): Promise<{ ok: boolean }> {
  return request(`/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}
