import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';
import type { PersonalMemory } from './personal-memory';

export interface MemoryContext {
  relationshipId: string;
  shortTerm: Array<{ id: string; role: string; content: string; truncated: boolean }>;
  /** Exact older user messages from the same server conversation; never confirmed facts. */
  historyRecap?: Array<{ id: string; content: string; truncated: boolean }>;
  /** Derived conversation continuity only; never a confirmed personal fact or tool receipt. */
  conversationDigest?: {
    relationshipId: string;
    throughPosition: number;
    throughMessageId: string;
    summary: string;
    version: number;
  } | null;
  mediumTerm: PersonalMemory[];
  longTerm: PersonalMemory[];
  relationshipHistory: PersonalMemory[];
}
async function post<T>(suffix: string, body: object): Promise<T> {
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges((user) => {
    if (user?.id !== accountId) changed = true;
  });
  try {
    const response = await fetch(`${apiBaseUrl()}/api/auth/memory-context${suffix}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...authRequestHeaders(),
        'X-Account-Id': accountId,
      },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as T & { error?: string };
    if (changed || currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开记忆');
    if (!response.ok) throw new Error(data.error ?? '记忆服务暂不可用');
    return data;
  } finally {
    unsubscribe();
  }
}
/** Only active owned sources and the conversation's own relationship are included. */
export function getMemoryContext(conversationId: string, query = ''): Promise<MemoryContext> {
  return post('', { conversationId, query });
}
/** Generates reviewable exact excerpts/explicit requests, never silently activates inferred facts. */
export function suggestConversationMemories(
  conversationId: string,
): Promise<{ items: PersonalMemory[]; generated: number; notice: string }> {
  return post('/suggestions', { conversationId });
}
