import { describe, expect, it } from 'vitest';
import {
  DM_ROOM_PREFIX,
  authorizeDmToken,
  authorizeDmUpgrade,
  dmAllowsFrame,
  dmRoomCode,
  dmTicketRevoked,
  dmTicketWindow,
  isDmRoomCode,
  roomPathAllowsCode,
} from './dm';
import { signDmTicket, type DmTicketClaims } from '../../../workers/auth/src/dm-ticket';

/**
 * The admission rules for a private conversation.
 *
 * These are the expensive ones to get wrong. A group's worst case is somebody joining a
 * chat room they were not invited to; here it is somebody reaching a specific person's
 * conversation, which is the situation this whole feature exists to make impossible.
 *
 * The relay itself (RoomDO) cannot be imported here — `cloudflare:workers` only resolves
 * inside workerd — which is why every rule lives in dm.ts as a pure function.
 */

const SECRET = 'test-secret-never-rotated';
const ALICE = 'acct-alice';
const BOB = 'acct-bob';
const MALLORY = 'acct-mallory';
const NOW = 1_800_000_000_000;

async function ticketFor(
  a: string,
  b: string,
  overrides: Partial<DmTicketClaims> = {},
  secret = SECRET,
): Promise<string> {
  return signDmTicket(secret, {
    aud: 'dm',
    sub: a,
    peer: b,
    room: await dmRoomCode(secret, a, b),
    ...dmTicketWindow(NOW),
    ...overrides,
  });
}

describe('会话 id', () => {
  it('两个账号无论谁发起都落在同一个会话上', async () => {
    // The whole reuse-RoomDO decision rests on this: a conversation is one Durable Object,
    // so the id has to be a function of the unordered pair and nothing else.
    expect(await dmRoomCode(SECRET, ALICE, BOB)).toBe(await dmRoomCode(SECRET, BOB, ALICE));
  });

  it('不同的两个人是不同的会话', async () => {
    expect(await dmRoomCode(SECRET, ALICE, BOB)).not.toBe(await dmRoomCode(SECRET, ALICE, MALLORY));
  });

  it('知道两个账号 id 也算不出会话 id', async () => {
    // Account ids are discoverable — looking somebody up by username returns theirs. If the
    // id were a plain hash of the pair, anyone could compute it and read the conversation's
    // R2 media prefix, which is served unauthenticated the way every room's is.
    const withOtherSecret = await dmRoomCode('a-different-secret', ALICE, BOB);
    expect(await dmRoomCode(SECRET, ALICE, BOB)).not.toBe(withOtherSecret);
  });

  it('带前缀，所以任何地方都认得出这是私聊', async () => {
    const code = await dmRoomCode(SECRET, ALICE, BOB);
    expect(code.startsWith(DM_ROOM_PREFIX)).toBe(true);
    expect(isDmRoomCode(code)).toBe(true);
    expect(isDmRoomCode('ABCD12')).toBe(false);
  });
});

