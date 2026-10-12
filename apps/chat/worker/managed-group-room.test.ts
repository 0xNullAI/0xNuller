// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { Env } from './index';
import { signDmTicket } from '../../../workers/auth/src/dm-ticket';
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
const { initializeRoomAgents } = await import('./room-agents');

const SECRET = 'test-secret';
const ROOM = 'managed-room';

function fixture(
  proxyResponse: () => Response = () =>
    Response.json({ choices: [{ message: { content: '你好呀' } }], credit_charged: 1 }),
  initial: [string, unknown][] = [],
) {
  const db = new DatabaseSync(':memory:');
  const values = new Map<string, unknown>([
    ['code', ROOM],
    ['persistentHistory', true],
    ['ownerAccountId', 'boss'],
    ...initial,
  ]);
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
  const storage = {
    sql,
    get: async (key: string) => values.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key))
        values.set(k as string, v);
    },
    delete: async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key);
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
  };
  const sockets: WebSocket[] = [];
  const tasks: Promise<unknown>[] = [];
  const tickets: { payer: string; roleId: string; characterId?: string }[] = [];
  const llmFetch = vi.fn(async (request: Request) => {
    const body = await request.text();
    const ticket = request.headers.get('X-0xNullAI-Group-Ticket') ?? '';
    const key = request.headers.get('Idempotency-Key') ?? '';
    const claim = await verifyGroupAiTicket(SECRET, ticket, {
      reservationKey: key,
      modelId: 'balanced',
      bodyHash: await sha256Body(body),
    });
    expect(claim).not.toBeNull();
    expect(key).toBe(await groupAiReservationKey(ROOM, claim!.triggerId, claim!.roleId));
    tickets.push(claim!);
    return proxyResponse();
  });
  const registry = {
    registerGroup: vi.fn(async () => ({ allowed: true, deletionId: null })),
  };
  const room = new RoomDO(
    {
      storage,
      getWebSockets: () => sockets,
      blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    } as unknown as DurableObjectState,
    {
      DM_TICKET_SECRET: SECRET,
      LLM: { fetch: llmFetch },
      ACCOUNT_REGISTRY: { idFromName: (id: string) => id, get: () => registry },
    } as unknown as Env,
  );
  db.exec(
    'CREATE TABLE group_memberships(account_id TEXT PRIMARY KEY,name TEXT,state TEXT,version INTEGER,updated_at INTEGER)',
  );
  db.exec(
    'CREATE TABLE group_account_revocations(account_id TEXT PRIMARY KEY,deletion_id TEXT,revoked_at INTEGER)',
  );
  // The room creates it lazily; the assertions read it before the room may have.
  initializeRoomAgents(sql);
  const member = (account: string, name: string) => {
    db.prepare("INSERT OR REPLACE INTO group_memberships VALUES(?,?,'active',1,1)").run(
      account,
      name,
    );
    const attachment = {
      peerId: `${account}-peer`,
      accountId: account,
      membershipVersion: 1,
      indexRegistered: true,
      name,
      expiresAt: Date.now() + 60_000,
    };
    const socket = {
      deserializeAttachment: () => attachment,
      serializeAttachment: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    sockets.push(socket);
    return socket;
  };
  const send = (socket: WebSocket, frame: Record<string, unknown>) =>
    room.webSocketMessage(socket, JSON.stringify(frame));
  const sent = (socket: WebSocket) =>
    vi.mocked(socket.send).mock.calls.map(([data]) => JSON.parse(String(data)));
  const groupAgentTicket = (account: string, room = ROOM, characterId = 'kitty') =>
    signDmTicket(SECRET, {
      aud: 'group-agent',
      sub: account,
      room,
      characterId,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  const bring = async (socket: WebSocket, account: string, name = '小助手') =>
    send(socket, {
      t: 'agent-add',
      ticket: await groupAgentTicket(account),
      name,
      persona: '温柔地聊天',
    });
  const agents = () =>
    db.prepare('SELECT id,owner_account,name FROM room_agents ORDER BY created_at').all() as {
      id: string;
      owner_account: string;
      name: string;
    }[];
  const mention = (socket: WebSocket, agentId: string, id = 'trigger') =>
    send(socket, {
      t: 'chat',
      id,
      x: '@小助手 你好',
      mentions: [{ peerId: `ai:${agentId}`, n: '小助手' }],
    });
  const aiReplies = () =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_id LIKE 'ai:%'").get()?.n);
  return {
    db,
    values,
    room,
    tasks,
    tickets,
    llmFetch,
    member,
    send,
    sent,
    groupAgentTicket,
    bring,
    agents,
    mention,
    aiReplies,
  };
}

it('lets a member bring one own AI with a ticket for this group, at most three per group', async () => {
  const f = fixture();
  try {
    const alice = f.member('alice', 'Alice');
    await f.send(alice, { t: 'agent-add', ticket: 'forged', name: 'X', persona: '' });
    await f.send(alice, {
      t: 'agent-add',
      ticket: await f.groupAgentTicket('bob'),
      name: 'X',
      persona: '',
    });
    await f.send(alice, {
      t: 'agent-add',
      ticket: await f.groupAgentTicket('alice', 'other-room'),
      name: 'X',
      persona: '',
    });
    expect(f.agents()).toEqual([]);
    await f.bring(alice, 'alice');
    expect(f.agents()).toEqual([expect.objectContaining({ owner_account: 'alice' })]);
    const frame = f.sent(alice).findLast((data) => data.t === 'agent');
    expect(frame).toMatchObject({
      host: '',
      billingMode: 'managed',
      agents: [{ name: '小助手', owner: 'alice', ownerName: 'Alice', dailyCap: null }],
    });
    expect(frame.agents[0]).not.toHaveProperty('characterId');
    await f.bring(alice, 'alice', '第二个');
    expect(f.sent(alice).at(-1)).toMatchObject({ t: 'agent-error' });
    for (const account of ['bob', 'carol']) await f.bring(f.member(account, account), account);
    await f.bring(f.member('dave', 'Dave'), 'dave');
    expect(f.agents()).toHaveLength(3);
  } finally {
    f.db.close();
  }
});

it('lets only the owner set the cap or withdraw, the group owner remove, and leaving retire it', async () => {
  const f = fixture();
  try {
    const alice = f.member('alice', 'Alice');
    const bob = f.member('bob', 'Bob');
    const boss = f.member('boss', 'Boss');
    await f.bring(alice, 'alice');
    const { id } = f.agents()[0]!;
    await f.send(bob, { t: 'agent-cap', agentId: id, dailyCap: 1 });
    await f.send(bob, { t: 'agent-remove', agentId: id });
    expect(db(f).daily_cap).toBeNull();
    expect(f.agents()).toHaveLength(1);
    await f.send(alice, { t: 'agent-cap', agentId: id, dailyCap: -1 });
    expect(db(f).daily_cap).toBeNull();
    await f.send(alice, { t: 'agent-cap', agentId: id, dailyCap: 5 });
    expect(db(f).daily_cap).toBe(5);
    await f.send(boss, { t: 'agent-remove', agentId: id });
    expect(f.agents()).toEqual([]);
    await f.bring(alice, 'alice');
    await f.send(alice, { t: 'membership-leave' });
    expect(f.agents()).toEqual([]);
  } finally {
    f.db.close();
  }
});

function db(f: ReturnType<typeof fixture>) {
  return f.db.prepare('SELECT daily_cap FROM room_agents').get() as { daily_cap: number | null };
}

it("bills the AI's owner when another member @-mentions it, once per message", async () => {
  const f = fixture();
  try {
    const alice = f.member('alice', 'Alice');
    const bob = f.member('bob', 'Bob');
    await f.bring(alice, 'alice');
    const { id } = f.agents()[0]!;
    await f.mention(bob, id);
    await Promise.all(f.tasks);
    await f.mention(bob, id);
    await Promise.all(f.tasks);
    expect(f.llmFetch).toHaveBeenCalledOnce();
    expect(f.tickets[0]).toMatchObject({ payer: 'alice', roleId: id, characterId: 'kitty' });
    expect(f.aiReplies()).toBe(1);
    expect(f.db.prepare('SELECT credits FROM room_agent_spend WHERE agent_id=?').get(id)).toEqual({
      credits: 1,
    });
  } finally {
    f.db.close();
  }
});

it('tells the asker it cannot reply and the owner why, without writing an AI message', async () => {
  const f = fixture(() =>
    Response.json({ error: 'Credit 不足', credit: { allowed: false } }, { status: 402 }),
  );
  try {
    const alice = f.member('alice', 'Alice');
    const bob = f.member('bob', 'Bob');
    const carol = f.member('carol', 'Carol');
    await f.bring(alice, 'alice');
    await f.mention(bob, f.agents()[0]!.id);
    await Promise.all(f.tasks);
    expect(f.aiReplies()).toBe(0);
    const status = (socket: WebSocket) =>
      f
        .sent(socket)
        .filter((data) => data.t === 'agent-run-status')
        .map((data) => data.message);
    expect(status(alice)).toEqual(['「小助手」Credit 不足，没有回复']);
    expect(status(bob)).toEqual(['「小助手」暂时无法回复']);
    expect(status(carol)).toEqual([]);
  } finally {
    f.db.close();
  }
});

it('stops replying once the owner daily cap is used up', async () => {
  const f = fixture(() =>
    Response.json({ choices: [{ message: { content: '好' } }], credit_charged: 3 }),
  );
  try {
    const alice = f.member('alice', 'Alice');
    const bob = f.member('bob', 'Bob');
    await f.bring(alice, 'alice');
    const { id } = f.agents()[0]!;
    await f.send(alice, { t: 'agent-cap', agentId: id, dailyCap: 2 });
    await f.mention(bob, id, 'first');
    await Promise.all(f.tasks);
    await f.mention(bob, id, 'second');
    await Promise.all(f.tasks);
    expect(f.llmFetch).toHaveBeenCalledOnce();
    expect(
      f.sent(bob).some((data) => data.t === 'agent-run-status' && data.message.includes('额度')),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});

it('gives a pre-ownership AI to the group owner and keeps its sender id', async () => {
  const f = fixture(undefined, [
    ['agent', { name: '老助手', persona: '旧人设' }],
    ['agentBillingMode', 'host-byok'],
    ['hostPeerId', 'someone'],
  ]);
  try {
    const bob = f.member('bob', 'Bob');
    f.member('boss', 'Boss');
    await f.mention(bob, 'room');
    await Promise.all(f.tasks);
    expect(f.agents()).toEqual([{ id: 'room', owner_account: 'boss', name: '老助手' }]);
    expect(f.values.has('agent')).toBe(false);
    expect(f.values.has('hostPeerId')).toBe(false);
    // Migrated AIs have no character behind them, so the ticket carries none.
    expect(f.tickets[0]).toMatchObject({ payer: 'boss', roleId: 'room' });
    expect(f.tickets[0]).not.toHaveProperty('characterId');
  } finally {
    f.db.close();
  }
});

it('keeps an ownerless pre-ownership AI stored until the group has an owner', async () => {
  const f = fixture(undefined, [
    ['ownerAccountId', undefined],
    ['agent', { name: '老助手', persona: '' }],
  ]);
  try {
    const bob = f.member('bob', 'Bob');
    await f.mention(bob, 'room');
    expect(f.agents()).toEqual([]);
    expect(f.values.get('agent')).toEqual({ name: '老助手', persona: '' });
    expect(f.llmFetch).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('refuses old host-run frames: nobody speaks or commands as an AI, and old setup is declined', async () => {
  const f = fixture();
  try {
    const alice = f.member('alice', 'Alice');
    const bob = f.member('bob', 'Bob');
    await f.bring(alice, 'alice');
    const { id } = f.agents()[0]!;
    await f.send(alice, { t: 'chat', id: 'spoof', as: `ai:${id}`, x: 'fake' });
    expect(f.aiReplies()).toBe(0);
    await f.send(alice, { t: 'agent-claim', requestId: 'r1', triggerId: 'x', roleId: id });
    expect(f.sent(alice).at(-1)).toEqual({
      t: 'agent-claim-result',
      requestId: 'r1',
      grantId: null,
    });
    await f.send(alice, { t: 'agent', agent: { name: 'Old', persona: '' } });
    expect(f.sent(alice).at(-1)).toMatchObject({ t: 'agent-error' });
    await f.send(alice, {
      t: 'cmd',
      to: 'bob-peer',
      as: `ai:${id}`,
      a: 'adjust_strength',
      c: 'A',
      v: 5,
    });
    expect(f.sent(bob).at(-1)).toMatchObject({ t: 'cmd', _from: 'alice-peer' });
    expect(f.sent(bob).at(-1)).not.toHaveProperty('as');
  } finally {
    f.db.close();
  }
});
