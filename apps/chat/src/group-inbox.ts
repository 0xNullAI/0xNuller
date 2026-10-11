import { currentAuthUserId, getChatTicket, subscribeAuthChanges } from '@0xnullai/auth';
import { apiBaseUrl } from '@0xnullai/settings';
import type { DmInboxSummary } from '../worker/wire';
export interface GroupInboxSummary extends DmInboxSummary {
  membershipVersion: number;
  readTicket: string;
}
export interface GroupInboxLoadResult {
  conversations: GroupInboxSummary[];
  /** Requested rooms whose batch failed; an omitted authorized response is instead unverified. */
  failedRooms: string[];
}
export async function loadGroupInbox(
  account: string,
  rooms: string[],
  isCurrent: () => boolean = () => true,
): Promise<GroupInboxLoadResult> {
  const orderedRooms = [...new Set(rooms)];
  if (!orderedRooms.length) return { conversations: [], failedRooms: [] };
  let changed = false;
  const controller = new AbortController();
  const stop = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) {
      changed = true;
      controller.abort();
    }
  });
  const check = () => {
    if (changed || !isCurrent() || currentAuthUserId() !== account) throw new Error('账户已切换');
  };
  const summaries = new Map<string, GroupInboxSummary>();
  const failedRooms: string[] = [];
  try {
    for (let offset = 0; offset < orderedRooms.length; offset += 50) {
      check();
      const batch = orderedRooms.slice(offset, offset + 50);
      try {
        const ticket = await getChatTicket();
        check();
        const response = await fetch(`${apiBaseUrl()}/api/groups/inbox`, {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
          body: JSON.stringify({ ticket: ticket.ticket, rooms: batch }),
        });
        const data = (await response.json()) as {
          accountId: string;
          conversations: GroupInboxSummary[];
        };
        check();
        if (!response.ok || !Array.isArray(data.conversations)) throw new Error('群聊摘要暂不可用');
        if (data.accountId !== account) {
          changed = true;
          check();
        }
        if (data.conversations.some((row) => !row || !batch.includes(row.room)))
          throw new Error('群聊摘要无效');
        for (const summary of data.conversations) summaries.set(summary.room, summary);
      } catch {
        check();
        failedRooms.push(...batch);
      }
    }
    check();
    return {
      conversations: orderedRooms.flatMap((room) =>
        summaries.has(room) ? [summaries.get(room)!] : [],
      ),
      failedRooms,
    };
  } finally {
    stop();
  }
}
export async function markGroupRead(
  account: string,
  room: string,
  sequence: number | string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  let changed = false;
  const stop = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  try {
    const result = await loadGroupInbox(account, [room], () => !changed && isCurrent());
    if (result.failedRooms.length) throw new Error('群聊摘要暂不可用，请重试');
    const summary = result.conversations[0];
    if (!isCurrent() || changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!summary || summary.room !== room) throw new Error('群成员资格已失效');
    const response = await fetch(`${apiBaseUrl()}/api/groups/read`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
      body: JSON.stringify({
        ticket: summary.readTicket,
        ...(typeof sequence === 'string' ? { messageId: sequence } : { sequence }),
      }),
    });
    if (!isCurrent() || changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!response.ok) throw new Error('标为已读失败，请重试');
  } finally {
    stop();
  }
}
