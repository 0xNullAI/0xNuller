/// <reference types="node" />
// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { resolveMessageReply } from './message-reply';
import { readHistoryPage } from './room-history';
it('resolves a bounded quote from this room only and replays references without retaining deleted text', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE messages(id TEXT PRIMARY KEY,from_id TEXT,name TEXT,body TEXT,ts INTEGER);' +
        ' CREATE TABLE message_sequences(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,sender_account TEXT)',
    );
    const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
    insert.run('source', 'ai:second', '同名', JSON.stringify({ x: '原文'.repeat(400) }), 1);
    insert.run(
      'reply',
      'human',
      '小雨',
      JSON.stringify({
        x: '这个是什么意思',
        replyToId: 'source',
        m: { kind: 'audio', id: 'voice-reply', mime: 'audio/webm', size: 10 },
      }),
      2,
    );
    insert.run('legacy', 'human', '小雨', JSON.stringify({ x: '旧客户端' }), 3);
    const sql = {
      exec: (query: string, ...args: unknown[]) => ({
        toArray: () => db.prepare(query).all(...(args as never[])),
      }),
    } as unknown as SqlStorage;
    expect(resolveMessageReply(sql, 'source')).toMatchObject({
      senderId: 'ai:second',
      senderName: '同名',
      text: '原文'.repeat(250),
    });
    expect(resolveMessageReply(sql, 'other-room-source')).toMatchObject({
      unavailable: true,
      text: '',
    });
    expect(resolveMessageReply(sql, { id: 'source', text: '伪造' })).toBeUndefined();
    expect(readHistoryPage(sql).messages[1]?.replyTo?.senderId).toBe('ai:second');
    expect(readHistoryPage(sql).messages[1]?.m).toMatchObject({ kind: 'audio', id: 'voice-reply' });
    expect(readHistoryPage(sql).messages[2]?.replyTo).toBeUndefined();
    db.prepare('DELETE FROM messages WHERE id=?').run('source');
    expect(readHistoryPage(sql).messages[0]?.replyTo).toMatchObject({
      unavailable: true,
      text: '',
    });
    expect(db.prepare('SELECT body FROM messages WHERE id=?').get('reply')?.body).not.toContain(
      '原文',
    );
  } finally {
    db.close();
  }
});
