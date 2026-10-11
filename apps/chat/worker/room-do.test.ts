// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from './index';
import { ROOM_IDLE_MS } from './wire';

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

function room(code = 'test-room', idleSince = Date.now() - ROOM_IDLE_MS) {
  const values = new Map<string, unknown>([
    ['code', code],
    ['idleSince', idleSince],
  ]);
  const sockets: WebSocket[] = [];
  const sql = {
    exec: vi.fn((_query: string, ..._args: unknown[]) => ({ toArray: (): unknown[] => [] })),
  };
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
    deleteAlarm: vi.fn(),
    transactionSync: (fn: () => unknown) => fn(),
  };
  const media = {
    list: vi.fn(async () => ({
      objects: [{ key: `room/${code}/image`, uploaded: new Date(0) }],
      truncated: false,
    })),
    delete: vi.fn(),
  };
  const lobby = vi.fn(async (_url: string, _options: RequestInit) => new Response('ok'));
  const roomIndex = {
    register: vi.fn(async (_code: string, _kind: string) => {}),
    tombstone: vi.fn(async () => {}),
  };
  const registry = {
    registerGroup: vi.fn(async () => ({ allowed: true, deletionId: null as string | null })),
    isActive: vi.fn(async () => true),
    acknowledge: vi.fn(async () => {}),
  };
  const instance = new RoomDO(
    {
      storage,
      getWebSockets: () => sockets,
      blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    } as unknown as DurableObjectState,
    {
      ACCOUNT_REGISTRY: {
        idFromName: (id: string) => id,
        get: () => registry,
      },
      MEDIA: media,
      LOBBY: { idFromName: (id: string) => id, get: () => ({ fetch: lobby }) },
      ROOM_INDEX: { idFromName: (id: string) => id, get: () => roomIndex },
    } as unknown as Env,
  );
  const originalMessage = instance.webSocketMessage.bind(instance);
  instance.webSocketMessage = async (ws, message) => {
    // Most tests exercise another boundary with a currently valid admission lease.
    for (const socket of new Set([ws, ...sockets])) {
      if (!socket.deserializeAttachment) continue;
      const original = socket.deserializeAttachment.bind(socket);
      const att = original();
      if (att && !Object.hasOwn(att, 'expiresAt'))
        socket.deserializeAttachment = () => ({ ...original(), expiresAt: Date.now() + 60000 });
      if (!socket.serializeAttachment) socket.serializeAttachment = vi.fn();
    }
    return originalMessage(ws, message);
  };
  return { instance, values, sockets, sql, storage, media, lobby, registry, roomIndex };
}
afterEach(() => vi.restoreAllMocks());
it('keeps DM media bound to a live, unrevoked account socket', async () => {
  const code = `dm:${'a'.repeat(64)}`;
  const token = 'b'.repeat(64);
  const r = room(code);
  const issuedAt = Date.now() - 1_000;
  const socket = {
    deserializeAttachment: () => ({
      mediaToken: token,
      accountId: 'alice',
      dmPeerAccountId: 'bob',
      dmIssuedAt: issuedAt,
      expiresAt: Date.now() + 60_000,
    }),
  } as unknown as WebSocket;
  r.sockets.push(socket);
  expect(await r.instance.authorizeMediaUpload(code, token)).toBe(true);
  expect(await r.instance.authorizeMediaRead(code, token)).toBe(true);
  expect(await r.instance.authorizeMediaRead(code, 'wrong')).toBe(false);
  await r.storage.put('revokedAt', issuedAt);
  expect(await r.instance.authorizeMediaRead(code, token)).toBe(false);
  await r.storage.delete('revokedAt');
  r.registry.isActive.mockResolvedValue(false);
  expect(await r.instance.authorizeMediaUpload(code, token)).toBe(false);
});
it('exports persisted raw rows only for the exact room code with a descending cursor', async () => {
  const r = room('backup-room');
  r.sql.exec.mockImplementation((query: string) => ({
    one: () => ({ n: 101 }),
    toArray: () =>
      query.includes('SELECT m.id,m.from_id,m.name,m.body,m.ts,s.sender_account')
        ? Array.from({ length: 101 }, (_, index) => ({
            id: `m${101 - index}`,
            ts: 101 - index,
            from_id: 'alice',
            name: 'Alice',
            body: '{"x":"hello"}',
          }))
        : [],
  }));
  expect(await r.instance.exportBackupMessages('wrong-room')).toMatchObject({
    exists: false,
    messages: [],
    totalMessages: 0,
  });
  const page = await r.instance.exportBackupMessages('backup-room', { ts: 200, id: 'z' });
  expect(page.messages).toHaveLength(100);
  expect(page.exists).toBe(true);
  expect(page.totalMessages).toBe(101);
  expect(page.before).toEqual({ ts: 2, id: 'm2' });
  expect(r.sql.exec).toHaveBeenCalledWith(
    expect.stringContaining('WHERE m.ts < ? OR (m.ts = ? AND m.id < ?)'),
    200,
    200,
    'z',
  );
});
it('ignores invalid or oversized websocket envelopes before accessing identity or SQL', async () => {
  const r = room();
  const ws = { deserializeAttachment: vi.fn() } as unknown as WebSocket;
  for (const message of ['null', '[]', '1', '"chat"', 'x'.repeat(128_001)])
    await RoomDO.prototype.webSocketMessage.call(r.instance, ws, message);
  expect(ws.deserializeAttachment).not.toHaveBeenCalled();
});
it('rejects reserved AI peer identities and a duplicate live peer before websocket admission', async () => {
  const r = room('active-group', Date.now());
  const request = (peerId: string) =>
    new Request(`https://room.test/?code=active-group&id=${encodeURIComponent(peerId)}`, {
      headers: {
        Upgrade: 'websocket',
        'X-Ticket-Expires-At': String(Date.now() + 60_000),
        'X-Chat-Account': 'alice',
      },
    });
  expect((await r.instance.fetch(request('ai:room'))).status).toBe(400);
  // A refused request must not put the room into the backup index.
  expect(r.roomIndex.register).not.toHaveBeenCalled();
  r.sockets.push({ deserializeAttachment: () => ({ peerId: 'existing' }) } as unknown as WebSocket);
  expect((await r.instance.fetch(request('existing'))).status).toBe(409);
  expect(r.roomIndex.register).toHaveBeenCalledWith('active-group', 'group');
});
it('reclaims expired history and media, unlists the room and keeps a closed tombstone', async () => {
  const r = room();
  expect(await r.instance.recycleIdleRoom(Date.now())).toBe(true);
  expect(r.values.get('closed')).toBe(true);
  expect(r.media.delete).toHaveBeenCalledWith(['room/test-room/image']);
  expect(r.sql.exec).toHaveBeenCalledWith('DELETE FROM messages');
  expect(JSON.parse(r.lobby.mock.calls[0]![1]!.body as string).listed).toBe(false);
  expect(r.storage.deleteAlarm).toHaveBeenCalled();
});
it('preserves occupied rooms, recent rooms and direct messages', async () => {
  const occupied = room();
  occupied.sockets.push({} as WebSocket);
  for (const r of [
    occupied,
    room('recent', Date.now() - ROOM_IDLE_MS + 10000),
    room('dm:' + 'a'.repeat(64)),
  ]) {
    expect(await r.instance.recycleIdleRoom(Date.now())).toBe(false);
    expect(r.media.delete).not.toHaveBeenCalled();
  }
});
it('prefers an updated agent-turn-capable participant when handing over a mixed-version host', async () => {
  const r = room();
  r.values.set('hostPeerId', 'legacy');
  const socket = (peerId: string, agentTurnCapable: boolean) =>
    ({
      deserializeAttachment: () => ({ peerId, agentTurnCapable }),
      send: vi.fn(),
    }) as unknown as WebSocket;
  r.sockets.push(socket('legacy', false), socket('updated', true));
  const select = r.instance as unknown as {
    ensureHost(candidate: string): Promise<{ host: string; changed: boolean }>;
  };
  expect(await select.ensureHost('updated')).toEqual({ host: 'updated', changed: true });
  expect(r.values.get('hostPeerId')).toBe('updated');
  expect(await select.ensureHost('legacy')).toEqual({ host: 'updated', changed: false });
});
it('keeps a retry alarm and history if media cleanup fails', async () => {
  const r = room();
  r.media.delete.mockRejectedValueOnce(new Error('R2 unavailable'));
  await expect(r.instance.recycleIdleRoom(Date.now())).rejects.toThrow('R2 unavailable');
  expect(r.values.get('closed')).toBe(true);
  expect(r.storage.setAlarm).toHaveBeenCalled();
  expect(r.sql.exec).not.toHaveBeenCalledWith('DELETE FROM messages');
  expect(await r.instance.recycleIdleRoom(Date.now())).toBe(true);
});
it('rejects invalid initial room names at the server boundary', async () => {
  const r = room();
  const ws = {
    deserializeAttachment: () => ({ peerId: 'peer' }),
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  await r.instance.webSocketMessage(
    ws,
    JSON.stringify({ t: 'hello', claim: true, roomName: '短' }),
  );
  expect(ws.close).toHaveBeenCalledWith(1008, '房间名必须为 4–40 个字符');
  expect(r.values.has('public')).toBe(false);
});

it('starts idle timing on disconnect and reclaims through the scheduled alarm', async () => {
  const r = room();
  r.values.delete('idleSince');
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const socket = { deserializeAttachment: () => null } as unknown as WebSocket;
  await r.instance.webSocketClose(socket);
  expect(r.values.get('idleSince')).toBe(now);
  expect(r.storage.setAlarm).toHaveBeenCalled();
  vi.mocked(Date.now).mockReturnValue(now + ROOM_IDLE_MS);
  await r.instance.alarm();
  expect(r.values.get('closed')).toBe(true);
  expect(r.sql.exec).toHaveBeenCalledWith('DELETE FROM messages');
});

/** Every account is an active member at version 1 and none is revoked. */
function activeMembers(r: ReturnType<typeof room>) {
  r.sql.exec.mockImplementation(((query: string, ...args: unknown[]) => ({
    toArray: () =>
      query.includes('group_account_revocations')
        ? []
        : query.includes('FROM group_memberships')
          ? [{ account_id: args[0], name: '', state: 'active', version: 1, updated_at: 1 }]
          : [],
  })) as never);
}
it('rejects oversized room agent updates without truncating or replacing the persisted persona', async () => {
  const r = room();
  const original = { name: '旧名字', persona: '完整的人设' };
  r.values.set('agent', original);
  r.values.set('ownerAccountId', 'owner-account');
  activeMembers(r);
  const ws = {
    deserializeAttachment: () => ({
      peerId: 'owner',
      accountId: 'owner-account',
      membershipVersion: 1,
      indexRegistered: true,
    }),
    send: vi.fn(),
  } as unknown as WebSocket;
  for (const agent of [
    { name: '新名字', persona: '人'.repeat(4001) },
    { name: '名'.repeat(41), persona: '新的人设' },
  ]) {
    await r.instance.webSocketMessage(ws, JSON.stringify({ t: 'agent', agent }));
    expect(r.values.get('agent')).toEqual(original);
    expect(JSON.parse(vi.mocked(ws.send).mock.calls.at(-1)![0] as string)).toMatchObject({
      t: 'agent-error',
      message: expect.stringContaining('原配置未更改'),
    });
  }
  const valid = { name: '名'.repeat(40), persona: '人'.repeat(4000) };
  await r.instance.webSocketMessage(ws, JSON.stringify({ t: 'agent', agent: valid }));
  expect(r.values.get('agent')).toEqual(valid);
});
it('长期群闲置满 30 天同样回收，未满不回收', async () => {
  const fresh = room('fresh-room', Date.now() - ROOM_IDLE_MS + 60_000);
  fresh.values.set('persistentHistory', true);
  expect(await fresh.instance.recycleIdleRoom(Date.now() - ROOM_IDLE_MS)).toBe(false);
  expect(fresh.sql.exec).not.toHaveBeenCalledWith('DELETE FROM messages');
  const r = room();
  r.values.set('persistentHistory', true);
  expect(await r.instance.recycleIdleRoom(Date.now() - ROOM_IDLE_MS)).toBe(true);
  expect(r.sql.exec).toHaveBeenCalledWith('DELETE FROM messages');
  expect(ROOM_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
});
it('升级长期群仍要求群主账号，主持人和普通参与者都不能更改保留策略', async () => {
  const r = room();
  r.values.set('public', false);
  r.values.set('ownerAccountId', 'owner-account');
  // The live host runs the AI loop; it is not the owner and must not administer.
  r.values.set('hostPeerId', 'host');
  activeMembers(r);
  const makeSocket = (peerId: string, accountId: string) =>
    ({
      deserializeAttachment: () => ({
        peerId,
        accountId,
        membershipVersion: 1,
        indexRegistered: true,
      }),
      send: vi.fn(),
    }) as unknown as WebSocket;
  for (const [peerId, accountId] of [
    ['guest', 'guest-account'],
    ['host', 'host-account'],
  ]) {
    await r.instance.webSocketMessage(
      makeSocket(peerId!, accountId!),
      JSON.stringify({ t: 'group', persistentHistory: true }),
    );
    expect(r.values.get('persistentHistory')).not.toBe(true);
  }
  await r.instance.webSocketMessage(
    makeSocket('owner', 'owner-account'),
    JSON.stringify({ t: 'group', persistentHistory: true }),
  );
  expect(r.values.get('persistentHistory')).toBe(true);
});
it('不转发参与者伪造的服务器历史与会话管理帧', async () => {
  const r = room();
  const sender = {
    deserializeAttachment: () => ({ peerId: 'sender' }),
    send: vi.fn(),
  } as unknown as WebSocket;
  const receiver = {
    deserializeAttachment: () => ({ peerId: 'receiver' }),
    send: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(sender, receiver);
  for (const t of ['history', 'media-auth', 'sys', 'agent-error']) {
    await r.instance.webSocketMessage(
      sender,
      JSON.stringify({ t, messages: [{ id: 'spoof', x: 'fake' }], kind: 'closed', token: 'fake' }),
    );
  }
  expect(receiver.send).not.toHaveBeenCalled();
});

it('stores at most one AI, clears legacy extras on updates, and enforces exact host identity', async () => {
  const r = room();
  r.values.set('persistentHistory', true);
  activeMembers(r);
  r.values.set('hostPeerId', 'owner');
  r.values.set('hostAccountId', 'owner-account');
  r.values.set('ownerAccountId', 'owner-account');
  const owner = {
    deserializeAttachment: () => ({
      peerId: 'owner',
      name: 'Owner',
      accountId: 'owner-account',
      membershipVersion: 1,
      indexRegistered: true,
    }),
    send: vi.fn(),
  } as unknown as WebSocket;
  const guest = {
    deserializeAttachment: () => ({
      peerId: 'guest',
      name: 'Guest',
      accountId: 'guest-account',
      membershipVersion: 1,
      indexRegistered: true,
    }),
    send: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(owner, guest);
  const agents = [
    { id: 'room', name: 'A', persona: 'a' },
    { id: 'friend', name: 'B', persona: 'b' },
  ];
  await r.instance.webSocketMessage(guest, JSON.stringify({ t: 'agent', agents }));
  expect(r.values.get('additionalAgents')).toBeUndefined();
  await r.instance.webSocketMessage(owner, JSON.stringify({ t: 'agent', agents }));
  expect(JSON.parse(vi.mocked(owner.send).mock.calls.at(-1)![0] as string).t).toBe('agent-error');
  expect(r.values.get('additionalAgents')).toBeUndefined();
  await r.instance.webSocketMessage(owner, JSON.stringify({ t: 'agent', agents: [agents[0]] }));
  expect(r.values.get('agent')).toEqual({ name: 'A', persona: 'a' });
  expect(r.values.get('additionalAgents')).toEqual([]);
  for (const invalid of [
    [...agents, agents[1]],
    [...agents, { ...agents[1], id: 'c' }, { ...agents[1], id: 'd' }],
  ]) {
    await r.instance.webSocketMessage(owner, JSON.stringify({ t: 'agent', agents: invalid }));
    expect(JSON.parse(vi.mocked(owner.send).mock.calls.at(-1)![0] as string).t).toBe('agent-error');
    expect(r.values.get('additionalAgents')).toEqual([]);
  }
  await r.instance.webSocketMessage(
    owner,
    JSON.stringify({ t: 'agent', agent: { name: 'Legacy', persona: '' } }),
  );
  expect(r.values.get('additionalAgents')).toEqual([]);
  for (const [socket, as] of [
    [owner, 'ai:friend'],
    [guest, 'ai:friend'],
    [owner, 'ai:unknown'],
  ] as const) {
    const before =
      vi.mocked(guest.send).mock.calls.length + vi.mocked(owner.send).mock.calls.length;
    await r.instance.webSocketMessage(
      socket,
      JSON.stringify({ t: 'chat', id: crypto.randomUUID(), as, x: 'hello' }),
    );
    expect(vi.mocked(guest.send).mock.calls.length + vi.mocked(owner.send).mock.calls.length).toBe(
      before,
    );
  }
  await r.instance.webSocketMessage(owner, JSON.stringify({ t: 'agent', agents: [] }));
  expect(r.values.get('agent')).toBeNull();
  expect(r.values.get('additionalAgents')).toEqual([]);
});

it('reads an old multi-AI room as one active identity without deleting its history', async () => {
  const extras = [
    { id: 'old-first', name: 'First', persona: 'first' },
    { id: 'old-second', name: 'Second', persona: 'second' },
  ];
  const onlyExtras = room();
  onlyExtras.values.set('additionalAgents', extras);
  const readExtras = onlyExtras.instance as unknown as {
    getAgents(): Promise<typeof extras>;
  };
  expect(await readExtras.getAgents()).toEqual([extras[0]]);
  expect(onlyExtras.values.get('additionalAgents')).toEqual(extras);

  const withPrimary = room();
  withPrimary.values.set('agent', { name: 'Primary', persona: 'primary' });
  withPrimary.values.set('additionalAgents', extras);
  const readPrimary = withPrimary.instance as unknown as {
    getAgents(): Promise<typeof extras>;
  };
  expect(await readPrimary.getAgents()).toEqual([
    { id: 'room', name: 'Primary', persona: 'primary' },
  ]);
  expect(withPrimary.values.get('additionalAgents')).toEqual(extras);
});

it('binds one AI reply to a saved human mention, host and configured role', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const values = new Map<string, unknown>([
      ['code', 'persistent-group'],
      ['persistentHistory', true],
      ['hostPeerId', 'host'],
      ['hostAccountId', 'host'],
      ['agent', { name: '助手', persona: '' }],
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
      delete: async (key: string) => values.delete(key),
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
    const room = new RoomDO(
      {
        storage,
        getWebSockets: () => sockets,
        blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
      } as unknown as DurableObjectState,
      {} as Env,
    );
    db.exec(
      'CREATE TABLE group_memberships(account_id TEXT PRIMARY KEY,name TEXT,state TEXT,version INTEGER,updated_at INTEGER)',
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
    const human = socket('human-peer', 'alice');
    const host = socket('host', 'host');
    sockets.push(human, host);
    const triggerId = 'human-mention';
    await room.webSocketMessage(
      human,
      JSON.stringify({
        t: 'chat',
        id: triggerId,
        x: '@助手 你好',
        mentions: [{ peerId: 'ai:room', n: '助手' }],
      }),
    );
    expect(vi.mocked(host.send).mock.calls.length).toBe(1);
    values.set('hostAccountId', 'alice');
    await room.webSocketMessage(
      host,
      JSON.stringify({ t: 'agent-claim', requestId: 'wrong-account', triggerId, roleId: 'room' }),
    );
    expect(JSON.parse(vi.mocked(host.send).mock.calls.at(-1)![0] as string).grantId).toBeNull();
    values.set('hostAccountId', 'host');
    await room.webSocketMessage(
      host,
      JSON.stringify({ t: 'agent-claim', requestId: 'claim-1', triggerId, roleId: 'room' }),
    );
    const grantId = JSON.parse(vi.mocked(host.send).mock.calls.at(-1)![0] as string).grantId;
    expect(grantId).toEqual(expect.any(String));
    await room.webSocketMessage(
      host,
      JSON.stringify({ t: 'agent-claim', requestId: 'claim-2', triggerId, roleId: 'room' }),
    );
    expect(JSON.parse(vi.mocked(host.send).mock.calls.at(-1)![0] as string).grantId).toBeNull();
    const sendAi = (id: string, grant: string) =>
      room.webSocketMessage(
        host,
        JSON.stringify({ t: 'chat', id, as: 'ai:room', triggerId, grantId: grant, x: '你好' }),
      );
    await sendAi('forged', 'wrong');
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_id='ai:room'").get()?.n).toBe(
      0,
    );
    await sendAi('reply-1', grantId);
    await sendAi('reply-2', grantId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_id='ai:room'").get()?.n).toBe(
      1,
    );
    expect(
      db.prepare("SELECT response_id FROM room_agent_turns WHERE trigger_id='human-mention'").get()
        ?.response_id,
    ).toBe('reply-1');
  } finally {
    db.close();
  }
});

it.each(['image', 'audio'])(
  'takes quote identity from local history for a %s reply and ignores client snapshots',
  async (kind) => {
    const r = room();
    r.values.set('persistentHistory', true);
    const sender = {
      deserializeAttachment: () => ({ peerId: 'sender', name: 'Sender' }),
      send: vi.fn(),
    } as unknown as WebSocket;
    const recipient = {
      deserializeAttachment: () => ({ peerId: 'recipient', name: 'Recipient' }),
      send: vi.fn(),
    } as unknown as WebSocket;
    r.sockets.push(sender, recipient);
    r.sql.exec.mockImplementation(((query: string) => ({
      toArray: () =>
        query.startsWith('SELECT id,from_id,name,body FROM messages WHERE')
          ? [
              {
                id: 'source',
                from_id: 'ai:second',
                name: '真实名字',
                body: JSON.stringify({ x: '真实内容' }),
              },
            ]
          : [{}],
    })) as never);
    await r.instance.webSocketMessage(
      sender,
      JSON.stringify({
        t: 'chat',
        id: 'reply',
        x: '继续',
        replyToId: 'source',
        m: {
          kind,
          id: 'uploaded-media',
          mime: kind === 'image' ? 'image/jpeg' : 'audio/webm',
          size: 10,
        },
        replyTo: { id: 'elsewhere', senderId: 'admin', senderName: '管理员', text: '伪造' },
      }),
    );
    const payload = JSON.parse(vi.mocked(recipient.send).mock.calls.at(-1)![0] as string);
    expect(payload.replyTo).toEqual({
      id: 'source',
      senderId: 'ai:second',
      senderName: '真实名字',
      text: '真实内容',
    });
    const insert = (r.sql.exec.mock.calls as unknown[][]).find((args) =>
      String(args[0]).startsWith('INSERT INTO messages'),
    ) as unknown as unknown[];
    expect(JSON.parse(insert[4] as string)).toMatchObject({
      replyToId: 'source',
      m: { kind, id: 'uploaded-media' },
    });
    expect(insert[4]).not.toContain('真实内容');
  },
);
it('serves DM latest-message previews without local read counts and rejects revoked access', async () => {
  const r = room('dm:test');
  r.values.set('revokedAt', 10);
  expect(await r.instance.dmInboxSummary('dm:test', 5)).toBeNull();
  expect(await r.instance.dmInboxSummary('other-room', 20)).toBeNull();
  r.sql.exec.mockReturnValue({
    toArray: () => [{ body: JSON.stringify({ m: { kind: 'audio' } }), ts: 100 }],
  } as never);
  expect(await r.instance.dmInboxSummary('dm:test', 20)).toMatchObject({
    room: 'dm:test',
    lastMessageAt: 100,
    preview: '[语音]',
    unread: null,
  });
  r.sql.exec.mockReturnValue({ toArray: () => [] } as never);
  expect(await r.instance.dmInboxSummary('dm:test', 20)).toMatchObject({
    lastMessageAt: null,
    preview: '',
    unread: null,
  });
});

it('rejects read advancement for revoked or mismatched rooms before SQL', async () => {
  const r = room('dm:test');
  r.values.set('revokedAt', 10);
  r.sql.exec.mockClear();
  expect(await r.instance.dmMarkRead('dm:test', 5, 'alice', 1)).toBe(false);
  expect(await r.instance.dmMarkRead('dm:other', 20, 'alice', 1)).toBe(false);
  expect(r.sql.exec).not.toHaveBeenCalled();
});
it('attributes DM messages only to the verified socket account, not client identity', async () => {
  const r = room('dm:test');
  const sender = {
    deserializeAttachment: () => ({ peerId: 'client-peer', name: 'Sender', accountId: 'alice' }),
    send: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(sender);
  r.sql.exec.mockImplementation((() => ({ toArray: () => [{}] })) as never);
  await r.instance.webSocketMessage(
    sender,
    JSON.stringify({ t: 'chat', id: 'new', x: 'hello', accountId: 'mallory', _from: 'mallory' }),
  );
  expect(r.sql.exec).toHaveBeenCalledWith(
    'UPDATE message_sequences SET sender_account=? WHERE message_id=?',
    'alice',
    'new',
  );
});
it('resolves automatic read message IDs only from this room retained messages', async () => {
  const r = room('dm:test');
  r.sql.exec.mockImplementation(((query: string) => ({
    toArray: () =>
      query.startsWith('SELECT s.sequence')
        ? [{ sequence: 7 }]
        : query.startsWith('SELECT COALESCE(MAX')
          ? [{ value: 7 }]
          : [],
  })) as never);
  expect(await r.instance.dmMarkRead('dm:test', 20, 'alice', 'server-message')).toBe(true);
  expect(r.sql.exec).toHaveBeenCalledWith(
    expect.stringContaining('JOIN messages m ON m.id=s.message_id WHERE m.id=?'),
    'server-message',
  );
  r.sql.exec.mockImplementation((() => ({ toArray: () => [] })) as never);
  expect(await r.instance.dmMarkRead('dm:test', 20, 'alice', 'deleted-or-other-room')).toBe(false);
});
it('group read refuses bookmarks without durable membership, stale versions, closed rooms and DM codes', async () => {
  const r = room('group');
  expect(await r.instance.groupInboxSummary('group', 'alice')).toBeNull();
  expect(await r.instance.groupInboxSummary('dm:private', 'alice')).toBeNull();
  r.sql.exec.mockImplementation(((query: string) => ({
    toArray: () =>
      query.startsWith('SELECT account_id')
        ? [{ account_id: 'alice', name: 'Alice', state: 'active', version: 3 }]
        : query.startsWith('SELECT COALESCE')
          ? [{ value: 5 }]
          : [],
  })) as never);
  expect(await r.instance.groupMarkRead('group', 'alice', 2, 4)).toBe(false);
  expect(await r.instance.groupMarkRead('group', 'alice', 3, 4)).toBe(true);
  r.values.set('closed', true);
  expect(await r.instance.groupMarkRead('group', 'alice', 3, 4)).toBe(false);
});
it('group moderation requires an exact owner key, closes all target account sockets, and cannot be spoofed by peer ID', async () => {
  const { hashOwnerKey } = await import('./group');
  const r = room('group');
  r.values.set('ownerKeyHash', await hashOwnerKey('group', 'owner-secret'));
  const owner = {
    deserializeAttachment: () => ({ peerId: 'owner-peer', name: 'Owner' }),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  const target = {
    deserializeAttachment: () => ({
      peerId: 'different-peer',
      name: 'Target',
      accountId: 'target-account',
    }),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(owner, target);
  await r.instance.webSocketMessage(
    owner,
    JSON.stringify({
      t: 'membership',
      action: 'ban',
      accountId: 'target-account',
      ownerKey: 'wrong',
    }),
  );
  expect(target.close).not.toHaveBeenCalled();
  await r.instance.webSocketMessage(
    owner,
    JSON.stringify({
      t: 'membership',
      action: 'ban',
      accountId: 'target-account',
      ownerKey: 'owner-secret',
    }),
  );
  expect(r.sql.exec).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE group_memberships'),
    'banned',
    expect.any(Number),
    'target-account',
    'banned',
  );
  expect(target.close).toHaveBeenCalledWith(1008, 'membership revoked');
});
it('a revoked socket cannot resurrect membership by repeating hello or forge a membership-state frame', async () => {
  const r = room('group');
  const stale = {
    deserializeAttachment: () => ({ peerId: 'old-peer', accountId: 'alice', membershipVersion: 1 }),
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket;
  r.sql.exec.mockImplementation(((query: string) => ({
    toArray: () =>
      query.startsWith('SELECT account_id')
        ? [{ account_id: 'alice', state: 'active', version: 3 }]
        : [],
  })) as never);
  await r.instance.webSocketMessage(stale, JSON.stringify({ t: 'hello', name: 'try again' }));
  expect(stale.close).toHaveBeenCalledWith(1008, 'membership revoked');
  const anonymous = {
    deserializeAttachment: () => ({ peerId: 'legacy' }),
    send: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(anonymous);
  await r.instance.webSocketMessage(
    anonymous,
    JSON.stringify({ t: 'membership-state', members: [{ account_id: 'forged' }] }),
  );
  expect(anonymous.send).not.toHaveBeenCalled();
});
it.each(['chat', 'cmd'])(
  'rechecks membership after async sender resolution before %s delivery',
  async (t) => {
    const r = room('group');
    let active = true;
    const sender = {
      deserializeAttachment: () => ({
        peerId: 'alice-peer',
        accountId: 'alice',
        membershipVersion: 1,
        name: 'Alice',
      }),
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const recipient = {
      deserializeAttachment: () => ({ peerId: 'target' }),
      send: vi.fn(),
    } as unknown as WebSocket;
    r.sockets.push(sender, recipient);
    r.sql.exec.mockImplementation(((query: string) => ({
      toArray: () =>
        query.startsWith('SELECT account_id') && active
          ? [{ account_id: 'alice', state: 'active', version: 1 }]
          : [],
    })) as never);
    vi.spyOn(
      r.instance as unknown as { aiSenderOk: () => Promise<null> },
      'aiSenderOk',
    ).mockImplementation(async () => {
      active = false;
      return null;
    });
    await r.instance.webSocketMessage(
      sender,
      JSON.stringify({ t, id: 'new', x: 'text', to: 'target', a: 'set_strength', v: 10 }),
    );
    expect(recipient.send).not.toHaveBeenCalled();
    expect(
      (r.sql.exec.mock.calls as unknown[][]).some((args) =>
        String(args[0]).startsWith('INSERT INTO messages'),
      ),
    ).toBe(false);
  },
);
it('denies expired and legacy sockets before messages or broadcasts and schedules expiry', async () => {
  const r = room();
  for (const expiresAt of [undefined, Date.now() - 1]) {
    const ws = {
      deserializeAttachment: () => ({ id: 'alice', accountId: 'alice', expiresAt }),
      serializeAttachment: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    await RoomDO.prototype.webSocketMessage.call(
      r.instance,
      ws,
      JSON.stringify({ t: 'chat', x: 'must not save' }),
    );
    expect(ws.close).toHaveBeenCalledWith(1008, 'admission expired; reconnect');
    expect(ws.send).not.toHaveBeenCalled();
    const internal = r.instance as unknown as {
      sendAuthorized(socket: WebSocket, payload: string): void;
    };
    internal.sendAuthorized(ws, 'private');
    expect(ws.send).not.toHaveBeenCalled();
  }
});
it('revokes all matching group account sockets, clears its cursor, and keeps a local tombstone', async () => {
  const r = room();
  const own = {
    deserializeAttachment: () => ({ accountId: 'alice' }),
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  const other = {
    deserializeAttachment: () => ({ accountId: 'bob' }),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(own, other);
  await r.instance.revokeGroupAccount('test-room', 'alice', 'alice:1234');
  expect(own.close).toHaveBeenCalledWith(1008, 'membership revoked');
  expect(other.close).not.toHaveBeenCalled();
  expect(r.sql.exec).toHaveBeenCalledWith(
    'DELETE FROM dm_read_cursors WHERE account_id=?',
    'alice',
  );
  expect(
    r.sql.exec.mock.calls.some(([query]) =>
      query.includes('INSERT OR IGNORE INTO group_account_revocations'),
    ),
  ).toBe(true);
});

it('late legacy observation denies admission, revokes locally, then acknowledges the tombstoned account', async () => {
  const r = room();
  r.registry.registerGroup.mockResolvedValue({ allowed: false, deletionId: 'alice:1234' });
  const internal = r.instance as unknown as {
    registerAccountRoom(room: string, account: string): Promise<boolean>;
  };
  expect(await internal.registerAccountRoom('test-room', 'alice')).toBe(false);
  expect(r.sql.exec).toHaveBeenCalledWith(
    'DELETE FROM dm_read_cursors WHERE account_id=?',
    'alice',
  );
  expect(r.registry.acknowledge).toHaveBeenCalledWith('alice', 'alice:1234', 'test-room');
  r.registry.registerGroup.mockRejectedValueOnce(new Error('registry unavailable'));
  expect(await internal.registerAccountRoom('test-room', 'alice')).toBe(false);
});
it('an automatic reconnect cannot reactivate a membership the account left elsewhere', async () => {
  const r = room('group');
  r.values.set('public', false);
  r.sql.exec.mockImplementation(((query: string) => ({
    toArray: () =>
      query.startsWith('SELECT account_id')
        ? [{ account_id: 'alice', name: 'Alice', state: 'left', version: 2, updated_at: 1 }]
        : [],
  })) as never);
  const socket = () =>
    ({
      deserializeAttachment: () => ({ peerId: 'alice-desktop', accountId: 'alice' }),
      serializeAttachment: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }) as unknown as WebSocket;
  const joins = () =>
    (r.sql.exec.mock.calls as unknown[][]).filter((args) =>
      String(args[0]).startsWith('INSERT INTO group_memberships'),
    ).length;

  const reconnect = socket();
  await r.instance.webSocketMessage(
    reconnect,
    JSON.stringify({ t: 'hello', join: false, name: 'Alice' }),
  );
  expect(reconnect.close).toHaveBeenCalledWith(1008, 'membership revoked');
  expect(reconnect.send).toHaveBeenCalledWith(
    JSON.stringify({ t: 'sys', kind: 'membership-revoked' }),
  );
  expect(joins()).toBe(0);

  await r.instance.webSocketMessage(
    socket(),
    JSON.stringify({ t: 'hello', join: true, name: 'Alice' }),
  );
  expect(joins()).toBe(1);
});
it('confirms a retried message the sender already saved to that sender only', async () => {
  const code = `dm:${'c'.repeat(64)}`;
  const r = room(code);
  r.sql.exec.mockImplementation(((query: string) => ({
    toArray: () =>
      query.startsWith('SELECT id,from_id,name,body,ts FROM messages')
        ? [{ id: 'm1', from_id: 'alice-peer', name: 'Alice', body: '{"x":"你好"}', ts: 7 }]
        : [],
    one: () => ({ n: 0 }),
  })) as never);
  const sender = {
    deserializeAttachment: () => ({
      peerId: 'alice-peer',
      accountId: 'alice',
      dmPeerAccountId: 'bob',
      expiresAt: Date.now() + 60_000,
    }),
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  const peer = {
    deserializeAttachment: () => ({
      peerId: 'bob-peer',
      accountId: 'bob',
      expiresAt: Date.now() + 60_000,
    }),
    send: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(sender, peer);
  await r.instance.webSocketMessage(sender, JSON.stringify({ t: 'chat', id: 'm1', x: '你好' }));
  expect(sender.send).toHaveBeenCalledWith(expect.stringContaining('"id":"m1"'));
  expect(JSON.parse((sender.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toMatchObject(
    {
      t: 'chat',
      id: 'm1',
      _from: 'alice-peer',
      x: '你好',
      ts: 7,
    },
  );
  expect(peer.send).not.toHaveBeenCalled();
});

it('只有群主账号能修改群 AI 计费方式，主持人不能', async () => {
  const r = room('group');
  activeMembers(r);
  r.values.set('ownerAccountId', 'owner-account');
  r.values.set('hostPeerId', 'host');
  r.values.set('hostAccountId', 'host-account');
  const socket = (peerId: string, accountId: string) =>
    ({
      deserializeAttachment: () => ({
        peerId,
        accountId,
        membershipVersion: 1,
        indexRegistered: true,
      }),
      send: vi.fn(),
    }) as unknown as WebSocket;
  await r.instance.webSocketMessage(
    socket('host', 'host-account'),
    JSON.stringify({ t: 'agent-billing', mode: 'managed' }),
  );
  expect(r.values.get('agentBillingMode')).toBeUndefined();
  await r.instance.webSocketMessage(
    socket('owner', 'owner-account'),
    JSON.stringify({ t: 'agent-billing', mode: 'managed' }),
  );
  expect(r.values.get('agentBillingMode')).toBe('managed');
});
it('群主退群或注销后释放群主身份，下一位重新进群的成员接任', async () => {
  const r = room('group');
  r.values.set('ownerAccountId', 'owner-account');
  activeMembers(r);
  const memberQueries = r.sql.exec.getMockImplementation()!;
  r.sql.exec.mockImplementation(((query: string, ...args: unknown[]) =>
    query.includes("SET state='left'")
      ? { toArray: () => [{ account_id: 'owner-account' }] }
      : memberQueries(query, ...args)) as never);
  const owner = {
    deserializeAttachment: () => ({
      peerId: 'owner',
      accountId: 'owner-account',
      membershipVersion: 1,
      indexRegistered: true,
    }),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  r.sockets.push(owner);
  await r.instance.webSocketMessage(owner, JSON.stringify({ t: 'membership-leave' }));
  expect(r.values.get('ownerAccountId')).toBeUndefined();

  r.values.set('ownerAccountId', 'owner-account');
  await r.instance.revokeGroupAccount('group', 'owner-account', 'deletion-1');
  expect(r.values.get('ownerAccountId')).toBeUndefined();
});
