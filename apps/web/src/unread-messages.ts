import { useEffect, useState } from 'react';
import { currentAuthUserId, listPrivateConversationSummaries, type AuthUser } from '@0xnullai/auth';
import { webNotificationsEnabled } from '@0xnullai/settings';
import { loadChatInboxDisplayWithStatus } from '../../chat/src/inbox';

const POLL_MS = 30_000;
const CONVERSATION_SEQUENCES_EVENT = '0xnullai:conversation-sequences';
const BASE_TITLE = '猫愿';

/** Sum of known unread counts; unknown (null) counts are not guessed. */
export function totalUnread(counts: readonly (number | null | undefined)[]): number {
  return counts.reduce<number>(
    (total, count) => total + (typeof count === 'number' && count > 0 ? count : 0),
    0,
  );
}

export function unreadTitle(total: number): string {
  return total > 0 ? `(${total > 99 ? '99+' : total}) ${BASE_TITLE}` : BASE_TITLE;
}

/**
 * A system notification only for a rise in unread messages while the page is not being
 * looked at, and only after the user opted in and the browser granted permission.
 */
export function shouldNotify(input: {
  previous: number | null;
  current: number;
  hidden: boolean;
  enabled: boolean;
  permission: NotificationPermission | 'unsupported';
}): boolean {
  return (
    input.previous !== null &&
    input.current > input.previous &&
    input.hidden &&
    input.enabled &&
    input.permission === 'granted'
  );
}

async function loadUnreadTotal(): Promise<number | null> {
  const [ai, human] = await Promise.allSettled([
    listPrivateConversationSummaries({ limit: 100 }),
    loadChatInboxDisplayWithStatus(1),
  ]);
  if (ai.status === 'fulfilled') {
    // Lets an open AI conversation pick up messages written elsewhere (a scheduled AI
    // message, another device) without a separate poll.
    const sequences: Record<string, number> = {};
    for (const item of ai.value.items)
      if (!item.deleted && typeof item.lastSequence === 'number')
        sequences[item.id] = item.lastSequence;
    window.dispatchEvent(
      new CustomEvent(CONVERSATION_SEQUENCES_EVENT, {
        detail: { accountId: currentAuthUserId(), sequences },
      }),
    );
  }
  if (ai.status === 'rejected' && human.status === 'rejected') return null;
  return totalUnread([
    ...(ai.status === 'fulfilled'
      ? ai.value.items.filter((item) => !item.deleted).map((item) => item.unread)
      : []),
    ...(human.status === 'fulfilled' ? human.value.entries.map((entry) => entry.unread) : []),
  ]);
}

/**
 * Unread messages across AI, direct and group conversations, kept current on every page
 * (not only while a conversation list is on screen). Updates the tab title and, when
 * enabled, raises a browser notification while the page is in the background.
 */
export function useUnreadMessages(user: AuthUser | null): number {
  const accountId = user?.id ?? null;
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!accountId) {
      setTotal(0);
      return;
    }
    let active = true;
    let previous: number | null = null;
    let pending: number | null = null;
    const refresh = async () => {
      const next = await loadUnreadTotal().catch(() => null);
      if (!active || next === null || currentAuthUserId() !== accountId) return;
      const permission =
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      if (
        shouldNotify({
          previous,
          current: next,
          hidden: document.visibilityState !== 'visible',
          enabled: webNotificationsEnabled(accountId),
          permission,
        })
      ) {
        try {
          new Notification(BASE_TITLE, {
            body: `有 ${next - (previous ?? 0)} 条新消息`,
            tag: 'unread',
          });
        } catch {
          // Some browsers only allow notifications from a service worker; the title still updates.
        }
      }
      previous = next;
      setTotal(next);
    };
    const schedule = () => {
      if (pending !== null) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        pending = null;
        void refresh();
      }, 300);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    window.addEventListener('focus', schedule);
    window.addEventListener('0xnullai:conversation-updated', schedule);
    return () => {
      active = false;
      if (pending !== null) window.clearTimeout(pending);
      window.clearInterval(timer);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('0xnullai:conversation-updated', schedule);
    };
  }, [accountId]);

  useEffect(() => {
    document.title = unreadTitle(total);
  }, [total]);

  return total;
}
