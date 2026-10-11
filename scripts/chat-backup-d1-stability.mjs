import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// These tables can change the recovered conversation, its private context, or deletion state.
// A second export is still not a cross-service transaction; it only closes one observable gap.
const CHAT_TABLES = [
  'server_conversations',
  'server_conversation_messages',
  'private_conversation_attachments',
  'user_chat_rooms',
  'account_deletions',
  'character_relationships',
  'personal_memories',
  'memory_summary_sources',
  'conversation_digests',
];

function valueForHash(value) {
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return { integer: value.toString() };
  return value;
}

export function digestChatTables(sql) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw new Error('Auth D1 export failed integrity check');
    const digest = createHash('sha256');
    for (const table of CHAT_TABLES) {
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
      if (!columns.length) throw new Error('Auth D1 export is missing a chat backup table');
      digest.update(JSON.stringify([table, columns]));
      digest.update('\n');
      const ordering = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(',');
      for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY ${ordering}`).iterate()) {
        digest.update(JSON.stringify(columns.map((column) => valueForHash(row[column]))));
        digest.update('\n');
      }
    }
    return digest.digest('hex');
  } finally {
    db.close();
  }
}

/** Compare private chat-related state without printing or persisting plaintext values. */
export async function assertAuthD1ChatTablesStable(firstSqlPath, lastSqlPath) {
  const first = digestChatTables(await readFile(firstSqlPath, 'utf8'));
  const last = digestChatTables(await readFile(lastSqlPath, 'utf8'));
  if (first !== last) throw new Error('Auth chat state changed during backup capture');
  return { state: 'chat-tables-matched', tables: CHAT_TABLES.length };
}
