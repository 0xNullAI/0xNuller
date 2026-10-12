// @vitest-environment node
import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import worker, { type Env } from './index';
import { signDmTicket } from '../../../workers/auth/src/dm-ticket';
it('overwrites browser-supplied account identity with signed Chat admission identity', async () => {
  const secret = 'group-identity-test';
  const now = Date.now();
  const ticket = await signDmTicket(secret, {
    aud: 'chat',
    sub: 'alice',
    iat: now,
    exp: now + 60000,
  });
  const forwarded = vi.fn(async (request: Request) => {
    expect(request.headers.get('X-Chat-Account')).toBe('alice');
    expect(new URL(request.url).searchParams.has('ticket')).toBe(false);
    return new Response('ok');
  });
  const env = {
    DM_TICKET_SECRET: secret,
    ROOM_INDEX: { idFromName: (id: string) => id, get: () => ({ register: async () => {} }) },
    ACCOUNT_REGISTRY: {
      idFromName: (id: string) => id,
      get: () => ({ registerGroup: async () => ({ allowed: true, deletionId: null }) }),
    },
    ROOM: { idFromName: (id: string) => id, get: () => ({ fetch: forwarded }) },
  } as unknown as Env;
  expect(
    (
      await worker.fetch(
        new Request('https://chat.test/ws/room/group?ticket=' + encodeURIComponent(ticket), {
          headers: { 'X-Chat-Account': 'mallory' },
        }),
        env,
      )
    ).status,
  ).toBe(200);
  expect(forwarded).toHaveBeenCalledOnce();
});
it('fails closed on deleted accounts and registry outages before forwarding a room join', async () => {
  const now = Date.now();
  const ticket = await signDmTicket('secret', {
    aud: 'chat',
    sub: 'alice',
    iat: now,
    exp: now + 60000,
  });
  const forwarded = vi.fn();
  const registerGroup = vi.fn(async () => ({ allowed: false, deletionId: 'alice:123' }));
  const env = {
    DM_TICKET_SECRET: 'secret',
    ACCOUNT_REGISTRY: { idFromName: (id: string) => id, get: () => ({ registerGroup }) },
    ROOM: { idFromName: (id: string) => id, get: () => ({ fetch: forwarded }) },
  } as unknown as Env;
  const request = () =>
    new Request('https://chat.test/ws/room/group?ticket=' + encodeURIComponent(ticket));
  expect((await worker.fetch(request(), env)).status).toBe(403);
  registerGroup.mockRejectedValueOnce(new Error('unavailable'));
  expect((await worker.fetch(request(), env)).status).toBe(503);
  expect(forwarded).not.toHaveBeenCalled();
});
