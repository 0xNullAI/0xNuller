/**
 * Who uploaded each media object, and which message shows it.
 *
 * Media ids come from the client. Without this a member could attach another member's image
 * to a message of their own and then recall it, and the recall deleted the original from R2.
 * Ids are claimed by the uploading account for exactly one message.
 */

const OWNERSHIP_TTL_MS = 30 * 24 * 60 * 60_000;
const ready = new WeakSet<SqlStorage>();

function ensure(sql: SqlStorage): void {
  if (ready.has(sql)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS media_uploads (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    message_id TEXT,
    uploaded_at INTEGER NOT NULL
  )`);
  ready.add(sql);
}

export function recordMediaUpload(sql: SqlStorage, id: string, account: string, now: number) {
  ensure(sql);
  sql.exec('DELETE FROM media_uploads WHERE uploaded_at<?', now - OWNERSHIP_TTL_MS);
  sql.exec(
    'INSERT OR IGNORE INTO media_uploads(id,account,uploaded_at) VALUES(?,?,?)',
    id,
    account,
    now,
  );
}

/**
 * True when `account` uploaded `id` and it is free or already shows this same message (a
 * resend after a lost echo).
 */
export function claimMedia(
  sql: SqlStorage,
  id: string,
  account: string | undefined,
  messageId: string,
): boolean {
  if (!account) return false;
  ensure(sql);
  return (
    sql
      .exec(
        `UPDATE media_uploads SET message_id=? WHERE id=? AND account=?
         AND (message_id IS NULL OR message_id=?) RETURNING id`,
        messageId,
        id,
        account,
        messageId,
      )
      .toArray().length > 0
  );
}

/** Whether any stored message still shows this object. */
export function mediaStillReferenced(sql: SqlStorage, id: string): boolean {
  return (
    sql.exec('SELECT 1 FROM messages WHERE instr(body, ?) > 0 LIMIT 1', `"id":"${id}"`).toArray()
      .length > 0
  );
}
