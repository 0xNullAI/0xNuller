// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  canCompleteRoomAgentTurn,
  claimRoomAgentTurn,
  completeRoomAgentTurn,
  initializeRoomAgentTurns,
  managedRoomAgentTurnCurrent,
} from './room-agent-turn';

const agents = ['room', 'second', 'third'].map((id) => ({ id, name: id, persona: '' }));

function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,from_id TEXT,body TEXT,ts INTEGER)');
  db.exec('CREATE TABLE message_sequences(message_id TEXT PRIMARY KEY,sender_account TEXT)');
  db.exec('CREATE TABLE group_memberships(account_id TEXT PRIMARY KEY,state TEXT)');
  initializeRoomAgentTurns(sql);
  db.prepare('INSERT INTO group_memberships VALUES(?,?)').run('alice', 'active');
  const insert = (
    id: string,
    mentions: string[],
    ts = 100,
    sender = 'human',
    account = 'alice',
  ) => {
    db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(
      id,
      sender,
      JSON.stringify({ mentions: mentions.map((peerId) => ({ peerId, n: peerId })) }),
      ts,
    );
    db.prepare('INSERT INTO message_sequences VALUES(?,?)').run(id, account);
  };
  return { db, sql, insert };
}

it('grants only the configured primary AI from a saved, active human member message', () => {
  const { db, sql, insert } = fixture();
  try {
    insert('message-1', ['ai:room', 'ai:second', 'ai:third']);
    const grant = claimRoomAgentTurn(sql, 'message-1', 'room', 'host', agents, 101);
    expect(grant).toBeTruthy();
    expect(claimRoomAgentTurn(sql, 'message-1', 'room', 'host', agents, 101)).toBeNull();
    expect(claimRoomAgentTurn(sql, 'message-1', 'second', 'host', agents, 101)).toBeNull();
    expect(claimRoomAgentTurn(sql, 'message-1', 'third', 'host', agents, 101)).toBeNull();
    expect(canCompleteRoomAgentTurn(sql, 'message-1', 'room', agents[0], grant, 'host', 102)).toBe(
      true,
    );
    expect(
      canCompleteRoomAgentTurn(
        sql,
        'message-1',
        'room',
        { ...agents[0]!, persona: 'changed' },
        grant,
        'host',
        102,
      ),
    ).toBe(false);
    expect(
      canCompleteRoomAgentTurn(sql, 'message-1', 'room', agents[0], grant, 'other-host', 102),
    ).toBe(false);
    expect(
      canCompleteRoomAgentTurn(sql, 'message-1', 'second', agents[1], grant, 'host', 102),
    ).toBe(false);
    completeRoomAgentTurn(sql, 'message-1', 'room', 'reply-1');
    expect(canCompleteRoomAgentTurn(sql, 'message-1', 'room', agents[0], grant, 'host', 103)).toBe(
      false,
    );
    expect(() => completeRoomAgentTurn(sql, 'message-1', 'room', 'reply-2')).toThrow();
  } finally {
    db.close();
  }
});

it('rejects AI-authored, departed, unknown, old, and unproven human triggers', () => {
  const { db, sql, insert } = fixture();
  try {
    insert('ai-message', ['ai:room'], 100, 'ai:second');
    insert('old-message', ['ai:room'], 100);
    insert('inactive-message', ['ai:room'], 100, 'human', 'bob');
    expect(claimRoomAgentTurn(sql, 'ai-message', 'room', 'host', agents, 101)).toBeNull();
    expect(claimRoomAgentTurn(sql, 'old-message', 'room', 'host', agents, 400_101)).toBeNull();
    expect(claimRoomAgentTurn(sql, 'inactive-message', 'room', 'host', agents, 101)).toBeNull();
    expect(claimRoomAgentTurn(sql, 'missing', 'room', 'host', agents, 101)).toBeNull();
    expect(claimRoomAgentTurn(sql, 'old-message', 'unconfigured', 'host', agents, 101)).toBeNull();
    expect(
      canCompleteRoomAgentTurn(sql, 'old-message', 'room', agents[0], 'fake', 'host', 101),
    ).toBe(false);
  } finally {
    db.close();
  }
});

it('rechecks the saved triggering payer and active membership around managed generation', () => {
  const { db, sql, insert } = fixture();
  try {
    insert('mention', ['ai:room']);
    const grant = claimRoomAgentTurn(sql, 'mention', 'room', 'managed', agents, 101)!;
    expect(
      managedRoomAgentTurnCurrent(sql, 'mention', 'room', agents[0]!, grant, 'alice', 102),
    ).toBe(true);
    expect(managedRoomAgentTurnCurrent(sql, 'mention', 'room', agents[0]!, grant, 'bob', 102)).toBe(
      false,
    );
    db.prepare("UPDATE group_memberships SET state='removed' WHERE account_id='alice'").run();
    expect(
      managedRoomAgentTurnCurrent(sql, 'mention', 'room', agents[0]!, grant, 'alice', 102),
    ).toBe(false);
  } finally {
    db.close();
  }
});

it('caps outstanding claims to four and never reissues a completed or abandoned claim', () => {
  const { db, sql, insert } = fixture();
  try {
    for (let index = 0; index < 5; index++) {
      insert(`message-${index}`, ['ai:room']);
      const grant = claimRoomAgentTurn(sql, `message-${index}`, 'room', 'host', agents, 101);
      expect(Boolean(grant)).toBe(index < 4);
    }
    completeRoomAgentTurn(sql, 'message-0', 'room', 'reply-0');
    expect(claimRoomAgentTurn(sql, 'message-4', 'room', 'host', agents, 102)).toBeTruthy();
    expect(claimRoomAgentTurn(sql, 'message-0', 'room', 'new-host', agents, 102)).toBeNull();
  } finally {
    db.close();
  }
});

it('caps aggregate grants before model calls even when earlier replies completed quickly', () => {
  const { db, sql, insert } = fixture();
  try {
    for (let index = 0; index < 13; index++) {
      const id = `burst-${index}`;
      insert(id, ['ai:room']);
      const grant = claimRoomAgentTurn(sql, id, 'room', 'host', agents, 101);
      expect(Boolean(grant)).toBe(index < 12);
      if (grant) completeRoomAgentTurn(sql, id, 'room', `reply-${index}`);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM room_agent_turns').get()?.n).toBe(12);
  } finally {
    db.close();
  }
});
