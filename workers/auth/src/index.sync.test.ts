import { describe, expect, it } from 'vitest';
import worker from './index';
import {
  env,
  req,
  prepared,
  registerUser,
  verifyRegisteredUser,
  get,
  seedUser,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';
import { verifyDmTicket } from './dm-ticket';

useAuthWorkerTestEnv(createTestDb);

describe('Chat 房间账户同步', () => {
  it('按账号与时间戳+房间号稳定分页，超过 50 个群不漏同毫秒记录', async () => {
    const alice = (await registerUser()).body;
    const bob = (await registerUser({ username: 'bob', email: 'bob@example.com' })).body;
    await verifyRegisteredUser(alice);
    await verifyRegisteredUser(bob);
    const sameTime = 123456;
    for (let n = 0; n < 121; n++) {
      await prepared(
        'INSERT INTO user_chat_rooms(user_id,code,name,joined_at,updated_at) VALUES(?,?,?,?,?)',
        alice.user!.id,
        `room-${String(n).padStart(3, '0')}`,
        `Room ${n}`,
        sameTime,
        sameTime,
      ).run();
    }
    await prepared(
      'INSERT INTO user_chat_rooms(user_id,code,name,joined_at,updated_at) VALUES(?,?,?,?,?)',
      bob.user!.id,
      'bob-private',
      'Bob',
      sameTime,
      sameTime,
    ).run();
    const codes: string[] = [];
    let cursor: string | null = null;
    do {
      const path = `/api/auth/chat-rooms?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await worker.fetch(req(path, { token: alice.token }), env);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        rooms: { code: string }[];
        nextCursor: string | null;
      };
      expect(page.rooms.length).toBeLessThanOrEqual(50);
      codes.push(...page.rooms.map((room) => room.code));
      if (page.nextCursor) {
        expect(
          (
            await worker.fetch(
              req(`/api/auth/chat-rooms?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`, {
                token: bob.token,
              }),
              env,
            )
          ).status,
        ).toBe(400);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(codes).toEqual(
      Array.from({ length: 121 }, (_, n) => `room-${String(n).padStart(3, '0')}`),
    );
    expect(
      (await worker.fetch(req('/api/auth/chat-rooms?limit=0', { token: alice.token }), env)).status,
    ).toBe(400);
    expect(
      (
        await worker.fetch(
          req('/api/auth/chat-rooms?limit=50&cursor=bad', { token: alice.token }),
          env,
        )
      ).status,
    ).toBe(400);
  });

  it('跨会话读取已加入房间，并允许只从自己的列表移除', async () => {
    const { body } = await registerUser();
    await verifyRegisteredUser(body);
    const token = body.token!;
    const added = await worker.fetch(
      req('/api/auth/chat-rooms', {
        method: 'PUT',
        token,
        body: JSON.stringify({ code: 'private-room_7', name: '私密房间' }),
      }),
      env,
    );
    expect(added.status).toBe(200);

    const listed = await worker.fetch(req('/api/auth/chat-rooms', { token }), env);
    expect(await listed.json()).toMatchObject({
      rooms: [{ code: 'private-room_7', name: '私密房间' }],
    });

    const removed = await worker.fetch(
      req('/api/auth/chat-rooms/private-room_7', { method: 'DELETE', token }),
      env,
    );
    expect(removed.status).toBe(200);
    const empty = await worker.fetch(req('/api/auth/chat-rooms', { token }), env);
    expect(await empty.json()).toEqual({ rooms: [] });
  });

  it('拒绝匿名写入和无效房间号', async () => {
    const anonymous = await worker.fetch(req('/api/auth/chat-rooms'), env);
    expect(anonymous.status).toBe(401);
    const { body } = await registerUser();
    await verifyRegisteredUser(body);
    const invalid = await worker.fetch(
      req('/api/auth/chat-rooms', {
        method: 'PUT',
        token: body.token,
        body: JSON.stringify({ code: '../room' }),
      }),
      env,
    );
    expect(invalid.status).toBe(400);
  });

  it('房主密钥跨平台恢复管理权，关闭移除房主自己的书签', async () => {
    const owner = (await registerUser()).body;
    const member = (await registerUser({ username: 'bob', email: 'bob@example.com' })).body;
    await verifyRegisteredUser(owner);
    await verifyRegisteredUser(member);
    for (const [token, ownerKey] of [
      [owner.token, 'owner-secret'],
      [member.token, undefined],
    ] as const) {
      await worker.fetch(
        req('/api/auth/chat-rooms', {
          method: 'PUT',
          token,
          body: JSON.stringify({ code: 'shared-room', name: '共享房间', ownerKey }),
        }),
        env,
      );
    }
    const listed = await worker.fetch(req('/api/auth/chat-rooms', { token: owner.token }), env);
    expect(await listed.json()).toMatchObject({ rooms: [{ ownerKey: 'owner-secret' }] });
    const denied = await worker.fetch(
      req('/api/auth/chat-rooms/shared-room/close', {
        method: 'POST',
        token: member.token,
        body: JSON.stringify({ ownerKey: 'owner-secret' }),
      }),
      env,
    );
    expect(denied.status).toBe(403);
    const closed = await worker.fetch(
      req('/api/auth/chat-rooms/shared-room/close', {
        method: 'POST',
        token: owner.token,
        body: JSON.stringify({ ownerKey: 'owner-secret' }),
      }),
      env,
    );
    expect(closed.status).toBe(200);
    const ownerList = await worker.fetch(req('/api/auth/chat-rooms', { token: owner.token }), env);
    expect(await ownerList.json()).toEqual({ rooms: [] });
  });

  it('关闭只移除自己的书签，伪造的房主密钥不能清空其他成员的列表', async () => {
    const owner = (await registerUser()).body;
    const attacker = (await registerUser({ username: 'mallory', email: 'm@example.com' })).body;
    await verifyRegisteredUser(owner);
    await verifyRegisteredUser(attacker);
    for (const [token, ownerKey] of [
      [owner.token, 'owner-secret'],
      [attacker.token, 'forged'],
    ] as const) {
      await worker.fetch(
        req('/api/auth/chat-rooms', {
          method: 'PUT',
          token,
          body: JSON.stringify({ code: 'shared-room', name: '共享房间', ownerKey }),
        }),
        env,
      );
    }
    const closed = await worker.fetch(
      req('/api/auth/chat-rooms/shared-room/close', {
        method: 'POST',
        token: attacker.token,
        body: JSON.stringify({ ownerKey: 'forged' }),
      }),
      env,
    );
    expect(closed.status).toBe(200);
    const ownerList = await worker.fetch(req('/api/auth/chat-rooms', { token: owner.token }), env);
    expect(await ownerList.json()).toMatchObject({ rooms: [{ code: 'shared-room' }] });
    const attackerList = await worker.fetch(
      req('/api/auth/chat-rooms', { token: attacker.token }),
      env,
    );
    expect(await attackerList.json()).toEqual({ rooms: [] });
  });

  it('邮箱未验证时服务端拒绝房间同步和 Chat 票据', async () => {
    const { body } = await registerUser();
    expect(
      (await worker.fetch(req('/api/auth/chat-rooms', { token: body.token }), env)).status,
    ).toBe(403);
    expect(
      (await worker.fetch(req('/api/auth/chat/ticket', { method: 'POST', token: body.token }), env))
        .status,
    ).toBe(403);
  });
});

describe('群 AI 进群票据', () => {
  const ticket = (token: string, body: unknown) =>
    worker.fetch(
      req('/api/auth/group-agent/ticket', { method: 'POST', token, body: JSON.stringify(body) }),
      env,
    );

  it('只给自己已有的角色、且账户有 Credit 时签发，并绑定群号和角色', async () => {
    const { body } = await registerUser();
    await verifyRegisteredUser(body);
    const id = body.user!.id;
    const token = body.token!;
    expect((await ticket(token, { room: 'group-1', characterId: 'kitty' })).status).toBe(403);
    await prepared(
      "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES(?,'r','kitty','','','','',1,1,1)",
      id,
    ).run();
    await prepared('DELETE FROM credit_ledger WHERE user_id=?', id).run();
    expect((await ticket(token, { room: 'group-1', characterId: 'kitty' })).status).toBe(402);
    await prepared(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES(?,5,'support_adjustment','seed','test','{}',1)",
      id,
    ).run();
    expect((await ticket(token, { room: 'dm:x', characterId: 'kitty' })).status).toBe(400);
    const response = await ticket(token, { room: 'group-1', characterId: 'kitty' });
    expect(response.status).toBe(200);
    const { ticket: signed } = (await response.json()) as { ticket: string };
    expect(await verifyDmTicket(env.DM_TICKET_SECRET!, signed, Date.now())).toMatchObject({
      aud: 'group-agent',
      sub: id,
      room: 'group-1',
      characterId: 'kitty',
    });
  });
});

describe('内容同步分页', () => {
  it('同一毫秒超过一页时用 (updated_at, id) 游标，不跳过也不重复', async () => {
    const alice = await seedUser('alice');
    const updatedAt = 1_700_000_000_000;
    const statements = Array.from({ length: 501 }, (_, index) => {
      const id = `wave-${String(index).padStart(3, '0')}`;
      const entityId = `${alice.id}:${id}`;
      return [
        env.DB.prepare(
          `INSERT INTO content_entities
            (id, owner_id, kind, name, payload, created_at, updated_at)
           VALUES (?, ?, 'waveform', ?, '{}', ?, ?)`,
        ).bind(entityId, alice.id, id, updatedAt, updatedAt),
        env.DB.prepare(
          `INSERT INTO user_content_refs
            (user_id, content_id, client_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(alice.id, entityId, id, updatedAt, updatedAt),
      ];
    }).flat();
    await env.DB.batch(statements);

    const first = (await (
      await get('/api/auth/content?kind=waveform&since=0', alice.token)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(500);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await get(
        `/api/auth/content?kind=waveform&since=0&cursor=${encodeURIComponent(first.nextCursor!)}`,
        alice.token,
      )
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(501);
  });
});

describe('Agent 会话同步', () => {
  it('按账户隔离会话，并用墓碑跨设备删除', async () => {
    const alice = await seedUser('agent-alice');
    const bob = await seedUser('agent-bob');
    const session = { id: 'session-1', updatedAt: 100, messages: [{ content: '私密' }] };
    const putSession = await worker.fetch(
      req('/api/auth/agent-sessions', {
        method: 'PUT',
        token: alice.token,
        body: JSON.stringify({
          sessions: [{ id: 'session-1', session, clientUpdatedAt: 100 }],
        }),
      }),
      env,
    );
    expect(putSession.status).toBe(200);

    const aliceList = (await (await get('/api/auth/agent-sessions', alice.token)).json()) as {
      sessions: { id: string; session: unknown; deleted: boolean }[];
    };
    expect(aliceList.sessions).toEqual([
      expect.objectContaining({ id: 'session-1', session, deleted: false }),
    ]);
    const bobList = (await (await get('/api/auth/agent-sessions', bob.token)).json()) as {
      sessions: unknown[];
    };
    expect(bobList.sessions).toEqual([]);

    await worker.fetch(
      req('/api/auth/agent-sessions', {
        method: 'PUT',
        token: alice.token,
        body: JSON.stringify({
          sessions: [{ id: 'session-1', deleted: true, clientUpdatedAt: 200 }],
        }),
      }),
      env,
    );
    const deleted = (await (await get('/api/auth/agent-sessions', alice.token)).json()) as {
      sessions: { id: string; deleted: boolean; session: unknown }[];
    };
    expect(deleted.sessions).toEqual([
      expect.objectContaining({ id: 'session-1', deleted: true, session: null }),
    ]);
  });

  it('旧设备的迟到写入不会复活已删除会话', async () => {
    const alice = await seedUser('agent-conflict');
    const write = async (clientUpdatedAt: number, deleted = false) =>
      worker.fetch(
        req('/api/auth/agent-sessions', {
          method: 'PUT',
          token: alice.token,
          body: JSON.stringify({
            sessions: [
              {
                id: 'same',
                session: deleted ? undefined : { id: 'same', updatedAt: clientUpdatedAt },
                clientUpdatedAt,
                deleted,
              },
            ],
          }),
        }),
        env,
      );
    await write(300, true);
    await write(200, false);

    const result = (await (await get('/api/auth/agent-sessions', alice.token)).json()) as {
      sessions: { deleted: boolean; clientUpdatedAt: number }[];
    };
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({ deleted: true, clientUpdatedAt: 300 }),
    );
  });
});