describe('进入私聊需要账号服务签发的票据', () => {
  it('拿着有效票据可以进', async () => {
    const auth = await authorizeDmUpgrade({
      secret: SECRET,
      ticket: await ticketFor(ALICE, BOB),
      now: NOW,
    });
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.code).toBe(await dmRoomCode(SECRET, ALICE, BOB));
      expect(auth.self).toBe(ALICE);
      expect(auth.peer).toBe(BOB);
    }
  });

  it('没有票据一律拒绝', async () => {
    const auth = await authorizeDmUpgrade({ secret: SECRET, ticket: null, now: NOW });
    expect(auth).toMatchObject({ ok: false, status: 401 });
  });

  it('改过内容的票据签名对不上', async () => {
    // The attacker forges their own client: they hold a real ticket for their own
    // conversation and rewrite the peer to somebody else's account.
    const real = await ticketFor(MALLORY, ALICE);
    const [payload, tag] = real.split('.');
    const claims = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))) as DmTicketClaims;
    claims.peer = BOB;
    claims.room = await dmRoomCode(SECRET, ALICE, BOB);
    const forged = `${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${tag}`;

    const auth = await authorizeDmUpgrade({ secret: SECRET, ticket: forged, now: NOW });
    expect(auth).toMatchObject({ ok: false, status: 403 });
  });

  it('用别的密钥签的票据进不来', async () => {
    const auth = await authorizeDmUpgrade({
      secret: SECRET,
      ticket: await ticketFor(ALICE, BOB, {}, 'stolen-guess'),
      now: NOW,
    });
    expect(auth).toMatchObject({ ok: false, status: 403 });
  });

  it('过期的票据进不来', async () => {
    const ticket = await ticketFor(ALICE, BOB);
    // Past the minute. This is what makes admission a repeated check rather than a gate you
    // pass once — the client re-mints on every reconnect, against the live follow graph.
    const auth = await authorizeDmUpgrade({ secret: SECRET, ticket, now: NOW + 120_000 });
    expect(auth).toMatchObject({ ok: false, status: 403 });
  });

  it('为别的用途签发的票据不能拿来进会话', async () => {
    const digest = await signDmTicket(SECRET, {
      aud: 'digest',
      sub: ALICE,
      rooms: [await dmRoomCode(SECRET, ALICE, BOB)],
      ...dmTicketWindow(NOW),
    });
    // Reading unread counts is not permission to join, and a撤销 token is not either.
    expect(await authorizeDmUpgrade({ secret: SECRET, ticket: digest, now: NOW })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await authorizeDmToken({ secret: SECRET, token: digest, audience: 'revoke', now: NOW }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('票据里的会话 id 与两个账号对不上就拒绝', async () => {
    // Signed, so a client cannot cause this. It means a minting bug pointed a ticket at
    // somebody else's conversation, and the answer has to be "nowhere" rather than "there".
    const ticket = await ticketFor(ALICE, BOB, {
      room: await dmRoomCode(SECRET, MALLORY, BOB),
    });
    expect(await authorizeDmUpgrade({ secret: SECRET, ticket, now: NOW })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('没配密钥时明确报错，而不是放行', async () => {
    const auth = await authorizeDmUpgrade({
      secret: undefined,
      ticket: await ticketFor(ALICE, BOB),
      now: NOW,
    });
    expect(auth).toMatchObject({ ok: false, status: 503 });
  });
});

describe('私聊的 DO 不能从房间路径进', () => {
  it('房间路径拒绝私聊会话 id', async () => {
    // /ws/room/:code takes the code from the URL and asks for no credential. Without this
    // the ticket check on /ws/dm would be decoration.
    expect(roomPathAllowsCode(await dmRoomCode(SECRET, ALICE, BOB))).toBe(false);
  });

  it('普通房间号照常放行', () => {
    expect(roomPathAllowsCode('ABCD12')).toBe(true);
    expect(roomPathAllowsCode('lobby')).toBe(true);
  });
});

describe('拉黑要掐断已经在跑的会话', () => {
  it('拉黑之前签发的票据全部作废', () => {
    const revokedAt = NOW;
    // Deleting the follows only stops the *next* mint; this is the one already in a
    // client's hand, which would otherwise keep working for the rest of its minute.
    expect(dmTicketRevoked(NOW - 1, revokedAt)).toBe(true);
    expect(dmTicketRevoked(NOW, revokedAt)).toBe(true);
  });

  it('解除拉黑后新签发的票据可以用，不需要第二条通知', () => {
    // The mark is an instant rather than a flag, so unblocking needs nothing to undo it.
    expect(dmTicketRevoked(NOW + 1, NOW)).toBe(false);
  });

  it('从来没被拉黑过的会话不受影响', () => {
    expect(dmTicketRevoked(NOW, undefined)).toBe(false);
  });
});

describe('私聊与群聊的差别只有群管理', () => {
  it('设备指令、波形和设备状态照常转发', () => {
    // A conversation is a room with two people in it, and each side can control the other's
    // device exactly as in a group. Nothing about being a conversation weakens the safety
    // chain, because none of it is here: the strength cap is applied by the device's own
    // holder, commands go through the serial queue, and AI-issued ones go through the policy
    // engine — all of that lives in the client that owns the device.
    for (const frame of ['cmd', 'wave', 'sf', 'ss', 'chat', 'presence', 'hello', 'leave']) {
      expect(dmAllowsFrame(frame)).toBe(true);
    }
  });

  it('大厅可见性与房间 AI 这两个群管理帧被丢弃', () => {
    // `group` is what would put a private conversation into the public lobby; `agent` is a
    // room AI defined by an owner, and a conversation has none. Dropped on the server, not
    // merely hidden in the UI — a forged client does not use the UI.
    expect(dmAllowsFrame('group')).toBe(false);
    expect(dmAllowsFrame('agent')).toBe(false);
  });
});
