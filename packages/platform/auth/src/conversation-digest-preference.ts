import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export interface ConversationDigestPreference {
  item: { enabled: boolean; version: number; updatedAt: number | null };
  available: boolean;
}

async function request(
  relationshipId: string,
  init: RequestInit = {},
): Promise<ConversationDigestPreference> {
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges((user) => {
    if (user?.id !== accountId) changed = true;
  });
  try {
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/conversation-digest-preferences/${encodeURIComponent(relationshipId)}`,
      {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...authRequestHeaders(),
          'X-Account-Id': accountId,
        },
      },
    );
    const result = (await response.json()) as ConversationDigestPreference & { error?: string };
    if (changed || currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开记忆');
    if (!response.ok) throw new Error(result.error ?? '摘要设置暂不可用');
    return result;
  } finally {
    unsubscribe();
  }
}

export function getConversationDigestPreference(relationshipId: string) {
  return request(relationshipId);
}

export function setConversationDigestPreference(
  relationshipId: string,
  enabled: boolean,
  version: number,
) {
  return request(relationshipId, { method: 'PUT', body: JSON.stringify({ enabled, version }) });
}
