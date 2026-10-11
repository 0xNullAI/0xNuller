/** Additive DO schema. Deleted messages never free or reuse their sequence. */
export function initializeDmReadState(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS message_sequences(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,sender_account TEXT)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS dm_read_cursors(account_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL)',
  );
  sql.exec(
    'INSERT OR IGNORE INTO message_sequences(message_id) SELECT id FROM messages WHERE NOT EXISTS(SELECT 1 FROM message_sequences WHERE message_id=messages.id) ORDER BY ts,id',
  );
  sql.exec(
    `CREATE TRIGGER IF NOT EXISTS message_sequence_tombstone BEFORE INSERT ON messages WHEN EXISTS(SELECT 1 FROM message_sequences WHERE message_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.id) BEGIN SELECT RAISE(IGNORE); END`,
  );
  sql.exec(`CREATE TRIGGER IF NOT EXISTS message_sequence_insert AFTER INSERT ON messages BEGIN
    INSERT OR IGNORE INTO message_sequences(message_id) VALUES(NEW.id); END`);
}
export function dmReadState(sql: SqlStorage, account: string) {
  const lastSequence = Number(
    sql.exec('SELECT COALESCE(MAX(sequence),0) AS value FROM message_sequences').toArray()[0]
      ?.value ?? 0,
  );
  const read = sql
    .exec('SELECT sequence FROM dm_read_cursors WHERE account_id=?', account)
    .toArray()[0];
  const readSequence = read ? Number(read.sequence) : null;
  if (readSequence === null) return { lastSequence, readSequence, unread: null };
  const counts = sql
    .exec(
      `SELECT COUNT(*) AS unread, SUM(CASE WHEN s.sender_account IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM message_sequences s JOIN messages m ON m.id=s.message_id
    WHERE s.sequence>? AND (s.sender_account IS NULL OR s.sender_account<>?)`,
      readSequence,
      account,
    )
    .toArray()[0];
  return {
    lastSequence,
    readSequence,
    unread: Number(counts?.unknown ?? 0) > 0 ? null : Number(counts?.unread ?? 0),
  };
}
export function advanceDmRead(sql: SqlStorage, account: string, sequence: number): boolean {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
  if (sequence > dmReadState(sql, account).lastSequence) return false;
  sql.exec(
    'INSERT INTO dm_read_cursors(account_id,sequence) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)',
    account,
    sequence,
  );
  return true;
}
