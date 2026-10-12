// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { signDmTicket } from '../../../workers/auth/src/dm-ticket';
import { handleChatAccountDeletion } from './account-deletion';
import type { Env } from './index';
it('uses signed identity, tombstones before hinted-room revocation and acknowledges only successful revocation', async () => {
  const calls: string[] = [];
  const tombstone = vi.fn(async () => {
    calls.push('tombstone');
    return { rooms: [], tombstoned: true };
  });
  const acknowledge = vi.fn(async () => {
    calls.push('ack');
  });
  const revoke = vi.fn(async () => {
    calls.push('revoke');
  });
  const tombstoneAccount = vi.fn(async () => {
    calls.push('backup-tombstone');
  });
  const env = {
    DM_TICKET_SECRET: 'test-secret',
    ACCOUNT_REGISTRY: { idFromName: (v: string) => v, get: () => ({ tombstone, acknowledge }) },
    ROOM: { idFromName: (v: string) => v, get: () => ({ revokeGroupAccount: revoke }) },
    ROOM_INDEX: { idFromName: (v: string) => v, get: () => ({ tombstoneAccount }) },
  } as unknown as Env;
  const now = Date.now();
  const token = await signDmTicket(env.DM_TICKET_SECRET, {
    aud: 'chat-account-delete',
    sub: 'alice',
    deletionId: 'alice:1234',
    iat: now,
    exp: now + 60000,
  });
  const request = () =>
    new Request('https://chat.test/api/groups/account-deletion/room', {
      method: 'POST',
      body: JSON.stringify({ token, room: 'legacy-unindexed', accountId: 'mallory' }),
    });
  expect((await handleChatAccountDeletion(request(), env, true)).status).toBe(200);
  expect(calls).toEqual(['tombstone', 'backup-tombstone', 'revoke', 'ack']);
  expect(revoke).toHaveBeenCalledWith('legacy-unindexed', 'alice', 'alice:1234');
  revoke.mockRejectedValueOnce(new Error('outage'));
  expect((await handleChatAccountDeletion(request(), env, true)).status).toBe(503);
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect((await handleChatAccountDeletion(request(), env, true)).status).toBe(200);
  const wrong = await signDmTicket(env.DM_TICKET_SECRET, {
    aud: 'chat',
    sub: 'alice',
    iat: now,
    exp: now + 60000,
  });
  expect(
    (
      await handleChatAccountDeletion(
        new Request('https://chat.test', {
          method: 'POST',
          body: JSON.stringify({ token: wrong }),
        }),
        env,
        false,
      )
    ).status,
  ).toBe(403);
});
