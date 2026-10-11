// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleDmInbox, handleDmRead } from './dm-inbox';
import { signDmTicket, dmRoomCode } from '../../../workers/auth/src/dm-ticket';
it('only reads rooms signed for the matching account and omits revoked room summaries', async () => {
  const secret = 'inbox-test-signing-secret';
  const now = Date.now();
  const room = await dmRoomCode(secret, 'alice', 'bob');
  const token = await signDmTicket(secret, {
    aud: 'digest',
    sub: 'alice',
    rooms: [room],
    iat: now,
    exp: now + 60000,
  });
  const summary = vi.fn(async () => ({
    room,
    lastMessageAt: 123,
    preview: '服务端消息',
    unread: null,
  }));
  const select = vi.fn();
  const env = {
    DM_TICKET_SECRET: secret,
    ROOM: {
      idFromName: (id: string) => id,
      get: (id: string) => {
        select(id);
        return { dmInboxSummary: summary };
      },
    },
  } as unknown as Parameters<typeof handleDmInbox>[1];
  const req = (account: string, ticket = token) =>
    new Request('https://chat.test/api/dm/inbox', {
      method: 'POST',
      headers: { 'X-Account-Id': account },
      body: JSON.stringify({ ticket, rooms: ['dm-forged'] }),
    });
  expect((await handleDmInbox(req('mallory'), env)).status).toBe(403);
  expect(select).not.toHaveBeenCalled();
  expect((await handleDmInbox(req('alice', 'invalid'), env)).status).toBe(403);
  const result = await handleDmInbox(req('alice'), env);
  expect(result.headers.get('Cache-Control')).toContain('no-store');
  expect(select).toHaveBeenCalledWith(room);
  expect(summary).toHaveBeenCalledWith(room, now, 'alice');
  expect(await result.json()).toMatchObject({
    accountId: 'alice',
    conversations: [{ preview: '服务端消息', unread: null }],
  });
  summary.mockResolvedValueOnce(null as never);
  expect(await (await handleDmInbox(req('alice'), env)).json()).toMatchObject({
    conversations: [],
  });
});

it('read requires a fresh write-capable DM admission ticket and the exact account', async () => {
  const secret = 'read-test-secret';
  const now = Date.now();
  const room = await dmRoomCode(secret, 'alice', 'bob');
  const mint = (aud: 'dm' | 'digest') =>
    signDmTicket(secret, {
      aud,
      sub: 'alice',
      peer: 'bob',
      room,
      rooms: [room],
      iat: now,
      exp: now + 60000,
    });
  const write = vi.fn(async () => true);
  const env = {
    DM_TICKET_SECRET: secret,
    ROOM: { idFromName: (id: string) => id, get: () => ({ dmMarkRead: write }) },
  } as unknown as Parameters<typeof handleDmRead>[1];
  const req = (ticket: string, account = 'alice', sequence = 4) =>
    new Request('https://chat.test/api/dm/read', {
      method: 'POST',
      headers: { 'X-Account-Id': account },
      body: JSON.stringify({ ticket, sequence }),
    });
  expect((await handleDmRead(req(await mint('digest')), env)).status).toBe(403);
  expect((await handleDmRead(req(await mint('dm'), 'bob'), env)).status).toBe(403);
  expect(write).not.toHaveBeenCalled();
  expect((await handleDmRead(req(await mint('dm')), env)).status).toBe(200);
  expect(write).toHaveBeenCalledWith(room, now, 'alice', 4);
  write.mockResolvedValue(false);
  expect((await handleDmRead(req(await mint('dm')), env)).status).toBe(409);
});
