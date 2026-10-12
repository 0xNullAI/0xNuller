// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { Env } from './index';
import {
  groupAiReservationKey,
  sha256Body,
  verifyGroupAiTicket,
} from '../../../workers/auth/src/group-ai-ticket';

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

function fixture(proxyResponse: Response) {
  const db = new DatabaseSync(':memory:');
  const values = new Map<string, unknown>([
    ['code', 'managed-room'],
    ['persistentHistory', true],
    ['agentBillingMode', 'managed'],
    ['agent', { name: '助手', persona: '温柔地聊天' }],
    ['hostPeerId', 'host-peer'],
    ['hostAccountId', 'host'],
  ]);
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  const storage = {
    sql,
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => values.set(key, value),
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
  };
  const sockets: WebSocket[] = [];
  const tasks: Promise<unknown>[] = [];
  const llmFetch = vi.fn(async (request: Request) => {
    const body = await request.text();
    const ticket = request.headers.get('X-0xNullAI-Group-Ticket') ?? '';
    const reservationKey = await groupAiReservationKey('managed-room', 'trigger', 'room');
    expect(request.headers.get('Idempotency-Key')).toBe(reservationKey);
    expect(
      await verifyGroupAiTicket('test-secret', ticket, {
        reservationKey,
        modelId: 'balanced',
        bodyHash: await sha256Body(body),
      }),
    ).toMatchObject({ payer: 'alice', triggerId: 'trigger', roleId: 'room' });
    return proxyResponse;
  });
  const room = new RoomDO(
    {
      storage,
      getWebSockets: () => sockets,
      blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    } as unknown as DurableObjectState,
    {
      DM_TICKET_SECRET: 'test-secret',
      LLM: { fetch: llmFetch },
    } as unknown as Env,
  );
  db.exec(
    'CREATE TABLE group_memberships(account_id TEXT PRIMARY KEY,name TEXT,state TEXT,version INTEGER,updated_at INTEGER)',
  );
  db.exec(
    'CREATE TABLE group_account_revocations(account_id TEXT PRIMARY KEY,deletion_id TEXT,revoked_at INTEGER)',
  );
  db.exec(
    "INSERT INTO group_memberships VALUES('alice','Alice','active',1,1),('host','Host','active',1,1)",
  );
  const socket = (peerId: string, accountId: string) => {
    const attachment = {
      peerId,
      accountId,
      membershipVersion: 1,
      indexRegistered: true,
      name: accountId,
      expiresAt: Date.now() + 60_000,
    };
    return {
      deserializeAttachment: () => attachment,
      serializeAttachment: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
  };
  const alice = socket('alice-peer', 'alice');
  const host = socket('host-peer', 'host');
  sockets.push(alice, host);
  const mention = () =>
    room.webSocketMessage(
      alice,
      JSON.stringify({
        t: 'chat',
        id: 'trigger',
        x: '@助手 你好',
        mentions: [{ peerId: 'ai:room', n: '助手' }],
      }),
    );
  return { db, values, room, alice, host, llmFetch, tasks, mention };
}

it('sends a saved reply only after managed settlement, once for a replayed human message', async () => {
  const f = fixture(
    Response.json({
      choices: [{ message: { content: '你好呀' } }],
      credit_charged: 1,
    }),
  );
  try {
    await f.mention();
    await Promise.all(f.tasks);
    await f.mention();
    expect(f.llmFetch).toHaveBeenCalledOnce();
    expect(
      f.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_id='ai:room'").get()?.n,
    ).toBe(1);
    expect(
      f.db.prepare("SELECT response_id FROM room_agent_turns WHERE trigger_id='trigger'").get()
        ?.response_id,
    ).toEqual(expect.any(String));
  } finally {
    f.db.close();
  }
});

it('shows insufficient Credit only to the payer and never writes an AI completion', async () => {
  const f = fixture(
    Response.json({ error: 'Credit 不足', credit: { allowed: false } }, { status: 402 }),
  );
  try {
    await f.mention();
    await Promise.all(f.tasks);
    expect(
      f.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_id='ai:room'").get()?.n,
    ).toBe(0);
    expect(
      vi.mocked(f.alice.send).mock.calls.some(([data]) => String(data).includes('Credit 不足')),
    ).toBe(true);
    expect(
      vi.mocked(f.host.send).mock.calls.some(([data]) => String(data).includes('Credit 不足')),
    ).toBe(false);
    await f.mention();
    expect(f.llmFetch).toHaveBeenCalledOnce();
  } finally {
    f.db.close();
  }
});
