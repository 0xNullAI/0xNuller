import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export interface AutoMemoryPreference {
  enabled: boolean;
  version: number;
  updatedAt: number | null;
}
export interface AutoMemorySettings {
  item: AutoMemoryPreference;
  available: boolean;
  progress?: { queued: number; retrying: number; paused: number };
}

async function request(
  relationshipId: string,
  init: RequestInit = {},
): Promise<AutoMemorySettings> {
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges((user) => {
    if (user?.id !== accountId) changed = true;
  });
  try {
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/auto-memory/${encodeURIComponent(relationshipId)}`,
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
    const data = (await response.json()) as AutoMemorySettings & { error?: string };
    if (changed || currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开记忆');
    if (!response.ok) throw new Error(data.error ?? '自动记忆设置暂不可用');
    return data;
  } finally {
    unsubscribe();
  }
}

export function getAutoMemorySettings(relationshipId: string): Promise<AutoMemorySettings> {
  return request(relationshipId);
}

/** Opt-in only stages private candidates. The user must confirm each memory separately. */
export function setAutoMemorySettings(
  relationshipId: string,
  enabled: boolean,
  version: number,
): Promise<AutoMemorySettings> {
  return request(relationshipId, {
    method: 'PUT',
    body: JSON.stringify({ enabled, version }),
  });
}
