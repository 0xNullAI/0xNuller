import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export interface AccountMemoryAccess {
  enabled: boolean;
  version: number;
  updatedAt: number | null;
}
async function request(
  conversationId: string,
  init: RequestInit = {},
): Promise<AccountMemoryAccess> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges((user) => {
    if (user?.id !== account) changed = true;
  });
  try {
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/conversations/${encodeURIComponent(conversationId)}/memory-access`,
      {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...authRequestHeaders(),
          'X-Account-Id': account,
        },
      },
    );
    const data = (await response.json()) as { item?: AccountMemoryAccess; error?: string };
    if (changed || currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开记忆');
    if (!response.ok || !data.item) throw new Error(data.error ?? '记忆开放设置暂不可用');
    return data.item;
  } finally {
    unsubscribe();
  }
}
export function getAccountMemoryAccess(conversationId: string): Promise<AccountMemoryAccess> {
  return request(conversationId);
}
export function setAccountMemoryAccess(
  conversationId: string,
  enabled: boolean,
  version: number,
): Promise<AccountMemoryAccess> {
  return request(conversationId, { method: 'PUT', body: JSON.stringify({ enabled, version }) });
}
