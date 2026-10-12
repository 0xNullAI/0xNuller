/**
 * Timeline layout decisions shared by the AI chat and human chats: when to show a time
 * separator and which rows belong to one sender group. Pure, so both chats agree and the
 * rules stay testable without rendering.
 */

/** A time separator appears when this much time has passed since the previous row. */
export const CONVERSATION_TIME_GAP_MS = 5 * 60_000;

export interface ConversationSequenceItem {
  /** Sender identity for grouping. `null` for rows that are not a message (system notes). */
  sender: string | null;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface ConversationSequencePosition {
  /** Show a time separator above this row. */
  showTime: boolean;
  /** Same sender as the row directly above, with no separator between them. */
  continued: boolean;
  /** Last row of its sender group: the row that carries the avatar. */
  groupEnd: boolean;
}

export function conversationSequence(
  items: readonly ConversationSequenceItem[],
  gapMs = CONVERSATION_TIME_GAP_MS,
): ConversationSequencePosition[] {
  const positions = items.map((item, index): ConversationSequencePosition => {
    const previous = index > 0 ? items[index - 1] : undefined;
    const showTime = !previous || item.at - previous.at >= gapMs;
    const continued =
      !showTime &&
      item.sender !== null &&
      previous !== undefined &&
      previous.sender === item.sender;
    return { showTime, continued, groupEnd: true };
  });
  for (let index = 0; index < positions.length - 1; index += 1) {
    if (positions[index + 1]!.continued) positions[index]!.groupEnd = false;
  }
  return positions;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** "14:05", "昨天 14:05", "3月2日 14:05" or "2025年3月2日 14:05", in local time. */
export function formatConversationTime(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday && at < startOfToday + 86_400_000) return clock;
  const startOfYesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  ).getTime();
  if (at >= startOfYesterday && at < startOfToday) return `昨天 ${clock}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}年${day}`;
}

/**
 * Ids that arrived at the end of the timeline since the previous list. History loaded at
 * the top and the first list of a conversation never count, so only new messages animate.
 */
export function conversationTailArrivals(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  if (previous.length === 0) return [];
  const known = new Set(previous);
  let lastKnown = -1;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (known.has(next[index]!)) {
      lastKnown = index;
      break;
    }
  }
  // No overlap means another conversation, not new messages.
  if (lastKnown < 0) return [];
  return next.slice(lastKnown + 1).filter((id) => !known.has(id));
}
