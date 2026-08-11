import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { createTestDb } from './test-helpers';
import { dmRoomCode, isDmRoomCode, verifyDmTicket } from './dm-ticket';

/**
 * Who may start a private conversation, and what ends one.
 *
 * The rule is mutual follow and it is enforced here, before anything is handed to Chat —
 * Chat has no idea what a follow is and never will. A one-way follow is deliberately not
 * enough: an inbox anyone can write to is an open harassment channel, and it cannot be
 * closed again after the messages have been read.
 *
 * Blocking is tested for what it actually has to do, which is not "stop the next
 * conversation" but "end the one already running". Chat is stood in for by a fake binding
 * that records what it was told, because the fact worth asserting is that the account
 * service pushes at all — a block that only takes effect here is a block that leaves two
 * people still talking.
 */

const ORIGIN = 'https://0xnullai.com';
const SECRET = 'test-dm-secret';

let db: ReturnType<typeof createTestDb>;
let env: Env;
/** What the account service pushed to Chat, in order. */
let pushes: { url: string; token: string }[];

beforeEach(() => {
  db = createTestDb();
  pushes = [];
  env = {
    DB: db.DB as Env['DB'],
    PHOTOS: {} as R2Bucket,
    EMAIL: { send: async () => undefined } as unknown as SendEmail,
    IP_PEPPER: 'test-pepper',
    ALLOWED_ORIGINS: ORIGIN,
    DM_TICKET_SECRET: SECRET,
    CHAT: {
      async fetch(input: unknown, init?: { body?: unknown }) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { token?: string };
        pushes.push({ url: String(input), token: body.token ?? '' });
        return new Response('{"ok":true}', { status: 200 });
      },
    } as unknown as Env['CHAT'],
  };
});
afterEach(() => db.close());

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  return new Request(`https://auth.0xnullai.com${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      Origin: ORIGIN,
      'CF-Connecting-IP': '1.2.3.4',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
}

const post = (path: string, body: unknown, token?: string) =>
  worker.fetch(req(path, { method: 'POST', body: JSON.stringify(body), token }), env);

const del = (path: string, token: string) =>
  worker.fetch(req(path, { method: 'DELETE', token }), env);

interface Account {
  id: string;
  token: string;
}

async function register(username: string, verified = true): Promise<Account> {
  const res = await post('/api/auth/register', {
    username,
    email: `${username}@example.com`,
    password: 'correct-horse-battery',
  });
  const body = (await res.json()) as { user: { id: string }; token: string };
  if (verified) {
    await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
      .bind(Date.now(), body.user.id)
      .run();
  }
  return { id: body.user.id, token: body.token };
}

/** Both directions of the follow — which is what a contact is. */
async function makeContacts(a: Account, b: Account): Promise<void> {
  await post('/api/auth/follow', { userId: b.id }, a.token);
  await post('/api/auth/follow', { userId: a.id }, b.token);
}

const ticket = (viewer: Account, peer: Account) =>
  post('/api/auth/dm/ticket', { userId: peer.id }, viewer.token);

async function conversations(viewer: Account) {
  const res = await worker.fetch(req('/api/auth/dm/conversations', { token: viewer.token }), env);
  return (await res.json()) as {
    conversations: { id: string; username: string; room: string }[];
    ticket: string;
  };
}

describe('开私聊需要互相关注', () => {
  it('邮箱未验证时不能取得 Chat 或私聊票据', async () => {
    const alice = await register('alice', false);
    const bob = await register('bob');
    await makeContacts(alice, bob);

    expect((await post('/api/auth/chat/ticket', {}, alice.token)).status).toBe(403);
    expect((await ticket(alice, bob)).status).toBe(403);
  });

  it('互相关注时签发票据，并把会话 id 一起给出来', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);

    const res = await ticket(alice, bob);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; room: string; expiresAt: number };
    // The client never computes where a conversation lives; it is told.
    expect(isDmRoomCode(body.room)).toBe(true);
    expect(body.room).toBe(await dmRoomCode(SECRET, alice.id, bob.id));

    const claims = await verifyDmTicket(SECRET, body.ticket, Date.now());
    expect(claims).toMatchObject({ aud: 'dm', sub: alice.id, peer: bob.id, room: body.room });
  });

  it('只有单向关注不行', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await post('/api/auth/follow', { userId: bob.id }, alice.token);

    // Following someone is a decision about their posts. Being messageable is a decision
    // about who may reach you, and only both directions say both people agreed.
    expect((await ticket(alice, bob)).status).toBe(403);
    expect((await ticket(bob, alice)).status).toBe(403);
  });

  it('互相关注后取关，票据立刻签不出来', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    expect((await ticket(alice, bob)).status).toBe(200);

    await del(`/api/auth/follow/${bob.id}`, alice.token);
    expect((await ticket(alice, bob)).status).toBe(403);
    // Symmetric: the person who was unfollowed loses it too, not just the one who acted.
    expect((await ticket(bob, alice)).status).toBe(403);
  });

  it('未登录拿不到票据', async () => {
    const alice = await register('alice');
    const res = await post('/api/auth/dm/ticket', { userId: alice.id });
    expect(res.status).toBe(401);
  });

  it('不能和自己私聊', async () => {
    const alice = await register('alice');
    expect((await ticket(alice, alice)).status).toBe(400);
  });

  it('被对方拉黑与用户不存在的答案完全一样', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await post('/api/auth/block', { userId: alice.id }, bob.token);

    const blocked = await ticket(alice, bob);
    const missing = await post('/api/auth/dm/ticket', { userId: 'no-such-account' }, alice.token);
    // Telling the two apart confirms who blocked you, and here that invites exactly the
    // attention blocking was meant to end.
    expect(blocked.status).toBe(missing.status);
    expect(await blocked.text()).toBe(await missing.text());
  });
});

describe('拉黑要掐断已经在跑的会话', () => {
  it('拉黑时把吊销推给 Chat，而不是只删关注', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    const room = await dmRoomCode(SECRET, alice.id, bob.id);
    await ticket(alice, bob);
    pushes = [];

    await post('/api/auth/block', { userId: bob.id }, alice.token);

    // Deleting the follows only stops the next ticket. Without this push, blocking somebody
    // mid-conversation would leave them reading and writing until a tab closed.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.url).toContain('/api/dm/revoke');
    const claims = await verifyDmTicket(SECRET, pushes[0]!.token, Date.now());
    expect(claims).toMatchObject({ aud: 'revoke', room });
  });

  it('取关也会掐断——否则「必须互相关注」只对还没开始的会话成立', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);
    pushes = [];

    await del(`/api/auth/follow/${bob.id}`, alice.token);
    expect(pushes).toHaveLength(1);
  });

  it('从没聊过的人取关不会去唤醒一个会话', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    pushes = [];

    await del(`/api/auth/follow/${bob.id}`, alice.token);
    // Every mutual contact is a potential conversation; touching one that never existed
    // would materialise a Durable Object per pair of people who have never spoken.
    expect(pushes).toHaveLength(0);
  });

  it('Chat 联系不上时拉黑依然生效', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);
    env = {
      ...env,
      CHAT: {
        fetch() {
          throw new Error('chat is down');
        },
      } as unknown as Env['CHAT'],
    };

    const res = await post('/api/auth/block', { userId: bob.id }, alice.token);
    // Degraded, not wrong: the conversation dies when the ticket expires instead of
    // instantly. Failing the block because another Worker had a bad minute would be worse.
    expect(res.status).toBe(200);
    expect((await ticket(alice, bob)).status).toBe(404);
  });
});

describe('私聊列表', () => {
  it('开过会话的双方都能看到它，被写信的一方不用先做什么', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);

    const forAlice = await conversations(alice);
    expect(forAlice.conversations.map((c) => c.username)).toEqual(['bob']);
    const forBob = await conversations(bob);
    expect(forBob.conversations.map((c) => c.username)).toEqual(['alice']);
    // Both sides address the same Durable Object.
    expect(forAlice.conversations[0]!.room).toBe(forBob.conversations[0]!.room);
  });

  it('列表带着一张只覆盖这些会话的票据', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);

    const list = await conversations(alice);
    const claims = await verifyDmTicket(SECRET, list.ticket, Date.now());
    // Chat answers unread counts for exactly these and no others.
    expect(claims).toMatchObject({ aud: 'digest', sub: alice.id });
    expect(claims?.rooms).toEqual([list.conversations[0]!.room]);
  });

  it('关注断了，会话就不再列出来', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);

    await del(`/api/auth/follow/${bob.id}`, alice.token);
    // Re-authorized on every read, so a conversation cannot outlive the permission behind
    // it — nothing has to remember to remove it.
    expect((await conversations(alice)).conversations).toHaveLength(0);
    expect((await conversations(bob)).conversations).toHaveLength(0);
  });

  it('重新关注后会话回来了', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);
    await del(`/api/auth/follow/${bob.id}`, alice.token);

    await post('/api/auth/follow', { userId: bob.id }, alice.token);
    // Unfollowing is milder than blocking: it hides the conversation rather than deleting
    // it, which is what somebody who unfollowed by accident expects.
    expect((await conversations(alice)).conversations).toHaveLength(1);
  });

  it('拉黑后会话彻底消失，不是被过滤掉', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    await makeContacts(alice, bob);
    await ticket(alice, bob);

    await post('/api/auth/block', { userId: bob.id }, alice.token);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM dm_threads').first<{
      n: number;
    }>();
    // Blocking is the one act that means gone. The row is deleted rather than left for a
    // read filter to keep hiding correctly forever.
    expect(rows?.n).toBe(0);
  });

  it('未登录时列表是 401，而不是别人的列表', async () => {
    const res = await worker.fetch(req('/api/auth/dm/conversations'), env);
    expect(res.status).toBe(401);
  });
});
