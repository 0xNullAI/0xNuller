import { useEffect, useRef, useState } from 'react';
import type { AuthUser } from '@0xnullai/auth';
import { webNotificationsEnabled } from '@0xnullai/settings';
import { useInbox, type InboxSnapshot } from './inbox-store';

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

/**
 * Unread total from the shared inbox, or null while it is unknown (nothing answered yet,
 * or every source failed). Rows the last refresh could not re-verify are not counted.
 */
export function inboxUnreadTotal(inbox: InboxSnapshot): number | null {
  const aiKnown = inbox.ai.settled && !inbox.ai.failed;
  const humanKnown = inbox.human.settled && !inbox.human.failed;
  if (!aiKnown && !humanKnown) return null;
  return totalUnread([
    ...(aiKnown ? inbox.ai.items.filter((item) => !item.deleted).map((item) => item.unread) : []),
    ...(humanKnown
      ? inbox.human.entries
          .filter((entry) => !inbox.human.staleIds.has(entry.id))
          .map((entry) => entry.unread)
      : []),
  ]);
}

/**
 * Unread messages across AI, direct and group conversations, kept current on every page
 * (not only while a conversation list is on screen). Updates the tab title and, when
 * enabled, raises a browser notification while the page is in the background.
 *
 * Reads the same store as the inbox list, so the two never poll the same endpoints twice.
 */
export function useUnreadMessages(user: AuthUser | null): number {
  const accountId = user?.id ?? null;
  const inbox = useInbox(accountId, user?.emailVerified === false);
  const known = inboxUnreadTotal(inbox);
  // An unknown total (a failed poll) keeps the last known one for this account.
  const [last, setLast] = useState<{ accountId: string | null; total: number }>({
    accountId: null,
    total: 0,
  });
  if (accountId && known !== null && (last.accountId !== accountId || last.total !== known))
    setLast({ accountId, total: known });
  const total = last.accountId === accountId ? last.total : 0;

  const notified = useRef<{ accountId: string | null; total: number | null }>({
    accountId: null,
    total: null,
  });
  useEffect(() => {
    if (!accountId || known === null) return;
    const before = notified.current.accountId === accountId ? notified.current.total : null;
    notified.current = { accountId, total: known };
    const permission =
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    if (
      !shouldNotify({
        previous: before,
        current: known,
        hidden: document.visibilityState !== 'visible',
        enabled: webNotificationsEnabled(accountId),
        permission,
      })
    )
      return;
    try {
      new Notification(BASE_TITLE, { body: `有 ${known - (before ?? 0)} 条新消息`, tag: 'unread' });
    } catch {
      // Some browsers only allow notifications from a service worker; the title still updates.
    }
  }, [accountId, known]);

  useEffect(() => {
    document.title = unreadTitle(total);
  }, [total]);

  return total;
}
