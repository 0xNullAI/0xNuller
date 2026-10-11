import { loadGroupInbox, markGroupRead } from './group-inbox';
/** Composition seam for web's unified inbox. No message bodies or owner keys leave Chat. */
import {
  currentAuthUserId,
  subscribeAuthChanges,
  dmTicket,
  dmConversations,
  type DmRequest,
} from '@0xnullai/auth';
import { pullChatRooms, pullChatRoomsPage, type SyncedChatRoom } from '@0xnullai/sync';
import type { DmInboxSummary } from '../worker/wire';
import { apiBaseUrl } from '@0xnullai/settings';

export type ChatInboxSelection = { kind: 'group'; code: string } | { kind: 'dm'; peer: DmRequest };
export interface ChatInboxEntry {
  id: string;
  kind: 'group' | 'dm';
  title: string;
  updatedAt: number;
  unread: number | null;
  summaryStatus?: 'available' | 'unverified' | 'failed';
  preview?: string;
  markRead?: () => Promise<void>;
  timestampKind?: 'message' | 'unavailable';
  selection: ChatInboxSelection;
}
async function loadServerDmInbox(account: string) {
  const list = await dmConversations();
  if (currentAuthUserId() !== account) return [];
  if (!list) throw new Error('私人聊天列表暂不可用');
  if (!list.conversations.length) return [];
  const response = await fetch(`${apiBaseUrl()}/api/dm/inbox`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
    body: JSON.stringify({ ticket: list.ticket }),
  });
  if (!response.ok) throw new Error('私人聊天摘要暂不可用');
  const data = (await response.json()) as { accountId: string; conversations: DmInboxSummary[] };
  if (currentAuthUserId() !== account || data.accountId !== account) return [];
  const summaries = new Map(data.conversations.map((row) => [row.room, row]));
  return list.conversations.map((peer) => ({ peer, summary: summaries.get(peer.room) }));
}
interface ChatInboxLoadResult {
  entries: ChatInboxEntry[];
  partialError: string | null;
  /** DM summaries could not be verified during this load. */
  dmLoadFailed?: boolean;
  /** Present only for paged display; null means every group bookmark was visited. */
  nextGroupCursor?: string | null;
  groupPageFailed?: boolean;
}

async function loadChatInboxFromRooms(
  roomSource: () => Promise<{ rooms: SyncedChatRoom[]; nextCursor?: string | null } | null>,
  includeDms: boolean,
): Promise<ChatInboxLoadResult> {
  const account = currentAuthUserId();
  if (!account) return { entries: [], partialError: null };
  let changed = false;
  const stop = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  try {
    const [roomResult, dmResult] = await Promise.allSettled([
      roomSource(),
      includeDms ? loadServerDmInbox(account) : Promise.resolve([]),
    ]);
    if (changed || currentAuthUserId() !== account) return { entries: [], partialError: null };
    const roomPage = roomResult.status === 'fulfilled' ? roomResult.value : null;
    const rooms = roomPage?.rooms ?? null;
    const dms = dmResult.status === 'fulfilled' ? dmResult.value : [];
    if (rooms === null && dmResult.status === 'rejected') throw new Error('聊天列表暂不可用');
    const groupResult =
      rooms === null
        ? { conversations: [], failedRooms: [] }
        : await loadGroupInbox(
            account,
            rooms.map((room) => room.code),
            () => !changed,
          );
    const groupSummaries = new Map(
      groupResult.conversations.map((summary) => [summary.room, summary]),
    );
    const failedGroups = new Set(groupResult.failedRooms);
    if (changed || currentAuthUserId() !== account) return { entries: [], partialError: null };
    const entries: ChatInboxEntry[] = [
      ...(rooms ?? []).map((room): ChatInboxEntry => {
        const summary = groupSummaries.get(room.code);
        return {
          id: `group:${room.code}`,
          kind: 'group',
          title: room.name || room.code,
          updatedAt: summary?.lastMessageAt ?? 0,
          unread: summary?.unread ?? null,
          summaryStatus: failedGroups.has(room.code)
            ? 'failed'
            : summary
              ? 'available'
              : 'unverified',
          preview: failedGroups.has(room.code)
            ? '群摘要加载失败，可重新加载'
            : summary
              ? summary.preview || '暂无消息'
              : '群摘要暂不可用，请确认成员资格',
          timestampKind: summary?.lastMessageAt ? 'message' : 'unavailable',
          ...(summary && summary.lastSequence > 0 && summary.unread !== 0
            ? { markRead: () => markGroupRead(account, room.code, summary.lastSequence) }
            : {}),
          selection: { kind: 'group', code: room.code },
        };
      }),
      ...dms.map(({ peer, summary }): ChatInboxEntry => ({
        id: `dm:${peer.room}`,
        kind: 'dm',
        title: peer.displayName || peer.username || '私聊',
        updatedAt: summary?.lastMessageAt ?? 0,
        unread: summary?.unread ?? null,
        ...(summary && summary.lastSequence > 0 && summary.unread !== 0
          ? { markRead: () => markDmRead(account, peer.id, peer.room, summary.lastSequence) }
          : {}),
        preview: summary ? summary.preview || '暂无消息' : '消息摘要暂不可用',
        timestampKind: summary?.lastMessageAt ? 'message' : 'unavailable',
        selection: {
          kind: 'dm',
          peer: { accountId: peer.id, username: peer.username, displayName: peer.displayName },
        },
      })),
    ].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return {
      entries,
      dmLoadFailed: dmResult.status === 'rejected',
      ...(roomPage && 'nextCursor' in roomPage
        ? { nextGroupCursor: roomPage.nextCursor ?? null }
        : {}),
      groupPageFailed: rooms === null,
      partialError:
        rooms === null
          ? '群聊列表暂不可用'
          : dmResult.status === 'rejected'
            ? '私人聊天摘要暂不可用'
            : null,
    };
  } finally {
    stop();
  }
}

