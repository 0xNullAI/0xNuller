/**
 * "清空聊天记录" for one account.
 *
 * A conversation's messages belong to everyone in it, so clearing never deletes them: it records,
 * for the account that asked, the moment before which it no longer sees anything. History,
 * search and the inbox preview read from that moment on; everyone else is unaffected. Messages
 * are stamped by this object's clock, so a server time is a safe cut-off.
 */

const ready = new WeakSet<SqlStorage>();

function ensure(sql: SqlStorage): void {
  if (ready.has(sql)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS history_clears (
    account_id TEXT PRIMARY KEY,
    cleared_at INTEGER NOT NULL
  )`);
  ready.add(sql);
}

/** Messages at or before this time are hidden from `account`; 0 when it never cleared. */
export function historyClearedAt(sql: SqlStorage, account: string | undefined): number {
  if (!account) return 0;
  ensure(sql);
  const row = sql
    .exec('SELECT cleared_at FROM history_clears WHERE account_id=?', account)
    .toArray()[0];
  return row ? Number(row.cleared_at) : 0;
}

export function clearHistoryFor(sql: SqlStorage, account: string, now: number): void {
  ensure(sql);
  sql.exec(
    `INSERT INTO history_clears(account_id,cleared_at) VALUES(?,?)
     ON CONFLICT(account_id) DO UPDATE SET cleared_at=MAX(cleared_at,excluded.cleared_at)`,
    account,
    now,
  );
}

/** The newest message this account still sees, for an inbox preview. */
export function latestVisibleMessage(
  sql: SqlStorage,
  account: string | undefined,
): Record<string, SqlStorageValue> | undefined {
  return sql
    .exec(
      'SELECT body,ts FROM messages WHERE ts>? ORDER BY ts DESC,id DESC LIMIT 1',
      historyClearedAt(sql, account),
    )
    .toArray()[0];
}
