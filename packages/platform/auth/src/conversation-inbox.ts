import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';
export interface PrivateConversationSummary {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  metadata: {
    sessionTitle?: string;
    promptPresetId?: string;
    relationshipId?: string;
    /** Set when the chat happens in a scene; with no character the scene hosts the chat. */
    sceneId?: string;
  };
  preview: string;
  lastMessageAt: number | null;
  lastSequence: number;
  readSequence: number | null;
  unread: number | null;
  /** The caller's own saved relationship portrait; absent from older servers. */
  avatarPhotoId?: string | null;
}
export interface PrivateConversationSummaryPage {
  items: PrivateConversationSummary[];
  nextCursor: string | null;
  migrationErrors: Array<{ id: string; error: string }>;
}
export async function listPrivateConversationSummaries(
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PrivateConversationSummaryPage> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  try {
    const query = new URLSearchParams({
      summary: '1',
      order: 'recent',
      limit: String(options.limit ?? 50),
    });
    if (options.cursor) query.set('cursor', options.cursor);
    const response = await fetch(`${apiBaseUrl()}/api/auth/conversations?${query}`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { ...authRequestHeaders(), 'X-Account-Id': account },
    });
    const result = (await response.json()) as PrivateConversationSummaryPage & { error?: string };
    if (changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!response.ok) throw new Error(result.error ?? '会话列表暂不可用');
    return result;
  } finally {
    unsubscribe();
  }
}
export type AgentInboxSelection = { kind: 'conversation'; id: string } | { kind: 'new' };
let pending: { accountId: string; selection: AgentInboxSelection } | null = null;
let watching = false;
const listeners = new Set<() => void>();
function watch(): void {
  if (watching) return;
  watching = true;
  subscribeAuthChanges(() => {
    if (pending?.accountId !== currentAuthUserId()) pending = null;
  });
}
/** Page-memory, single-use navigation intent; survives lazy mounting but never an account switch. */
export function selectAgentInboxConversation(conversationId: string): void {
  watch();
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) throw new Error('会话编号无效');
  pending = { accountId, selection: { kind: 'conversation', id: conversationId } };
  for (const listener of listeners) listener();
}
export function requestNewAgentInboxConversation(): void {
  watch();
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  pending = { accountId, selection: { kind: 'new' } };
  for (const listener of listeners) listener();
}
export function consumeAgentInboxSelection(): AgentInboxSelection | null {
  watch();
  const value = pending;
  pending = null;
  return value?.accountId === currentAuthUserId() ? value.selection : null;
}
export function subscribeAgentInboxSelection(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Explicit acknowledgement of an observed sequence; never advances to future messages. */
export async function markPrivateConversationRead(id: string, sequence: number): Promise<void> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || !Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error('已读序号无效');
  let changed = false;
  const unsubscribe = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  try {
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/conversations/${encodeURIComponent(id)}/read`,
      {
        method: 'PUT',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          ...authRequestHeaders(),
          'X-Account-Id': account,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sequence }),
      },
    );
    if (changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!response.ok) throw new Error('标为已读失败，请重试');
  } finally {
    unsubscribe();
  }
}

/** Fired after an AI conversation is deleted; `detail` is its id. */
export const CONVERSATION_DELETED_EVENT = '0xnullai:conversation-deleted';

/**
 * Delete one of this account's AI conversations and all its messages. The delete is bound to
 * the revision last seen, as every write is; if the conversation moved on meanwhile (a reply
 * landed), it re-reads the revision once and deletes that. Agent hears the event and leaves the
 * conversation, stopping any reply still running in it.
 */
export async function deletePrivateConversation(id: string): Promise<void> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('会话编号无效');
  const url = `${apiBaseUrl()}/api/auth/conversations/${encodeURIComponent(id)}`;
  const headers = { ...authRequestHeaders(), 'X-Account-Id': account };
  const current = async (): Promise<number | null> => {
    const response = await fetch(`${url}?window=20`, {
      credentials: 'include',
      cache: 'no-store',
      headers,
    });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error('会话暂不可用，请稍后再试');
    const item = (await response.json()) as { revision?: unknown; deleted?: unknown };
    return item.deleted === true || typeof item.revision !== 'number' ? null : item.revision;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const revision = await current();
    if (currentAuthUserId() !== account) throw new Error('账户已切换');
    if (revision === null) break;
    const response = await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: revision }),
    });
    if (response.ok || response.status === 404) break;
    if (response.status !== 409 || attempt === 1) throw new Error('删除失败，请稍后再试');
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CONVERSATION_DELETED_EVENT, { detail: id }));
    window.dispatchEvent(new Event('0xnullai:conversation-updated'));
  }
}