/** Complete account view for consumers that require every group bookmark. */
export async function loadChatInboxWithStatus(): Promise<ChatInboxLoadResult> {
  return loadChatInboxFromRooms(async () => {
    const rooms = await pullChatRooms();
    return rooms === null ? null : { rooms };
  }, true);
}

/** Display page. A partial page never replaces the complete group-bookmark cache. */
export async function loadChatInboxPageWithStatus(
  cursor: string | null = null,
): Promise<ChatInboxLoadResult> {
  return loadChatInboxFromRooms(() => pullChatRoomsPage(cursor), cursor === null);
}

/** Refresh exactly the number of group pages the person chose to display. */
export async function loadChatInboxDisplayWithStatus(groupPages = 1): Promise<ChatInboxLoadResult> {
  const account = currentAuthUserId();
  if (!account) return { entries: [], partialError: null, nextGroupCursor: null };
  let changed = false;
  const stop = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  const entries = new Map<string, ChatInboxEntry>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let partialError: string | null = null;
  let groupPageFailed = false;
  let dmLoadFailed = false;
  try {
    for (let pageNumber = 0; pageNumber < Math.max(1, groupPages); pageNumber++) {
      if (changed || currentAuthUserId() !== account)
        return { entries: [], partialError: null, nextGroupCursor: null };
      let page: ChatInboxLoadResult;
      try {
        page = await loadChatInboxPageWithStatus(cursor);
      } catch {
        partialError = '群聊列表暂不可用';
        groupPageFailed = true;
        break;
      }
      if (changed || currentAuthUserId() !== account)
        return { entries: [], partialError: null, nextGroupCursor: null };
      for (const entry of page.entries) entries.set(entry.id, entry);
      dmLoadFailed ||= Boolean(page.dmLoadFailed);
      if (page.partialError) {
        partialError ??= page.partialError;
        if (page.groupPageFailed) {
          groupPageFailed = true;
          break;
        }
      }
      cursor = page.nextGroupCursor ?? null;
      if (!cursor) break;
      if (cursors.has(cursor)) {
        partialError = '群聊列表游标无效，请重新加载';
        groupPageFailed = true;
        break;
      }
      cursors.add(cursor);
    }
  } finally {
    stop();
  }
  return {
    entries: [...entries.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    ),
    partialError,
    groupPageFailed,
    dmLoadFailed,
    nextGroupCursor: cursor,
  };
}

/** Existing all-or-error contract for callers that cannot present a partial list. */
export async function loadChatInbox(): Promise<ChatInboxEntry[]> {
  const result = await loadChatInboxWithStatus();
  if (result.partialError) throw new Error(result.partialError);
  return result.entries;
}
const selectionEvent = '0xnullai:chat-inbox-selection';
let pending: { account: string; selection: ChatInboxSelection } | null = null;
/** Queue before lazy mounting Chat; selection is consumed once and never crosses accounts. */
export function selectChatInboxConversation(selection: ChatInboxSelection): void {
  const account = currentAuthUserId();
  if (!account) return;
  pending = { account, selection };
  window.dispatchEvent(new Event(selectionEvent));
}
export function subscribeChatInboxSelection(
  listener: (selection: ChatInboxSelection) => void,
): () => void {
  const consume = () => {
    const next = pending;
    pending = null;
    if (next && next.account === currentAuthUserId()) listener(next.selection);
  };
  window.addEventListener(selectionEvent, consume);
  // Deliver a selection queued before mounting on the next microtask, to whichever
  // subscription is still alive: under StrictMode the first one is torn down at once, and
  // so is the room connection it would have opened.
  let active = true;
  queueMicrotask(() => {
    if (active) consume();
  });
  return () => {
    active = false;
    window.removeEventListener(selectionEvent, consume);
  };
}

export async function markDmRead(
  account: string,
  peerId: string,
  room: string,
  sequence: number | string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent() || currentAuthUserId() !== account) throw new Error('账户已切换');
  let changed = false;
  const stop = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  try {
    const ticket = await dmTicket(peerId);
    if (!isCurrent() || changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!ticket || ticket.room !== room) throw new Error('私聊授权已失效');
    const response = await fetch(`${apiBaseUrl()}/api/dm/read`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
      body: JSON.stringify({
        ticket: ticket.ticket,
        ...(typeof sequence === 'string' ? { messageId: sequence } : { sequence }),
      }),
    });
    if (!isCurrent() || changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!response.ok) throw new Error('标为已读失败，请重试');
  } finally {
    stop();
  }
}
