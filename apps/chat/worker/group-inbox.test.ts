// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleGroupInbox, handleGroupRead } from './group-inbox';
import { signDmTicket, verifyDmTicket } from '../../../workers/auth/src/dm-ticket';
it('issues a room/account/version scoped read ticket only after durable membership verification', async () => {
  const secret = 'group-test-secret';
  const now = Date.now();
  const chat = await signDmTicket(secret, {
    aud: 'chat',
    sub: 'alice',
    iat: now,
    exp: now + 60000,
  });
  const summary = vi.fn(async (room: string) =>
    room === 'joined'
      ? {
          room,
          preview: 'real',
          lastSequence: 4,
          readSequence: null,
          unread: null,
          lastMessageAt: 10,
          membershipVersion: 3,
        }
      : null,
  );
  const read = vi.fn(async () => true);
  const env = {
    DM_TICKET_SECRET: secret,
    ROOM: {
      idFromName: (room: string) => room,
      get: () => ({ groupInboxSummary: summary, groupMarkRead: read }),
    },
  } as unknown as Parameters<typeof handleGroupInbox>[1];
  const request = (body: unknown, account = 'alice') =>
    new Request('https://chat.test/api/groups/inbox', {
      method: 'POST',
      headers: { 'X-Account-Id': account },
      body: JSON.stringify(body),
    });
  expect(
    (await handleGroupInbox(request({ ticket: chat, rooms: ['joined'] }, 'bob'), env)).status,
  ).toBe(403);
  expect(summary).not.toHaveBeenCalled();
  const response = await handleGroupInbox(
    request({ ticket: chat, rooms: ['joined', 'bookmarked-only'] }),
    env,
  );
  const data = (await response.json()) as { conversations: Array<{ readTicket: string }> };
  expect(data.conversations).toHaveLength(1);
  expect(summary).toHaveBeenCalledWith('joined', 'alice');
  const scoped = data.conversations[0]!.readTicket;
  expect(await verifyDmTicket(secret, scoped, Date.now())).toMatchObject({
    aud: 'group-read',
    sub: 'alice',
    room: 'joined',
    membershipVersion: 3,
  });
  expect((await handleGroupRead(request({ ticket: chat, sequence: 4 }), env)).status).toBe(403);
  expect((await handleGroupRead(request({ ticket: scoped, sequence: 4 }), env)).status).toBe(200);
  expect(read).toHaveBeenCalledWith('joined', 'alice', 3, 4);
  read.mockResolvedValue(false);
  expect((await handleGroupRead(request({ ticket: scoped, sequence: 4 }), env)).status).toBe(409);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
