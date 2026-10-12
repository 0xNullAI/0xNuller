// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import type { Env } from './index';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { RoomDO } = await import('./room-do');
const dmCode = `dm:${'a'.repeat(64)}`;

function fixture(code: string, legacyPushOutbox = false) {
  const mediaDelete = vi.fn(async () => {});
  const db = new DatabaseSync(':memory:');
  if (legacyPushOutbox)
    db.exec(
      "CREATE TABLE push_outbox(message_id TEXT PRIMARY KEY,recipient_accounts TEXT); INSERT INTO push_outbox VALUES('old','[\"bob\"]')",
    );
  const values = new Map<string, unknown>([
    ['code', code],
    ['persistentHistory', true],
  ]);
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return {
        toArray: () => rows,
        one: () => rows[0],
      };
    },
  } as unknown as SqlStorage;
  const tasks: Promise<unknown>[] = [];
  const attachment = {
    peerId: 'alice-peer',
    accountId: 'alice',
    dmPeerAccountId: 'bob',
    membershipVersion: 1,
    indexRegistered: true,
    name: 'Alice',
    expiresAt: Date.now() + 600_000,
  };
  const socket = {
    deserializeAttachment: () => attachment,
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  const room = new RoomDO(
    {
      storage: {
        sql,
        get: async (key: string) => values.get(key),
        put: async (key: string | Record<string, unknown>, value?: unknown) => {
          for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key))
            values.set(k as string, v);
        },
        setAlarm: vi.fn(),
        transactionSync: <T>(fn: () => T): T => {
          db.exec('BEGIN');
          try {
            const result = fn();
            db.exec('COMMIT');
            return result;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      },
      getWebSockets: () => [socket],
      blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    } as unknown as DurableObjectState,
    { MEDIA: { delete: mediaDelete } } as unknown as Env,
  );
  if (code !== dmCode) {
    db.exec(
      'CREATE TABLE group_memberships(account_id TEXT PRIMARY KEY,name TEXT,state TEXT,version INTEGER,updated_at INTEGER)',
    );
    db.exec(
      "INSERT INTO group_memberships VALUES('alice','Alice','active',1,1),('bob','Bob','active',1,1),('outsider','Outsider','banned',1,1)",
    );
  }
  return { db, room, tasks, socket, mediaDelete };
}
afterEach(() => vi.restoreAllMocks());

it('persists a human message without keeping a system-push outbox', async () => {
  for (const code of ['group', dmCode]) {
    const f = fixture(code, true);
    try {
      await f.room.webSocketMessage(
        f.socket,
        JSON.stringify({ t: 'chat', id: `event-${code}`, x: 'hello' }),
      );
      await Promise.all(f.tasks);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
      // A room created before FCM was retired loses its leftover recipient lists on wake.
      expect(
        f.db.prepare("SELECT name FROM sqlite_master WHERE name='push_outbox'").get(),
      ).toBeUndefined();
    } finally {
      f.db.close();
    }
  }
});

it('lets the sender recall their own message within two minutes and erases it everywhere', async () => {
  const now = Date.parse('2027-01-01T00:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const f = fixture('group');
  try {
    const media = { kind: 'image', id: 'img-1', mime: 'image/png', size: 10 };
    await f.room.webSocketMessage(
      f.socket,
      JSON.stringify({ t: 'chat', id: 'pic', x: '看这张图', m: media }),
    );
    await f.room.webSocketMessage(
      f.socket,
      JSON.stringify({ t: 'chat', id: 'quote', x: '引用', replyToId: 'pic' }),
    );
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    await f.room.webSocketMessage(f.socket, JSON.stringify({ t: 'recall', id: 'pic' }));
    await Promise.all(f.tasks);

    const stored = f.db.prepare("SELECT body FROM messages WHERE id='pic'").get() as {
      body: string;
    };
    expect(JSON.parse(stored.body)).toEqual({ recalled: true });
    expect(f.mediaDelete).toHaveBeenCalledWith(['room/group/img-1']);
    const sent = vi.mocked(f.socket.send).mock.calls.map(([data]) => JSON.parse(String(data)));
    expect(sent).toContainEqual({ t: 'recall', id: 'pic' });

    const { readHistoryPage } = await import('./room-history');
    const history = readHistoryPage((f.room as unknown as { sql: SqlStorage }).sql);
    const recalled = history.messages.find((message) => message.id === 'pic');
    expect(recalled).toMatchObject({ recalled: true });
    expect(recalled?.x).toBeUndefined();
    expect(history.messages.find((message) => message.id === 'quote')?.replyTo).toMatchObject({
      text: '消息已撤回',
      recalled: true,
    });
  } finally {
    f.db.close();
  }
});

it('refuses a recall after two minutes or of a message the account did not send', async () => {
  const now = Date.parse('2027-01-01T00:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const f = fixture('group');
  try {
    await f.room.webSocketMessage(f.socket, JSON.stringify({ t: 'chat', id: 'old', x: 'hi' }));
    f.db.exec("INSERT INTO messages VALUES('bobs','bob-peer','Bob','{\"x\":\"yo\"}',0)");
    f.db.exec("UPDATE message_sequences SET sender_account='bob' WHERE message_id='bobs'");
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60_000 + 1);
    await f.room.webSocketMessage(f.socket, JSON.stringify({ t: 'recall', id: 'old' }));
    await f.room.webSocketMessage(f.socket, JSON.stringify({ t: 'recall', id: 'bobs' }));
    const bodies = f.db.prepare('SELECT body FROM messages ORDER BY id').all() as {
      body: string;
    }[];
    expect(bodies.map((row) => JSON.parse(row.body).recalled)).toEqual([undefined, undefined]);
  } finally {
    f.db.close();
  }
});
