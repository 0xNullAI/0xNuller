import { expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAuthD1ChatTablesStable, digestChatTables } from './chat-backup-d1-stability.mjs';

const tables = [
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

function sql(rows = [], other = '') {
  return [
    ...tables.map((table) => `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, value TEXT);`),
    'CREATE TABLE unrelated_setting (id TEXT);',
    ...rows,
    other,
  ].join('\n');
}

test('D1 chat digest ignores unrelated account changes and SQL insertion order', () => {
  const before = sql([
    "INSERT INTO server_conversation_messages VALUES ('a','first');",
    "INSERT INTO server_conversation_messages VALUES ('b','second');",
  ]);
  const after = sql(
    [
      "INSERT INTO server_conversation_messages VALUES ('b','second');",
      "INSERT INTO server_conversation_messages VALUES ('a','first');",
    ],
    "INSERT INTO unrelated_setting VALUES ('changed');",
  );
  expect(digestChatTables(before)).toBe(digestChatTables(after));
});

test('D1 postflight rejects message, memory and deletion-state changes without exposing values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'd1-stability-'));
  const first = join(root, 'first.sql');
  const last = join(root, 'last.sql');
  try {
    await writeFile(first, sql());
    await writeFile(last, sql());
    await expect(assertAuthD1ChatTablesStable(first, last)).resolves.toEqual({
      state: 'chat-tables-matched',
      tables: 9,
    });
    for (const table of [
      'server_conversation_messages',
      'personal_memories',
      'account_deletions',
    ]) {
      await writeFile(last, sql([`INSERT INTO "${table}" VALUES ('private-id','secret');`]));
      await expect(assertAuthD1ChatTablesStable(first, last)).rejects.toThrow(
        'Auth chat state changed during backup capture',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D1 postflight rejects missing chat tables', () => {
  expect(() => digestChatTables('CREATE TABLE server_conversations (id TEXT);')).toThrow(
    'missing a chat backup table',
  );
});
