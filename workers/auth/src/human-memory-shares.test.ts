import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleHumanMemoryShares } from './human-memory-shares';
import { sha256Hex } from './session-domain';
import { dmRoomCode, verifyDmTicket } from './dm-ticket';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: Parameters<typeof handleHumanMemoryShares>[1];
const members = new Map<string, Set<string>>();
const versions = new Map<string, number>();
const secret = 'test-secret';
async function call(
  account: string,
  route: string,
  method = 'GET',
  body?: unknown,
  header = account,
) {
  return (await handleHumanMemoryShares(
    new Request(`https://0xnullai.com/api/auth/human-memory${route}`, {
      method,
      headers: { Authorization: `Bearer ${account}`, 'X-Account-Id': header },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  ))!;
}
const dm = '?kind=dm&id=bob';
const dmForBob = '?kind=dm&id=alice';
const group = '?kind=group&id=room1';

beforeEach(async () => {
  db = createTestDb();
  members.clear();
  versions.clear();
  members.set('room1', new Set(['alice', 'bob']));
  versions.set('room1:alice', 1);
  versions.set('room1:bob', 1);
  env = {
    DB: db.DB,
    DM_TICKET_SECRET: secret,
    CHAT: {
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { ticket: string; rooms: string[] };
        const claims = await verifyDmTicket(secret, body.ticket, Date.now());
        if (!claims || claims.aud !== 'chat') return new Response('{}', { status: 403 });
        return Response.json({
          accountId: claims.sub,
          conversations: body.rooms
            .filter((room) => members.get(room)?.has(claims.sub))
            .map((room) => ({
              room,
              membershipVersion: versions.get(`${room}:${claims.sub}`) ?? 1,
            })),
        });
      },
    },
  } as unknown as typeof env;
  for (const id of ['alice', 'bob', 'eve']) {
    await env.DB.prepare(
      `INSERT INTO users(id,username,display_name,password_hash,created_at,email_verified_at)
      VALUES(?,?,?,?,1,1)`,
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions(token_hash,user_id,created_at,expires_at)
      VALUES(?,?,1,?)`,
    )
      .bind(await sha256Hex(id), id, Date.now() + 60_000)
      .run();
  }
  for (const [follower, followee] of [
    ['alice', 'bob'],
    ['bob', 'alice'],
  ]) {
    await env.DB.prepare(
      'INSERT INTO user_follows(follower_id,followee_id,created_at) VALUES(?,?,1)',
    )
      .bind(follower, followee)
      .run();
    await env.DB.prepare('INSERT INTO dm_threads(user_id,peer_id,started_at) VALUES(?,?,1)')
      .bind(follower, followee)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,
    scope,tier,state) VALUES('alice','fact','note','称呼','请叫我阿辰',1,1,1,'account','long','active')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,
    scope,tier,state) VALUES('alice','candidate','note','草稿','不能共享',1,1,1,'account','long','suggested')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,
    scope,relationship_id,tier,state) VALUES('alice','relationship','note','关系','不能共享关系',1,1,1,
    'relationship','r','long','active')`,
  ).run();
});
afterEach(() => db.close());

it('defaults closed; only an exact live memory and DM may be shared, corrected or revoked', async () => {
  expect(await (await call('bob', `/received${dmForBob}`)).json()).toMatchObject({ items: [] });
  expect(
    (
      await call(
        'alice',
        `/shares/fact${dm}`,
        'PUT',
        { enabled: true, version: 0, memoryVersion: 1 },
        'bob',
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call('eve', `/shares/fact?kind=dm&id=alice`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('alice', `/shares/candidate${dm}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('alice', `/shares/relationship${dm}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(409);
  const opened = await call('alice', `/shares/fact${dm}`, 'PUT', {
    enabled: true,
    version: 0,
    memoryVersion: 1,
  });
  expect(opened.status).toBe(200);
  expect(opened.headers.get('Cache-Control')).toContain('no-store');
  expect(await opened.json()).toMatchObject({ share: { enabled: true, version: 1 } });
  expect(JSON.stringify(await (await call('bob', `/received${dmForBob}`)).json())).toContain(
    '请叫我阿辰',
  );
  await env.DB.prepare(
    `UPDATE personal_memories SET content='请叫我小辰',version=2 WHERE user_id='alice' AND id='fact'`,
  ).run();
  const corrected = JSON.stringify(await (await call('bob', `/received${dmForBob}`)).json());
  expect(corrected).toContain('请叫我小辰');
  expect(corrected).not.toContain('请叫我阿辰');
  expect(JSON.parse(corrected).items[0].memory.version).toBe(2);
  expect(JSON.parse(corrected).items[0].memory).toEqual({
    id: 'fact',
    kind: 'note',
    title: '称呼',
    content: '请叫我小辰',
    version: 2,
    updatedAt: 1,
  });
  expect(
    (
      await call('alice', `/shares/fact${dm}`, 'PUT', {
        enabled: false,
        version: 0,
        memoryVersion: 2,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('alice', `/shares/fact${dm}`, 'PUT', {
        enabled: false,
        version: 1,
        memoryVersion: 2,
      })
    ).status,
  ).toBe(200);
  expect(await (await call('bob', `/received${dmForBob}`)).json()).toMatchObject({ items: [] });
});

it('enforces current DM relation and group membership for owner and recipient', async () => {
  await env.DB.prepare(
    `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,
    scope,tier,state) VALUES('alice','old','note','旧授权','旧群事实',1,1,1,'account','long','active')`,
  ).run();
  expect(
    (
      await call('alice', `/shares/fact${group}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('alice', `/shares/old${group}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect(JSON.stringify(await (await call('bob', `/received${group}`)).json())).toContain(
    '请叫我阿辰',
  );
  members.get('room1')!.delete('alice');
  expect(await (await call('bob', `/received${group}`)).json()).toMatchObject({ items: [] });
  expect((await call('alice', `/shares${group}`)).status).toBe(403);
  members.get('room1')!.add('alice');
  versions.set('room1:alice', 2);
  expect(await (await call('bob', `/received${group}`)).json()).toMatchObject({ items: [] });
  const ownShares = (await (await call('alice', `/shares${group}`)).json()) as {
    shares: { enabled: boolean }[];
  };
  expect(ownShares.shares).toHaveLength(2);
  expect(ownShares.shares.every((share) => !share.enabled)).toBe(true);
  expect(
    (
      await call('alice', `/shares/fact${group}`, 'PUT', {
        enabled: true,
        version: 1,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  const rejoined = JSON.stringify(await (await call('bob', `/received${group}`)).json());
  expect(rejoined).toContain('请叫我阿辰');
  expect(rejoined).not.toContain('旧群事实');
  members.get('room1')!.delete('bob');
  expect((await call('bob', `/received${group}`)).status).toBe(403);
  await env.DB.prepare(
    `INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES('bob','alice',1)`,
  ).run();
  expect((await call('bob', `/received${dmForBob}`)).status).toBe(403);
});

it('does not reveal a group member’s shared memory across a block in either direction', async () => {
  expect(
    (
      await call('alice', `/shares/fact${group}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect(JSON.stringify(await (await call('bob', `/received${group}`)).json())).toContain(
    '请叫我阿辰',
  );
  await env.DB.prepare(
    `INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES('bob','alice',1)`,
  ).run();
  expect(await (await call('bob', `/received${group}`)).json()).toMatchObject({ items: [] });
  await env.DB.prepare(
    `DELETE FROM user_blocks WHERE blocker_id='bob' AND blocked_id='alice'`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES('alice','bob',1)`,
  ).run();
  expect(await (await call('bob', `/received${group}`)).json()).toMatchObject({ items: [] });
  expect(await (await call('alice', `/shares${group}`)).json()).toMatchObject({
    shares: [{ memoryId: 'fact', enabled: true }],
  });
});

it('does not revive DM shares when a follow relationship is removed and later restored', async () => {
  expect(
    (
      await call('alice', `/shares/fact${dm}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  await env.DB.prepare(
    `DELETE FROM user_follows WHERE follower_id='bob' AND followee_id='alice'`,
  ).run();
  expect((await call('bob', `/received${dmForBob}`)).status).toBe(403);
  await env.DB.prepare(
    `INSERT INTO user_follows(follower_id,followee_id,created_at) VALUES('bob','alice',2)`,
  ).run();
  expect(await (await call('bob', `/received${dmForBob}`)).json()).toMatchObject({ items: [] });
  expect(await (await call('alice', `/shares${dm}`)).json()).toMatchObject({
    shares: [{ enabled: false, version: 2 }],
  });
});

it('closes an owner share when that owner removes the DM thread', async () => {
  expect(
    (
      await call('alice', `/shares/fact${dm}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  await env.DB.prepare(`DELETE FROM dm_threads WHERE user_id='alice' AND peer_id='bob'`).run();
  expect(await (await call('bob', `/received${dmForBob}`)).json()).toMatchObject({ items: [] });
  await env.DB.prepare(
    `INSERT INTO dm_threads(user_id,peer_id,started_at) VALUES('alice','bob',2)`,
  ).run();
  expect(await (await call('bob', `/received${dmForBob}`)).json()).toMatchObject({ items: [] });
});

it('pages authorized conversations without silently dropping older DMs', async () => {
  for (let n = 0; n < 51; n++) {
    const id = `person${n}`;
    await env.DB.prepare(
      `INSERT INTO users(id,username,display_name,password_hash,created_at,email_verified_at)
      VALUES(?,?,?,?,1,1)`,
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(`INSERT INTO dm_threads(user_id,peer_id,started_at) VALUES('alice',?,?)`)
      .bind(id, 1000 + n)
      .run();
    await env.DB.prepare(
      `INSERT INTO user_follows(follower_id,followee_id,created_at) VALUES('alice',?,1)`,
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      `INSERT INTO user_follows(follower_id,followee_id,created_at) VALUES(?,'alice',1)`,
    )
      .bind(id)
      .run();
  }
  const first = (await (await call('alice', '/conversations')).json()) as {
    conversations: { kind: string; id: string }[];
    next: { dmOffset: number | null; groupOffset: number | null } | null;
  };
  expect(first.conversations.filter((row) => row.kind === 'dm')).toHaveLength(50);
  expect(first.next).toEqual({ dmOffset: 50, groupOffset: null });
  const second = (await (
    await call('alice', '/conversations?dmOffset=50&groupOffset=-1')
  ).json()) as typeof first;
  expect(second.conversations.filter((row) => row.kind === 'dm')).toHaveLength(2);
  expect(second.next).toBeNull();
});

it('drops deleted memories and does not expose them through a stale share', async () => {
  expect(
    (
      await call('alice', `/shares/fact${dm}`, 'PUT', {
        enabled: true,
        version: 0,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  await env.DB.prepare(
    `UPDATE personal_memories SET title='',content='',deleted_at=5,version=2
    WHERE user_id='alice' AND id='fact'`,
  ).run();
  expect(await (await call('bob', `/received${dmForBob}`)).json()).toMatchObject({ items: [] });
  expect(
    (
      await call('alice', `/shares/fact${dm}`, 'PUT', {
        enabled: true,
        version: 1,
        memoryVersion: 1,
      })
    ).status,
  ).toBe(409);
});

it('paginates received memories without repeating a row or returning private source fields', async () => {
  const key = await dmRoomCode(secret, 'alice', 'bob');
  for (let index = 0; index < 51; index++) {
    const id = `page-${index}`;
    await env.DB.prepare(
      `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,
       scope,tier,state) VALUES('alice',?,'note',?, ?,1,1,1,'account','long','active')`,
    )
      .bind(id, id, id)
      .run();
    await env.DB.prepare(
      `INSERT INTO human_memory_shares
       (owner_id,chat_kind,chat_key,dm_peer_id,memory_id,enabled,version,updated_at)
       VALUES('alice','dm',?,'bob',?,1,1,1)`,
    )
      .bind(key, id)
      .run();
  }
  const first = (await (await call('bob', `/received${dmForBob}`)).json()) as {
    items: Array<{ memory: { id: string } }>;
    nextOffset: number | null;
  };
  expect(first.items).toHaveLength(50);
  expect(first.nextOffset).toBe(50);
  const second = (await (
    await call('bob', `/received${dmForBob}&offset=50`)
  ).json()) as typeof first;
  expect(second.items).toHaveLength(1);
  expect(second.nextOffset).toBeNull();
  expect(new Set([...first.items, ...second.items].map(({ memory }) => memory.id)).size).toBe(51);
  expect(JSON.stringify(first)).not.toContain('sourceMessageIds');
  expect(JSON.stringify(first)).not.toContain('sourceConversationId');
});
