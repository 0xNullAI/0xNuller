import { resolveMessageReply } from './message-reply';
import type { WireChat } from './wire';
export interface HistoryCursor {
  ts: number;
  id: string;
}
export const HISTORY_PAGE_SIZE = 100;
export function parseHistoryCursor(value: unknown): HistoryCursor | null {
  if (!value || typeof value !== 'object') return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.ts === 'number' &&
    Number.isSafeInteger(cursor.ts) &&
    cursor.ts >= 0 &&
    typeof cursor.id === 'string' &&
    cursor.id.length > 0 &&
    cursor.id.length <= 256
    ? { ts: cursor.ts, id: cursor.id }
    : null;
}
/** A bounded page; the paired cursor keeps messages with identical timestamps. */
export function readHistoryPage(
  sql: SqlStorage,
  before?: HistoryCursor,
  pageSize = HISTORY_PAGE_SIZE,
) {
  const rows = sql
    .exec(
      `SELECT m.id,m.from_id,m.name,m.body,m.ts,s.sender_account FROM messages m
       LEFT JOIN message_sequences s ON s.message_id=m.id
       ${before ? 'WHERE m.ts < ? OR (m.ts = ? AND m.id < ?)' : ''} ORDER BY m.ts DESC,m.id DESC LIMIT ?`,
      ...(before ? [before.ts, before.ts, before.id] : []),
      pageSize + 1,
    )
    .toArray();
  const page = rows.slice(0, pageSize).reverse();
  const messages: WireChat[] = page.map((row) => {
    const body = JSON.parse(row.body as string) as Pick<WireChat, 'x' | 'm' | 'mentions'> & {
      replyToId?: string;
    };
    return {
      id: row.id as string,
      _from: row.from_id as string,
      // Agent replies are attributed to `agent:…`, which is not an account.
      ...(typeof row.sender_account === 'string' && !row.sender_account.startsWith('agent:')
        ? { _account: row.sender_account }
        : {}),
      n: row.name as string,
      ts: row.ts as number,
      x: body.x,
      m: body.m,
      mentions: body.mentions,
      replyTo: resolveMessageReply(sql, body.replyToId),
    };
  });
  const oldest = messages[0];
  return {
    t: 'history' as const,
    messages,
    older: Boolean(before),
    before: rows.length > pageSize && oldest ? { ts: oldest.ts, id: oldest.id } : null,
  };
}
