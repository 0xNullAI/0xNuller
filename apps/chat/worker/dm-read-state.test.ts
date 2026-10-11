// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { initializeDmReadState, dmReadState, advanceDmRead } from './dm-read-state';
it('preserves unknown legacy authors, isolates cursors, ignores retries and never reuses deleted sequences', () => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  try {
    db.exec(
      "CREATE TABLE messages(id TEXT PRIMARY KEY,ts INTEGER); INSERT INTO messages VALUES('old',1)",
    );
    initializeDmReadState(sql);
    expect(dmReadState(sql, 'alice')).toEqual({
      lastSequence: 1,
      readSequence: null,
      unread: null,
    });
    expect(advanceDmRead(sql, 'alice', 0)).toBe(true);
    expect(dmReadState(sql, 'alice').unread).toBeNull();
    expect(advanceDmRead(sql, 'alice', 1)).toBe(true);
    db.exec(
      "INSERT INTO messages VALUES('new',2); UPDATE message_sequences SET sender_account='bob' WHERE message_id='new'",
    );
    expect(dmReadState(sql, 'alice').unread).toBe(1);
    expect(dmReadState(sql, 'bob').unread).toBeNull();
    advanceDmRead(sql, 'bob', 1);
    expect(dmReadState(sql, 'bob').unread).toBe(0);
    advanceDmRead(sql, 'alice', 2);
    advanceDmRead(sql, 'alice', 1);
    expect(dmReadState(sql, 'alice').readSequence).toBe(2);
    expect(advanceDmRead(sql, 'alice', 999)).toBe(false);
    db.exec(
      "INSERT INTO messages VALUES('new',2) ON CONFLICT(id) DO NOTHING; DELETE FROM messages WHERE id='new'; INSERT INTO messages VALUES('new',3); INSERT INTO messages VALUES('next',4)",
    );
    expect(db.prepare("SELECT * FROM messages WHERE id='new'").get()).toBeUndefined();
    expect(dmReadState(sql, 'alice').lastSequence).toBeGreaterThan(2);
    initializeDmReadState(sql);
    expect(dmReadState(sql, 'alice').readSequence).toBe(2);
  } finally {
    db.close();
  }
});
