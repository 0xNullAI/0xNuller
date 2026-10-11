import { RECALL_WINDOW_MS, type MediaRef } from './wire';

/** Stored body of a recalled message: the original text, media and mentions are gone. */
export const RECALLED_BODY = '{"recalled":true}';

export function isRecalledBody(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  try {
    return (JSON.parse(body) as { recalled?: unknown }).recalled === true;
  } catch {
    return false;
  }
}

/**
 * Withdraw one's own message. Only the account recorded as its sender may do
 * it (peer ids change every page load), never for an AI reply, and only within
 * RECALL_WINDOW_MS. The row and its sequence stay so read cursors and unread
 * counts remain valid; only its body is erased.
 * Returns the media id to delete from R2, or null when nothing was recalled.
 */
export function recallMessage(
  sql: SqlStorage,
  id: unknown,
  accountId: string,
  now: number,
): { mediaId: string | null } | null {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return null;
  const row = sql
    .exec(
      `SELECT m.body,m.ts,s.sender_account FROM messages m
       JOIN message_sequences s ON s.message_id=m.id WHERE m.id=?`,
      id,
    )
    .toArray()[0];
  if (
    !row ||
    row.sender_account !== accountId ||
    String(row.sender_account).startsWith('agent:') ||
    now - Number(row.ts) > RECALL_WINDOW_MS ||
    isRecalledBody(row.body)
  )
    return null;
  let media: MediaRef | undefined;
  try {
    media = (JSON.parse(String(row.body)) as { m?: MediaRef }).m;
  } catch {
    media = undefined;
  }
  sql.exec('UPDATE messages SET body=? WHERE id=?', RECALLED_BODY, id);
  return { mediaId: typeof media?.id === 'string' ? media.id : null };
}
